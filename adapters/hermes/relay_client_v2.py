#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""RelayClientV2 — v2/v3 wire protocol client (docs/PROTOCOL-V2.md).

Self-contained Python standard library mirror of the self-use
``relay/client.py``: canonical-JSON signing, snake_case endpoints. Use it from
Hermes hooks, custom agents, scripts or cron jobs.

Pass ``key_id`` to sign with the v3 keyring scheme (X-Agent-Relay-Key-Id
header) or leave it empty for the v2 legacy scheme — a bilingual broker
accepts both. Pull responses carry ``lease_token``/``lease_until``; pass the
token to :meth:`ack` for the strict single-use guard and call
:meth:`renew_lease` while a long-running turn is in flight.

    from relay_client_v2 import RelayClientV2

    client = RelayClientV2(endpoint="http://127.0.0.1:19121", agent="hermes", secret="<hex>", key_id="legacy")
    message_id = client.send_request(target="codex", body="...", session_ref="hermes",
                                     idempotency_key="hermes:abc")
    for msg in client.pull(limit=5):
        ...
    client.ack(msg["message_id"], outcome="completed", lease_token=msg.get("lease_token", ""))

The canonical body + signature are byte-for-byte identical to the self-use
``relay/protocol.py`` (locked by test/protocol_v2_golden.py).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
import urllib.error
import urllib.request
import uuid
from typing import Any

SIGNATURE_HEADERS = {
    "agent": "X-Agent-Relay-Agent",
    "key_id": "X-Agent-Relay-Key-Id",
    "timestamp": "X-Agent-Relay-Timestamp",
    "signature": "X-Agent-Relay-Signature",
}
DEFAULT_REQUEST_TTL_SECONDS = 7 * 86400  # retention must outlive an offline peer
MAX_WAIT_SECONDS = 120  # broker ceiling for a held long-poll


class RelayError(RuntimeError):
    """A protocol-level error returned by the broker."""


def canonical_body(payload: dict[str, Any]) -> bytes:
    """json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)."""
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def make_signature(agent: str, secret: str, method: str, path: str, timestamp: str, body: bytes, key_id: str = "") -> str:
    """v3 (key_id set): agent\\nkeyId\\nts\\nMETHOD\\npath\\ndigest; v2: without keyId."""
    digest = hashlib.sha256(body).hexdigest()
    fields = (agent, key_id, timestamp, method.upper(), path, digest) if key_id else (agent, timestamp, method.upper(), path, digest)
    signed = "\n".join(fields).encode("utf-8")
    return hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()


class RelayClientV2:
    """HMAC-authenticated v2/v3 client for the relay broker."""

    def __init__(self, endpoint: str, agent: str, secret: str, *, key_id: str = "", timeout: float = 15.0) -> None:
        self.endpoint = endpoint.rstrip("/")
        self.agent = agent.strip().lower()
        self.secret = secret
        self.key_id = key_id.strip()
        self.timeout = timeout

    def _request(self, method: str, path: str, payload: dict[str, Any] | None = None, *, timeout: float | None = None) -> Any:
        has_body = method.upper() not in ("GET", "HEAD")
        body = canonical_body(payload or {}) if has_body else b""
        timestamp = str(int(time.time()))
        headers = {
            "Content-Type": "application/json",
            SIGNATURE_HEADERS["agent"]: self.agent,
            SIGNATURE_HEADERS["timestamp"]: timestamp,
            SIGNATURE_HEADERS["signature"]: make_signature(self.agent, self.secret, method, path, timestamp, body, self.key_id),
        }
        if self.key_id:
            headers[SIGNATURE_HEADERS["key_id"]] = self.key_id
        req = urllib.request.Request(
            self.endpoint + path,
            data=body if has_body else None,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout if timeout is not None else self.timeout) as resp:
                text = resp.read().decode("utf-8")
                return json.loads(text) if text else None
        except urllib.error.HTTPError as exc:
            try:
                parsed = json.loads(exc.read().decode("utf-8"))
            except Exception:
                parsed = None
            message = (parsed or {}).get("error", {}).get("message", f"relay request failed ({exc.code})")
            raise RelayError(str(message)[:500]) from exc

    def health(self) -> dict[str, Any]:
        return self._request("GET", "/healthz", {})

    def send_request_detailed(
        self,
        target: str,
        body: str,
        *,
        session_ref: str,
        idempotency_key: str,
        ttl_seconds: int = DEFAULT_REQUEST_TTL_SECONDS,
        execution_mode: str = "read",
        context: str = "",
        topic: str = "",
        root_id: str = "",
    ) -> dict[str, Any]:
        """Send a request and return the broker's answer, including presence.

        ``target_online`` is False when the peer has not claimed anything
        recently — the caller learns that immediately instead of after the
        message silently expired.
        """
        payload: dict[str, Any] = {
            "origin": self.agent,
            "target": str(target).strip().lower(),
            "kind": "request",
            "body": body,
            "session_ref": session_ref,
            "idempotency_key": idempotency_key,
            "ttl_seconds": ttl_seconds,
            "execution_mode": execution_mode,
        }
        if root_id:
            payload["root_id"] = str(root_id)
        if context:
            payload["context"] = context
        if topic:
            payload["topic"] = topic
        return self._request("POST", "/v1/messages", payload)

    def send_request(
        self,
        target: str,
        body: str,
        *,
        session_ref: str,
        idempotency_key: str,
        ttl_seconds: int = DEFAULT_REQUEST_TTL_SECONDS,
        execution_mode: str = "read",
        context: str = "",
        topic: str = "",
        root_id: str = "",
    ) -> str:
        data = self.send_request_detailed(
            target, body, session_ref=session_ref, idempotency_key=idempotency_key,
            ttl_seconds=ttl_seconds, execution_mode=execution_mode, context=context,
            topic=topic, root_id=root_id,
        )
        return str(data["message_id"])

    def send_reply(self, incoming: dict[str, Any], body: str, idempotency_key: str) -> str:
        now = time.time()
        ttl = max(60, int(float(incoming.get("expires_at") or 0) - now))
        payload = {
            "origin": self.agent,
            "target": incoming["origin"],
            "kind": "reply",
            "body": body,
            "session_ref": incoming.get("session_ref") or "",
            "parent_id": incoming["message_id"],
            "idempotency_key": idempotency_key,
            "ttl_seconds": ttl,
        }
        data = self._request("POST", "/v1/messages", payload)
        return str(data["message_id"])

    def pull(
        self,
        limit: int | None = None,
        lease_seconds: int | None = None,
        *,
        wait_seconds: float = 0,
        match_root_id: str = "",
    ) -> list[dict[str, Any]]:
        """Claim queued messages.

        ``wait_seconds`` makes it a long-poll held open by the broker (no client
        polling loop); ``match_root_id`` restricts the claim to one conversation
        so waiting for a specific answer does not steal the rest of the inbox.
        """
        payload: dict[str, Any] = {"agent": self.agent}
        if limit is not None:
            payload["limit"] = limit
        if lease_seconds is not None:
            payload["lease_seconds"] = lease_seconds
        if match_root_id:
            payload["match_root_id"] = str(match_root_id)
        timeout: float | None = None
        if wait_seconds > 0:
            held = min(float(wait_seconds), float(MAX_WAIT_SECONDS))
            payload["wait_seconds"] = held
            timeout = held + 10.0  # the held request outlives the default socket timeout
        data = self._request("POST", "/v1/pull", payload, timeout=timeout)
        return [m for m in (data.get("messages") or []) if isinstance(m, dict)]

    def ask(
        self,
        target: str,
        body: str,
        *,
        session_ref: str = "",
        idempotency_key: str = "",
        context: str = "",
        execution_mode: str = "read",
        timeout_seconds: float = 240,
        wait_offline: bool = False,
    ) -> dict[str, Any]:
        """Send a request and block until the peer answers or the deadline passes.

        Returns ``{"ok", "message_id", "root_id", "target_online", "reply"|"reason",
        "waited_seconds"}``. This is the primitive that makes a handoff feel like a
        function call rather than a mailbox.
        """
        root_id = uuid.uuid4().hex
        started = time.time()
        sent = self.send_request_detailed(
            target, body, session_ref=session_ref or self.agent,
            idempotency_key=idempotency_key or f"ask:{root_id}",
            execution_mode=execution_mode, context=context, root_id=root_id,
        )
        result = {
            "message_id": str(sent["message_id"]),
            "root_id": str(sent.get("root_id") or root_id),
            "target_online": bool(sent.get("target_online", True)),
            "will_wake": bool(sent.get("will_wake", False)),
        }
        # Nobody is listening *and* nobody can be woken: answer honestly now
        # instead of burning the deadline. The request is retained for days
        # either way, and a woken recipient answers into the same conversation.
        if not result["target_online"] and not result["will_wake"] and not wait_offline:
            return {
                "ok": False, **result,
                "reason": "peer_offline",
                "waited_seconds": 0,
                "hint": sent.get("hint") or f"请求已留存，等 {target} 上线后会自动投递",
            }
        deadline = started + max(1.0, float(timeout_seconds))
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                return {
                    "ok": False, **result,
                    "reason": "peer_offline" if not result["target_online"] else "timeout",
                    "waited_seconds": round(time.time() - started),
                    "hint": sent.get("hint") or "请求已留存，稍后可用 pull 或 status 取回结果",
                }
            held = min(remaining, float(MAX_WAIT_SECONDS))
            messages = self.pull(limit=4, lease_seconds=300, wait_seconds=held, match_root_id=result["root_id"])
            answer = next((m for m in messages if m.get("kind") == "reply"), messages[0] if messages else None)
            if answer:
                try:
                    self.ack(answer["message_id"], "completed", lease_token=answer.get("lease_token") or "")
                except RelayError:
                    pass
                return {
                    "ok": True, **result,
                    "reply": answer.get("body") or "",
                    "reply_message_id": answer.get("message_id"),
                    "waited_seconds": round(time.time() - started),
                }

    def ack(self, message_id: str, outcome: str, error: str = "", lease_token: str = "") -> None:
        """Acknowledge a leased message. With a ``lease_token`` (v3) the ack is
        guarded on the active lease — a stale or replayed token is rejected."""
        payload: dict[str, Any] = {"agent": self.agent, "message_id": message_id, "outcome": outcome}
        if error:
            payload["error"] = error[:300]
        if lease_token:
            payload["lease_token"] = lease_token
        self._request("POST", "/v1/ack", payload)

    def renew_lease(self, message_id: str, lease_token: str, lease_seconds: int | None = None) -> float:
        """Extend the delivery lease of a leased message (v3). Returns the new lease_until."""
        payload: dict[str, Any] = {"agent": self.agent, "message_id": message_id, "lease_token": lease_token}
        if lease_seconds is not None:
            payload["lease_seconds"] = lease_seconds
        data = self._request("POST", "/v1/lease/renew", payload)
        return float(data["lease_until"])

    def status(self, message_ids: list[str]) -> list[dict[str, Any]]:
        data = self._request("POST", "/v1/status", {"agent": self.agent, "message_ids": list(message_ids)})
        return [m for m in (data.get("messages") or []) if isinstance(m, dict)]

    def recent(self, limit: int = 20) -> list[dict[str, Any]]:
        data = self._request("POST", "/v1/recent", {"agent": self.agent, "limit": limit})
        return [m for m in (data.get("messages") or []) if isinstance(m, dict)]

    def query(self, **filters: Any) -> list[dict[str, Any]]:
        data = self._request("POST", "/v1/messages/query", {"agent": self.agent, **filters})
        return [m for m in (data.get("messages") or []) if isinstance(m, dict)]

    def requeue(self, message_id: str) -> dict[str, Any]:
        return self._request("POST", "/v1/admin/requeue", {"agent": self.agent, "message_id": message_id})

    def cancel(self, message_id: str) -> dict[str, Any]:
        return self._request("POST", "/v1/admin/cancel", {"agent": self.agent, "message_id": message_id})

    def admin_status(self, limit: int = 50) -> list[dict[str, Any]]:
        data = self._request("POST", "/v1/admin/status", {"agent": self.agent, "limit": limit})
        return [m for m in (data.get("messages") or []) if isinstance(m, dict)]
