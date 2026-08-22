#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Integration test for RelayClientV2 against a live Node broker.

Usage: python test/test_relay_client_v2.py <broker-url> <secret>
Exits 0 on a full send/pull/ack/reply round-trip, non-zero otherwise.
"""
from __future__ import annotations

import sys

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1] / "adapters" / "hermes"))

from relay_client_v2 import RelayClientV2, RelayError  # noqa: E402


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: test_relay_client_v2.py <broker-url> <secret>", file=sys.stderr)
        return 2
    endpoint, secret = sys.argv[1], sys.argv[2]
    alpha = RelayClientV2(endpoint, "alpha", secret)
    beta = RelayClientV2(endpoint, "beta", secret)

    health = alpha.health()
    assert health.get("protocol_version") == 3, f"unexpected protocol_version: {health}"

    message_id = alpha.send_request(
        target="beta", body="cross-language review request", session_ref="alpha",
        idempotency_key="pyv2-integration:1", ttl_seconds=3600, execution_mode="read",
    )
    messages = beta.pull(limit=5)
    assert any(m["message_id"] == message_id for m in messages), "beta did not receive the request"
    beta.ack(message_id, "completed")
    status = alpha.status([message_id])
    assert status[0]["status"] == "completed", f"unexpected status: {status}"

    # Reply round-trip with topic inheritance.
    mid2 = alpha.send_request(
        target="beta", body="check edge", session_ref="sess-7", idempotency_key="pyv2-integration:2",
        ttl_seconds=3600, execution_mode="read", topic="edge",
    )
    incoming = [m for m in beta.pull(limit=5) if m["message_id"] == mid2][0]
    reply_id = beta.send_reply(incoming, "verified, no edge issue", f"reply:{mid2}")
    inbox = alpha.pull(limit=5)
    reply = [m for m in inbox if m["message_id"] == reply_id]
    assert reply and reply[0]["topic"] == "edge", "reply not delivered or topic not inherited"

    # v3 scheme: key-id signing + lease credentials + renewal against the
    # bilingual broker (mirrors the self-use Python clients).
    v3 = RelayClientV2(endpoint, "beta", secret, key_id="legacy")
    mid3 = alpha.send_request(
        target="beta", body="v3 lease probe", session_ref="alpha",
        idempotency_key="pyv2-integration:3", ttl_seconds=3600, execution_mode="read",
    )
    leased = [m for m in v3.pull(limit=5) if m["message_id"] == mid3][0]
    assert leased.get("lease_token"), "v3 pull must return a lease_token"
    lease_until = v3.renew_lease(mid3, leased["lease_token"], lease_seconds=300)
    assert lease_until > 0, "renew_lease must return the new lease_until"
    try:
        v3.ack(mid3, "completed", lease_token="forged")
        raise AssertionError("forged lease token must be rejected")
    except RelayError:
        pass
    v3.ack(mid3, "completed", lease_token=leased["lease_token"])
    assert alpha.status([mid3])[0]["status"] == "completed"

    print("ok: RelayClientV2 cross-language round-trip passed (v2 + v3)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
