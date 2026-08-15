# dsh-agent-relay

> Multi-agent collaboration relay for DeepSeek Harness — let your local agents
> (dsh, Codex, Claude, Hermes, OpenClaw, …) send and receive messages through a
> tiny, HMAC-authenticated broker. Loopback-first, zero-dependency, 5 minutes
> to a working round trip. · 多 Agent 协作中继：本地各 Agent 经轻量 broker 安全互发消息。

[![npm version](https://img.shields.io/npm/v/dsh-agent-relay)](https://www.npmjs.com/package/dsh-agent-relay)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/Noelune/dsh-agent-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/Noelune/dsh-agent-relay/actions/workflows/ci.yml)

## Why this exists

Agent frameworks give every agent a *voice* but no *intercom*. When dsh,
Codex, Claude and Hermes share one machine they cannot ask each other for a
code review, a fact check or a second opinion — unless you wire something up
yourself. **dsh-agent-relay is that wire**: a complete, self-contained starter
kit (broker + dsh plugin + CLI client + Python client + setup scripts) that
anyone can deploy in minutes.

Unlike orchestration engines (which *drive* agents) and memory engines (which
*store* facts), a relay only **moves messages** — and it stays out of your
agents' way.

| What it is not | Why |
|---|---|
| Not an orchestration/automation engine | No workflows, no DAGs, no scheduling — just delivery. Pair it with your favorite orchestrator. |
| Not a memory system | Messages live only in a TTL-limited delivery queue (default 7 days, JSONL for restart durability) — never a durable knowledge store. See [unified-agent-memory](https://github.com/Noelune/unified-agent-memory) for shared memory. |
| Not a chat server | No rooms, no presence beyond online/offline heartbeats. |

## Features

- **Wire protocol first** — one versioned protocol ([docs/PROTOCOL.md](docs/PROTOCOL.md)) implemented identically by every adapter (JS plugin, JS CLI, Python client).
- **Loopback-first, zero-config default** — broker binds 127.0.0.1:19121; no server, no TLS, no cloud needed for the single-machine mode.
- **HMAC-SHA256 auth** with timestamp anti-replay, per-agent lockout (5 failures → 5 min) and per-IP rate limiting.
- **Reliable delivery** — incremental polling with cursors, 7-day TTL, JSONL persistence across restarts, idempotent retries (2/4/8 s backoff, stable message ids, receiver-side dedup).
- **Lease-based delivery (v1.1)** — `pull`/`ack` with a delivery state machine (`queued → leased → done/failed`, lease expiry re-queues, attempts capped); request/reply correlation (`kind`/`rootId`/`parentId`), batch status, recent and read-only query endpoints; per-agent routing ACL (optional, off by default).
- **dsh first-class** — a cordis plugin registering relay_send / relay_recv / relay_peers / relay_history model tools, plus an optional sidebar status panel.
- **Privacy by design** — message content is never written to application logs; the broker keeps it only in the TTL-limited queue (default 7 days) for delivery, and the dsh plugin keeps only an in-memory id-level history.
- **Distributed mode (advanced, optional)** — one broker, many machines; documented with mandatory TLS.

## Quick start (5 steps, single machine)

    git clone https://github.com/Noelune/dsh-agent-relay.git && cd dsh-agent-relay
    node setup/setup.js init
    node setup/setup.js start
    # in another terminal, connect two agents:
    export DSH_RELAY_SECRET=<secret printed in broker/config.yaml>
    node adapters/cli/relay.mjs register --agent alpha --secret $DSH_RELAY_SECRET
    node adapters/cli/relay.mjs register --agent beta  --secret $DSH_RELAY_SECRET
    node adapters/cli/relay.mjs send beta "hello from alpha" --agent alpha --secret $DSH_RELAY_SECRET
    node adapters/cli/relay.mjs recv --agent beta --secret $DSH_RELAY_SECRET

For the dsh plugin instead of the CLI:

    dsh plugin --profile web add dsh-agent-relay
    export DSH_RELAY_AGENT=dsh-agent DSH_RELAY_SECRET=<secret>
    # restart the web profile; the model now has relay_send / relay_recv / relay_peers

Full guide: [docs/DEPLOY.md](docs/DEPLOY.md) · Protocol: [docs/PROTOCOL.md](docs/PROTOCOL.md) · Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Security: [docs/SECURITY.md](docs/SECURITY.md)

## Deploy with DSH (agent-driven)

Prefer to let an agent deploy it? Install the plugin, then have DSH read
[docs/AGENT-DEPLOY.md](docs/AGENT-DEPLOY.md) and follow it end-to-end: it
generates the broker secret, starts the broker, wires the dsh plugin (plus
CLI / Python clients), runs `selfcheck`, and reports what it did.

The npm package ships the broker + setup + adapters, so a single-machine
deployment needs **no git clone**. If a broker is already running, the plugin
only needs `DSH_RELAY_SECRET` (and a stable `DSH_RELAY_AGENT`).

## Architecture at a glance

    dsh (plugin) ─┐
    CLI (relay.mjs) ─┤   HMAC-HTTP     relay broker
    Python (relay_client.py) ─┼──────────▶  127.0.0.1:19121
    Hermes-style agent ─┘                 auth · route · queue

## Repository layout

| Path | What |
|---|---|
| broker/ | The relay service (zero-dependency Node; config, HMAC auth, JSONL store, HTTP server) + Dockerfile |
| lib/ | dsh plugin: model tools + relay client library (also used by the CLI) |
| adapters/cli/ | Zero-dependency Node CLI client |
| adapters/hermes/ | Pure-stdlib Python client + Hermes-style integration example |
| adapters/openclaw/ | OpenClaw integration notes |
| setup/ | setup.js (init/start/selfcheck), selfcheck.js, optional docker-compose demo |
| docs/ | PROTOCOL (normative), ARCHITECTURE, DEPLOY, SECURITY |

## Requirements

- Node.js ≥ 20 (broker, CLI, dsh plugin)
- Python ≥ 3.10 (only for the Python client — optional)
- dsh 0.1.0-rc.6 (tested) for the dsh plugin

## Maintenance status

- Maintainer: [Noelune](https://github.com/Noelune)
- **Community-maintained** — issues and PRs are welcome; no SLA is promised.
  Bug fixes usually land within 1–2 weeks; security issues get priority.
- Compatibility: tested against **dsh 0.1.0-rc.6**. dsh itself is a release
  candidate; API changes are tracked with upgrade notes in [CHANGELOG.md](CHANGELOG.md).
- License: **MIT** — commercial use is allowed.

## Security

See [docs/SECURITY.md](docs/SECURITY.md). Short version: HMAC authenticates,
TLS encrypts; use the loopback mode by default; **never expose a plaintext
broker to a network**. Treat every received relay message as untrusted data,
not instructions.

## Contributing

PRs welcome. Please run npm test (node --test) before submitting; CI runs
tests, a secrets scan (gitleaks) and a license check on every push.
