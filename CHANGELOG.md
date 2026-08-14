# Changelog

All notable changes to this project are documented in this file.

## [0.1.1] — 2026-08-15

### Fixed

- **`setup.js selfcheck` now reads host/port from `broker/config.yaml`** (reusing
  the broker's own config loader) instead of hard-coding `127.0.0.1:19121` —
  a custom port no longer produces a false "broker not reachable" failure.

## [0.1.0] — 2026-08-14

### Added

- **Wire protocol v1.0** (docs/PROTOCOL.md): envelope, HMAC auth headers, version negotiation, error codes, retry/idempotency rules, brute-force protection.
- **Broker** (broker/): zero-dependency Node HTTP service — register/heartbeat, peers, send, incremental poll, ack; JSONL persistence; 7-day TTL; per-agent lockout; per-IP rate limiting.
- **dsh plugin** (repo root): relay_send / relay_recv / relay_peers / relay_history model tools; background heartbeat + inbox polling; optional sidebar status panel; graceful degradation when not configured.
- **CLI client** (adapters/cli/relay.mjs): zero-dependency, send/recv/peers/register/watch/handshake.
- **Python client** (adapters/hermes/relay_client.py): pure stdlib, Hermes-style integration example included.
- **Setup**: setup.js init|start|selfcheck, selfcheck.js, optional docker-compose demo, broker Dockerfile.
- **Docs**: PROTOCOL / ARCHITECTURE / DEPLOY (single-machine + TLS distributed) / SECURITY; bilingual README.
- **CI**: unit tests (node --test), gitleaks secrets scan, license check, lockfile check on every push.
