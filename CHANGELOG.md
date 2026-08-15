# Changelog

All notable changes to this project are documented in this file.

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
  lives only in the broker's TTL-limited queue (default 7 days, JSONL) and is
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
