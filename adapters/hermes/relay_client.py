#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-agent-relay — Python protocol client (wire protocol v1.0).

Pure standard library: works on any Python 3.10+ without installing anything.
Use it from Hermes hooks, custom agents, scripts or cron jobs:

    from relay_client import RelayClient

    client = RelayClient(broker_url="http://127.0.0.1:19121", agent="my-agent", secret="<hex>")
    client.handshake()          # verify protocol version
    client.register()           # heartbeat
    client.send("peer-agent", {"text": "hello"})
    client.recv()               # {"messages": [...], "cursor": ...}
    client.peers()

Retry semantics follow docs/PROTOCOL.md §5: 2/4/8 s backoff, stable message id,
duplicate responses treated as success.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid
import urllib.error
import urllib.request
from typing import Any

PROTOCOL_VERSION = "1.0"
RETRY_DELAYS_SECONDS = (2, 4, 8)
MAX_TIMESTAMP_SKEW_SECONDS = 300


class RelayError(RuntimeError):
    """A protocol-level error returned by the broker."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(f"relay {code} ({status}): {message}")
        self.status = status
        self.code = code


class RelayClient:
    """HMAC-authenticated client for the dsh-agent-relay broker."""

    def __init__(self, broker_url: str, agent: str, secret: str, timeout: float = 10.0) -> None:
        self.broker_url = broker_url.rstrip("/")
        self.agent = agent
        self.secret = secret
        self.timeout = timeout
        self.since: str | None = None

    # -- internals ------------------------------------------------------

    def _sign(self, method: str, path: str, timestamp: int, raw_body: str) -> str:
        payload = f"{method}\n{path}\n{timestamp}\n{raw_body}".encode("utf-8")
        return hmac.new(self.secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()

    def _headers(self, method: str, path: str, raw_body: str) -> dict[str, str]:
        ts = int(time.time())
        return {
            "X-Relay-Agent": self.agent,
            "X-Relay-Timestamp": str(ts),
            "X-Relay-Signature": self._sign(method, path, ts, raw_body),
            "Content-Type": "application/json",
        }

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None, retries: int = 0) -> Any:
        raw_body = "" if body is None else json.dumps(body, ensure_ascii=False)
        req = urllib.request.Request(
            self.broker_url + path,
            data=raw_body.encode("utf-8") if raw_body else None,
            headers=self._headers(method, path, raw_body),
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
            code = (parsed or {}).get("error", {}).get("code", "unknown")
            message = (parsed or {}).get("error", {}).get("message", str(exc))
            if (exc.code >= 500 or exc.code in (408, 429)) and retries < len(RETRY_DELAYS_SECONDS):
                time.sleep(RETRY_DELAYS_SECONDS[retries])
                return self._request(method, path, body, retries + 1)
            if exc.code == 409 or code == "duplicate":
                return {"accepted": True, "id": (body or {}).get("id"), "duplicate": True}
            raise RelayError(exc.code, code, message) from exc
        except urllib.error.URLError as exc:
            if retries < len(RETRY_DELAYS_SECONDS):
                time.sleep(RETRY_DELAYS_SECONDS[retries])
                return self._request(method, path, body, retries + 1)
            raise RelayError(0, "connection_error", str(exc.reason)) from exc

    # -- protocol operations --------------------------------------------

    def handshake(self) -> dict[str, Any]:
        """Verify broker protocol compatibility; raises on mismatch."""
        info = self._request("GET", "/")
        if not info or info.get("protocol") != PROTOCOL_VERSION:
            raise RuntimeError(
                f"broker protocol mismatch: expected {PROTOCOL_VERSION}, "
                f"got {info.get('protocol') if info else 'unknown'}"
            )
        return info

    def register(self) -> dict[str, Any]:
        return self._request("POST", "/register", {"agent": self.agent})

    def send(
        self,
        to: str,
        body: dict[str, Any],
        *,
        reply_to: str | None = None,
        ack: bool = False,
        message_id: str | None = None,
        kind: str | None = None,
        root_id: str | None = None,
        parent_id: str | None = None,
    ) -> dict[str, Any]:
        """Send a message; the id stays stable across internal retries."""
        payload = {
            "id": message_id or str(uuid.uuid4()),
            "to": to,
            "body": body,
            "type": "message",
            "replyTo": reply_to,
            "ack": ack,
        }
        if kind:
            payload["kind"] = kind
        if root_id:
            payload["rootId"] = root_id
        if parent_id:
            payload["parentId"] = parent_id
        return self._request("POST", "/messages", payload)

    def recv(self, limit: int = 50) -> dict[str, Any]:
        from urllib.parse import quote
        path = f"/messages?since={quote(self.since or '', safe='')}&limit={quote(str(limit), safe='')}"
        result = self._request("GET", path)
        if result and isinstance(result.get("messages"), list) and result["messages"]:
            self.since = result.get("cursor") or self.since
        return result or {"messages": [], "cursor": None}

    def peers(self) -> list[dict[str, Any]]:
        result = self._request("GET", "/peers")
        return result.get("peers", []) if result else []

    def ack(self, message_id: str, status: str = "ok", error: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"status": status}
        if error:
            body["error"] = error
        return self._request("POST", f"/messages/{message_id}/ack", body)

    # -- v1.1 lease-based delivery --------------------------------------

    def pull(self, limit: int = 50, lease_seconds: int | None = None) -> dict[str, Any]:
        """Lease up to `limit` queued messages for this agent (v1.1)."""
        body: dict[str, Any] = {"limit": limit}
        if lease_seconds:
            body["leaseSeconds"] = lease_seconds
        result = self._request("POST", "/v1/pull", body)
        return result or {"messages": [], "count": 0}

    def ack_outcome(self, message_id: str, lease_id: str, outcome: str, error: str | None = None) -> dict[str, Any]:
        """Acknowledge a leased message: outcome 'completed' or 'retry' (v1.1)."""
        body: dict[str, Any] = {"messageId": message_id, "leaseId": lease_id, "outcome": outcome}
        if error:
            body["error"] = error
        return self._request("POST", "/v1/ack", body)

    def status(self, message_ids: list[str]) -> list[dict[str, Any]]:
        """Batch status lookup (v1.1)."""
        result = self._request("POST", "/v1/status", {"messageIds": list(message_ids)})
        return result.get("messages", []) if result else []

    def recent(self, limit: int = 50) -> list[dict[str, Any]]:
        """Recent messages addressed to this agent (read-only, v1.1)."""
        result = self._request("POST", "/v1/recent", {"limit": limit})
        return result.get("messages", []) if result else []

    def query(self, **filters: Any) -> list[dict[str, Any]]:
        """Read-only filtered search (v1.1): kind/status/from/to/limit."""
        result = self._request("POST", "/v1/messages/query", filters)
        return result.get("messages", []) if result else []


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="dsh-agent-relay CLI (Python client)")
    parser.add_argument("command", choices=["handshake", "register", "send", "recv", "peers"])
    parser.add_argument("--broker", default="http://127.0.0.1:19121")
    parser.add_argument("--agent", required=True)
    parser.add_argument("--secret", required=True)
    parser.add_argument("--to", help="recipient for send")
    parser.add_argument("--body", help='JSON body for send, e.g. {"text": "hi"}')
    parser.add_argument("--limit", type=int, default=50)
    args = parser.parse_args()

    client = RelayClient(broker_url=args.broker, agent=args.agent, secret=args.secret)
    if args.command == "handshake":
        print(json.dumps(client.handshake(), ensure_ascii=False))
    elif args.command == "register":
        print(json.dumps(client.register(), ensure_ascii=False))
    elif args.command == "send":
        body = json.loads(args.body) if args.body else {"text": "hello"}
        print(json.dumps(client.send(args.to, body), ensure_ascii=False))
    elif args.command == "recv":
        print(json.dumps(client.recv(args.limit), ensure_ascii=False, indent=2))
    elif args.command == "peers":
        print(json.dumps({"peers": client.peers()}, ensure_ascii=False, indent=2))
