# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Changed — the store has one truth now

`broker/src/store-v2.js` kept an in-memory `Map` as its working copy and mirrored
every transition into `relay_v2_messages`. That is two answers to "what is the
state of this message", and they disagree after any crash between a Map write and
its mirror write — the classic shape of a "the queue says leased but the file says
queued" bug. SQLite now holds the state, and the process holds none of it:

- Claims are one atomic statement (`UPDATE … WHERE message_id = (SELECT … LIMIT 1)
  RETURNING *`), so a pull cannot observe a half-updated row.
- Housekeeping is four set-based statements instead of a loop over every message.
- `statusFor` / `recentFor` / `queryMessages` / `stuckFor` / `queueStats` /
  `getFailedToNotify` read the table, so an admin view and a poller can no longer
  disagree.
- `persist: false` selects `:memory:` rather than a second code path: tests now run
  the same SQL as production. Only presence (`lastPullAt`) and the counters stay in
  memory, and they are metrics, not message state.
- The claim index became `(target, status, created_at)`. The old
  `(target, status, expires_at, created_at)` put a range test ahead of `created_at`,
  so every claim re-sorted all ready rows; the new shape walks the index in delivery
  order. Old databases drop `idx_v2_ready` on first open.
- A pull commits once instead of once per statement (measured on a 3,000-row queue
  pulling 8 messages: **16 ms → 3 ms**; at a realistic 300 rows: **2.2 ms → 0.4 ms**).
  `synchronous` deliberately stays at SQLite's FULL default — the win came from
  batching, and a durable queue should not buy speed by dropping fsyncs.

New `test/store-v2-sqlite.test.mjs` (5 tests) pins the invariant with a *second*
database connection: state an outside writer puts in the table is exactly what the
store reports, which cannot be asserted while a `Map` sits in the middle.
Suite: 139 → 144 passing.

## [0.7.0] — 2026-09-19

### Removed — the v1 generation and every duplicated code path

Evidence from the 2026-09-19 audit: the v1 queue table had held no message since
2026-08-15, no live client ever called `/register`, and the v1 peer list feeding
`/healthz` was permanently empty. Two maintained generations served nobody.

- `broker/src/store.js` and the ~212 lines of inline v1 routes in `server.js`
  (`/register`, `/peers`, `POST|GET /messages`, `/messages/:id/ack`, v1
  pull/ack/status/recent/query). Requests without v2/v3 headers now get `400`
  with a pointer to PROTOCOL-V2.md.
- `broker/src/auth.js`: its rate limiting and lockout never applied to v2
  traffic, so it was weight rather than defence.
- `lib/client.js`, `lib/sign.js`, `adapters/hermes/relay_client.py`, the
  untracked example Hermes plugin, `docs/PROTOCOL.md` and the five test files
  that only covered them.
- The JSONL persistence fallback and `persistAll()` whole-table rewrites — one
  engine, one row per write. `node:sqlite` is required (`engines.node >= 22.13`);
  `broker.storage` accepts only `sqlite`.
- `clampLimit` (unused export). `adapters/hermes/deployed-adapter.py`: the
  1,476-line copy is replaced by a hash baseline
  (`adapters/hermes/deployed-adapter.json` + `setup/capture-adapter.mjs`), which
  is what `relay doctor` actually needs.

### Changed
- `adapters/cli/relay.mjs` is one command set (`v2` prefix still accepted):
  `ask` / `send` / `pull --wait` / `ack` / `status` / `recent` / `query` /
  `requeue` / `cancel` / `health` / `doctor`, credentials resolved through
  `--secret-env-file` or a vault entry, and exit code 3 when a peer is
  unreachable — scripts can branch on reachability without parsing JSON.
- `setup/selfcheck.js` exercises the v2 path (send + held claim + ack) instead of
  v1 register/recv.

**BREAKING CHANGE**: the v1 wire protocol no longer exists.

Tests: 138 (was 136 before the 0.6.0 work; 177 at its peak during the
transition, then the v1-only suites were removed with the code they covered).

## [0.6.0] — 2026-09-19

### Added — the circle works when nobody is polling

Motivated by a measured audit: 27 stored messages, 11 completed / 15 expired / 1
failed (41% delivery), every expiry with `attempts=0`; 132,846 pulls against those
27 messages; and only 2 of 6 members had claimed anything since the last restart.

- **Presence on send.** `POST /v1/messages` now returns `target_online`,
  `last_seen_at` and `root_id`, plus a `hint` when nobody is listening. A caller
  learns immediately instead of an hour later.
- **Retention, not expiry.** Default request TTL 1 h → 7 days (`ttl_seconds`
  still overrides, clamped to 30 days). An offline peer no longer implies a lost
  request.
- **Long-poll wake-up.** `POST /v1/pull` accepts `wait_seconds` (broker holds the
  request and answers the moment a message lands) and `match_root_id` (claim one
  conversation without stealing the caller's own inbox).
- **On-demand delivery.** `agents.<name>.wake_command` makes the broker start a
  worker when a message lands for an agent nobody is polling, passing credentials
  through the child environment instead of the command line.
- **`relay_ask()`** on both clients (JS + Python): send and block for the answer,
  short-circuiting to `peer_offline` rather than burning the deadline.
- **MCP server** `mcp/relay-mcp.mjs` — five tools (`relay_ask`, `relay_send`,
  `relay_inbox`, `relay_status`, `relay_agents`). Joining a host is three config
  lines, with no resident poller and no per-host adapter.
- **`relay doctor`** (`setup/doctor.mjs`, also `relay.mjs doctor`): one read-only
  pass over broker liveness, who can actually receive, backlog, credential drift
  between the broker YAML and the bot `.env`, plaintext secrets, WAL growth and
  deployed-adapter drift.
- **Failure notices decoupled from delivery**: `notifyFailedSenders` runs from a 60 s server-side
  sweep (it used to fire only inside pull/ack, so a dead recipient also swallowed
  its own error report) and the notice lives at least 7 days.

### Fixed
- `extractReplyText` survived DSH core 0.1.5-rc.2 removing `session.events`
  (it now prefers `snapshotEvents(fromSeq)`), plus a guard against a
  non-array/throwing accessor, both locked by contract tests.
- Shutdown releases held long-polls instead of hanging until their deadline.

### Changed
- `/healthz` gained `presence` and `long_poll`.
- Collaboration sessions are titled with the unified v2 convention
  (`协作 │ <来源> │ <主题>`).
- Tests: 136 → 154.

## [0.5.0] — 2026-08-22

### Added — v3 protocol compatibility (bilingual broker)

The broker now speaks the self-use Python relay's v3 protocol alongside v2,
closing the divergence that left v3 clients (the Hermes adapter and the Python
relay agents) locked out of a v2-only broker:

- **Bilingual signatures**: `X-Agent-Relay-Key-Id` present → v3 scheme
  (`agent\nkeyId\nts\nMETHOD\npath\ndigest`); absent → v2 scheme. Per-agent
  keyrings (`agents.<name>.keys`, with `not_after` expiry) support key
  rotation; the implicit `legacy` key is the agent's single secret. Unknown or
  expired key ids are rejected with `401 unknown_key`. `/healthz` reports
  `protocol_version: 3` and `signature_schemes: ["v2", "v3"]`.
- **Lease credentials (v3)**: `pull` responses include `lease_token` /
  `lease_until`; `POST /v1/ack` with a token is guarded on the active lease
  (`409 lease_mismatch` on mismatch/replay); new `POST /v1/lease/renew`
  extends an active lease. Acks without a token keep v2 semantics.
- **`allow_shared_write`** round-trips on requests (and is stripped from
  replies), matching the self-use workspace-leasing semantics.
- **Admin authz mirrors the self-use broker**: `security.admin_agents` may act
  on anything; everyone else only on their own side (recipient requeues an
  unfinished request, originator cancels their request). Admin operations are
  audit-logged (ids only). `queues` in `/healthz` gains `oldest_queued_at`.
- **SQLite schema migration**: pre-v3 databases gain the `lease_token` /
  `allow_shared_write` columns in place on startup.

### Added — v3-aware clients and lease renewal

- **JS client (`lib/client-v2.js`)**: optional `keyId` opts the client into v3
  signing; `ack()` accepts a `leaseToken` for the strict single-use guard; new
  `renewLease()` extends an active delivery lease.
- **Standalone relay agent (`adapters/relay-agent.mjs`)**: renews the broker
  delivery lease every 4 minutes while a backend CLI run is in flight, so a
  turn longer than the lease window is no longer re-queued and re-delivered
  mid-flight; acks with the lease token when the broker provides one.
- **Published Python client (`adapters/hermes/relay_client_v2.py`)**: `key_id=`
  constructor option (v3 scheme), `ack(..., lease_token=)` and a
  `renew_lease()` method — byte-compatible with the self-use `relay/client.py`.
- **v3 golden vectors** locked in `test/protocol_v2_golden.py` and
  `test/protocol-v2.test.mjs` (generated by the self-use reference
  implementation), plus a v3 leg in the cross-language client round-trip test.
- **CI runs on Windows too** — the primary deployment platform.

### Fixed — broker correctness and resource use

- **v2 store `dataDir` resolves against the broker directory** — a relative
  `dataDir` (the `./data` default) no longer depends on the process CWD, so
  the v2 SQLite/JSONL files always land beside the v1 store. The broker
  entrypoint now creates the v2 store itself and closes it on shutdown
  (previously only the v1 store was closed); `close()` also runs
  `PRAGMA wal_checkpoint(TRUNCATE)`.
- **Lifecycle transitions persist as single-row UPDATEs** instead of rewriting
  the whole table on every ack/pull/requeue/cancel. Full-table rewrites caused
  heavy WAL growth (a multi-MB WAL against a 128 KB database was observed in
  production). The JSONL fallback keeps its rewrite semantics.
- **The idempotency index is pruned together with retention purges** — it
  previously grew without bound for the lifetime of the process.
- **v2 `POST /v1/ack` requires the message to be leased** (`400` otherwise) —
  a late or duplicated ack can no longer resurrect a terminal message back to
  `queued` (e.g. a retry ack arriving after a redelivery was acked mid-flight).

### Changed — admin endpoints and plugin configuration

- **`/v1/admin/requeue` and `/v1/admin/cancel` are restricted to the
  originator or the recipient** of the message (`403` otherwise), matching the
  visibility rules of `/v1/status` and the per-mode ACL.
- **dsh plugin: the credential-vault fallback for `secretRef` is configured,
  not built in.** Resolving a secret through a Python module exposing
  `reveal_entry(name)` requires the new `vaultModule` setting
  (`DSH_RELAY_VAULT_MODULE` env / `vault_module` in `~/.dsh/agent-relay.json`);
  no installation layout is hard-coded anymore.
- **dsh plugin: the system-prompt guidance and the `agent_relay_send`
  description derive the roster and broker endpoint from configuration**
  (`circleMembers` / `DSH_RELAY_CIRCLE_MEMBERS` / `circle_members`), falling
  back to pointing at `agent_relay_peers` instead of a hard-coded member list.
- **dsh plugin: the default relay-session cwd falls back to the user's home
  directory** instead of a Windows-specific `C:/` path.

## [0.4.0] — 2026-08-15

### Added — v2 wire protocol (self-use compatible) + advanced dsh plugin

- **v2 wire protocol** (`docs/PROTOCOL-V2.md`): canonical-JSON signing
  (`sort_keys` + compact + raw UTF-8), `X-Agent-Relay-*` headers, snake_case
  envelope (`message_id/origin/target/kind/body/session_ref/created_at/expires_at/execution_mode/context/topic`).
  Byte-for-byte compatible with the self-use Python `relay/protocol.py` (golden
  vectors locked in `test/protocol-v2.test.mjs` + `test/protocol_v2_golden.py`).
- **v2 broker endpoints**: `/healthz`, `/v1/messages`, `/v1/pull`, `/v1/ack`,
  `/v1/status`, `/v1/recent`, `/v1/messages/query`, `/v1/admin/requeue|cancel|status`.
- **v2 state machine** in the transitional `store-v2.js`: queued → leased →
  completed/failed/expired, `(origin, idempotency_key)` idempotency, TTL +
  30-day retention, SQLite (node:sqlite) with JSONL fallback.
- **per-mode ACL** (`allowed_read/continue/write_targets`; write closed by
  default) and **undelivered notices** (`notify_failed_to_sender`).
- **v2 clients**: `lib/client-v2.js` (RelayClientV2), `adapters/hermes/relay_client_v2.py`
  (pure stdlib), CLI `v2 <subcommand>`.
- **dsh plugin upgrade** (`lib/index.js`): adaptive-backoff inbox polling,
  per-root relay sessions (`agent-relay-<root_id>`) with archive + idle recycle,
  5 tools (`agent_relay_send/status/history/peers/retry`), execution-mode
  permission presets, per-agent receipts/routes persistence, systemPrompt
  guidance. Replaces the v1 relay_send/recv/peers/history tools.
- **v1 compatibility preserved** — every existing v1 endpoint/client/test still
  works (the v1 protocol is a separate path, documented in `docs/PROTOCOL.md`).

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
