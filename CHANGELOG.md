# Changelog

All notable changes to this project are documented in this file.

## [0.3.0] — 2026-08-15

### Added — v1.1 reliable delivery (backward compatible, protocol stays 1.0)

- **Lease-based delivery state machine**: `POST /v1/pull` leases queued messages
  (`queued → leased`), `POST /v1/ack` finalizes (`completed → done`) or re-queues
  (`retry`, attempts+1, over `maxAttempts` → `failed`); expired leases are
  re-queued by a sweep. Config: `broker.leaseSeconds` (600), `broker.maxAttempts` (3).
- **Request/reply correlation**: optional envelope fields `kind`
  (`message|request|reply`), `rootId`, `parentId`; broker-visible `status`,
  `attempts`, `leaseUntil`.
- **History/status endpoints**: `POST /v1/status` (batch lookup),
  `POST /v1/recent`, `POST /v1/messages/query` (read-only filtered search).
- **Routing ACL**: optional `agents.<name>.allowed_targets` whitelist in
  `broker/config.yaml`; disallowed sends return `403 forbidden`; absent entry =
  allow all (v1.0 default).
- **Client support**: JS `RelayClient` (`pull`/`ackOutcome`/`status`/`recent`/`query`
  + `kind`/`rootId`/`parentId` on `send`), CLI subcommands
  (`pull`/`ack`/`status`/`recent`/`query`), Python client equivalents.
- **Plugin receipts**: the dsh plugin polls via lease-pull and persists completed
  replies to `~/.dsh-agent-relay-receipts.json` (TTL 1 day, atomic write); a
  redelivered request whose id is in the receipts is replayed (idempotent) and
  acked `completed` — never re-run after a restart. `relay_send` accepts `replyTo`.
- **Docs**: PROTOCOL v1.1 extension, DEPLOY v1.1 config, SECURITY ACL, README/zh,
  AGENT-DEPLOY checklist.

### Fixed

- SQLite is now the default persistent backend, creates a missing data directory on first start,
  and falls back to JSONL on Node runtimes where `node:sqlite` cannot be loaded (Node < 22.5, and
  22.5–22.12 which gate it behind `--experimental-sqlite`). `GET /` reports the active backend and
  optional capabilities without changing protocol 1.0 compatibility.
- The Python adapter now sends legacy acknowledgements with the correct HTTP method and retries
  `408`/`429` responses consistently with the JavaScript client.
- Configuration parsing now supports the documented nested agent ACL structure and rejects invalid
  safety, delivery, rate-limit, and lockout values at startup. The removed `broker.tls` label now
  fails loudly at startup (terminate TLS at a trusted reverse proxy) instead of being silently
  ignored — config templates no longer emit it.

### Tests

- `test/lease.test.mjs` (state machine, lease expiry, attempts, status/recent/query)
  and `test/acl.test.mjs` (whitelist allow/deny + v1.1 pull/ack round trip).
  29/29 green.

## [0.2.0] — 2026-08-15

### Added

- **Agent-driven deployment**: new `docs/AGENT-DEPLOY.md` deploy task book for
  DSH — the npm package now ships the broker + setup + adapters, so a
  single-machine deployment needs no git clone; DSH follows the task book to
  generate the secret, start the broker, wire the plugin/CLI/Python clients
  and verify the round trip.
- **npm package is self-contained**: `files` now includes `broker/`, `setup/`,
  `adapters/`, `docs/` and `README.zh.md`; a new `.npmignore` keeps secrets,
  runtime data and `test/` out of the tarball.

### Fixed

- **Broker version no longer hard-coded**: `broker/src/server.js` reads its own
  manifest (`broker/package.json`) so `/` and `selfcheck` always report the
  real version (was stuck at 0.1.0), and the path works in both the repo and
  the Docker image layout.
- **Plugin protocol handshake**: the dsh plugin now performs the PROTOCOL §4
  version negotiation on first poll (matching the Python client), surfacing an
  incompatible-broker error instead of proceeding silently.
- **Plugin not-configured guidance**: points to `docs/AGENT-DEPLOY.md` and is
  npm-aware (no longer assumes a git checkout with `setup/setup.js`).
- **CLI**: `peers`/`handshake` no longer require `--agent` (docs already
  assumed it); removed a duplicated ack loop.
- **Docs accuracy**: privacy claims now correctly state that message content
  lives only in the broker's TTL-limited queue (default 7 days) and is
  never written to application logs — aligning README/README.zh and the
  `AGENT-DEPLOY.md` checklist with the actual persistence behavior.

### CI

- Unit tests now run on **macOS as well as Linux** (matrix).

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
