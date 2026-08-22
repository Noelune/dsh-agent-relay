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
from typing import Any

SIGNATURE_HEADERS = {
    "agent": "X-Agent-Relay-Agent",
    "key_id": "X-Agent-Relay-Key-Id",
    "timestamp": "X-Agent-Relay-Timestamp",
    "signature": "X-Agent-Relay-Signature",
}
DEFAULT_REQUEST_TTL_SECONDS = 3600


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

    def _request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
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
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
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
    ) -> str:
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
        if context:
            payload["context"] = context
        if topic:
            payload["topic"] = topic
        data = self._request("POST", "/v1/messages", payload)
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

    def pull(self, limit: int | None = None, lease_seconds: int | None = None) -> list[dict[str, Any]]:
        payload: dict[str, Any] = {"agent": self.agent}
        if limit is not None:
            payload["limit"] = limit
        if lease_seconds is not None:
            payload["lease_seconds"] = lease_seconds
        data = self._request("POST", "/v1/pull", payload)
        return [m for m in (data.get("messages") or []) if isinstance(m, dict)]

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
