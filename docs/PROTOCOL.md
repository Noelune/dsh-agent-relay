# dsh-agent-relay Wire Protocol v1.0

> **Normative reference.** Every adapter (dsh plugin, JS CLI, Python client) MUST implement this
> protocol identically. The broker (`broker/src/server.js`) is the reference implementation.
> Version: **1.0**. Breaking changes bump the version and are recorded in [CHANGELOG.md](../CHANGELOG.md).

---

## 1. Transport & conventions

- HTTP/1.1 over TCP. Default broker endpoint: `http://127.0.0.1:19121` (loopback).
- All request/response bodies are JSON (`application/json; charset=utf-8`), except `GET /` which has no body.
- Paths are matched on the URL **pathname**; the **query string is part of the signed path** (see §3).
- Maximum request body: **1 MiB** (rejected with `400 bad_request`).
- Message content is **never logged** by the broker or the reference client — ids and events only.

## 2. Message envelope

Every stored message is a JSON object with exactly these fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string (UUID) | auto | Globally unique message id. Client-generated; the broker de-duplicates on it. |
| `from` | string | auto | Sender agent name. **Must equal the `X-Relay-Agent` header** — otherwise `400 bad_request`. |
| `to` | string | yes | Recipient agent name (must be a registered peer, else `404 no_such_agent`). Cannot be `from` itself. |
| `ts` | string (ISO-8601) | auto | Broker-side timestamp when the message is stored. |
| `type` | `"message"` \| `"ack"` | no | Default `"message"`. Anything else is rejected with `400`. |
| `body` | object | no | Free-form payload; default `{}`. |
| `replyTo` | string \| null | no | Optional id of the message this one replies to; default `null`. |
| `ack` | boolean | no | Whether the sender requests an ack receipt; default `false`. |

`from`/`ts`/`id` are **assigned by the broker if absent** — a client MAY send a full envelope or a
shorthand `{ to, body, ... }`. When the client supplies `id`, it is kept verbatim for idempotency.

## 3. Authentication (HMAC-SHA256)

Every request **except `GET /`** must carry three headers:

| Header | Value |
|---|---|
| `X-Relay-Agent` | agent name (string) |
| `X-Relay-Timestamp` | Unix epoch **seconds** (integer as string) |
| `X-Relay-Signature` | hex HMAC-SHA256 of the signing string |

Signing string (UTF-8, literal `\n` separators):

```
method + "\n" + path + "\n" + timestampSeconds + "\n" + rawBody
```

- `method`: uppercase HTTP method, e.g. `POST`.
- `path`: **pathname + query string** exactly as sent, e.g. `/messages?since=abc&limit=50`.
- `rawBody`: the raw request body string; `""` (empty) when there is no body.

Example (`secret = "s3cret"`, `agent = "alpha"`):

```
POST\n/messages\n1712345678\n{"id":"...","to":"beta","body":{"text":"hi"}}
```

Verify with a **constant-time comparison**. Reject with `401 unauthenticated` on:
- missing/empty headers,
- timestamp skew > **300 seconds**,
- signature mismatch.

### Lockout (brute-force protection)

- After **5 consecutive auth failures** (default `security.lockAfterFailures`), the agent is locked
  for **5 minutes** (default `security.lockMinutes`); locked requests get `403 locked`.
- Rate limiting per source IP: `rateLimitLoopback` (default 600/min) for `127.0.0.1`/`::1`,
  `rateLimitRemote` (default 120/min) for everything else. Exceeding the limit returns `429 rate_limited`.
- Remote (non-loopback) deployments MUST enable TLS — HMAC authenticates but does not encrypt.

## 4. Endpoints

### `GET /` — version negotiation (no auth)

```json
{
  "protocol": "1.0",
  "broker": "dsh-agent-relay",
  "version": "0.3.0",
  "capabilities": {
    "leaseDelivery": true,
    "requestReply": true,
    "filteredQuery": true,
    "sqlitePersistence": true
  },
  "storage": "sqlite"
}
```

Adapters MUST call this at startup and refuse to run on `protocol` mismatch
(see reference client `RelayClient.handshake()`). `capabilities` and `storage` are additive runtime
metadata: older brokers may omit them, and clients MUST NOT require them for baseline v1.0 behavior.
`storage` reports the active backend (`memory`, `sqlite`, or `jsonl`); `sqlitePersistence` reports
whether the current Node runtime supports the built-in SQLite backend.

### `POST /register` — register / heartbeat (auth)

Body: `{ "agent": "<name>" }` (optional; must match `X-Relay-Agent` if present).

```json
{ "ok": true, "agent": "alpha", "ts": 1712345678 }
```

Peer liveness is derived from last registration: an agent is `online` if
`now - lastSeen < 90s` (heartbeat TTL).

### `GET /peers` — list registered agents (auth)

```json
{ "peers": [ { "agent": "alpha", "online": true, "lastSeen": 1712345678 } ] }
```

Sorted by agent name. `online` is computed with the 90 s heartbeat TTL.

### `POST /messages` — send (auth)

Body: envelope (full or shorthand). Responses:

- `201 { "accepted": true, "id": "<id>", "duplicate": false }` — stored.
- `200 { "accepted": true, "id": "<id>", "duplicate": true }` — id already seen; idempotent.
- `400 bad_request` — malformed body / `to` missing / `from` mismatch / self-send / bad `type`.
- `404 no_such_agent` — recipient has never registered.

### `GET /messages?since=<id>&limit=<n>` — poll inbox (auth)

- `since`: last seen message **id** (poll cursor). Messages with a sequence strictly after it are
  returned; `null`/unknown returns everything for this agent. `limit` default 50, clamped to 1–200.
- Response: `{ "messages": [ ...envelopes addressed to this agent... ], "cursor": "<last id|null>" }`.
- Unread messages expire after `messageTtlDays` (default 7 days).

### `POST /messages/<id>/ack` — acknowledge receipt (auth)

Only the authenticated recipient may submit this receipt. Lease acknowledgements require the message to be leased; terminal messages cannot be revived.

Body: `{ "status": "ok" | "error", "error": "<string>" }` (`error` only when `status: "error"`).

Stores a new `type: "ack"` envelope with `replyTo: <id>` back to the original sender.
`404 no_such_message` if the id is unknown or expired.

## 5. Reliability semantics

- **Retry:** transient failures (`5xx`, `408`, `429`) retry with **2 / 4 / 8 s** backoff, at most
  **3 retries**, keeping the message `id` stable (idempotent).
- **Deduplication:** the broker rejects re-insertion of an existing `id`
  (`200 duplicate: true`) — safe to re-send on timeout.
- **Ordering:** messages get a monotonic sequence number; polling via `since` is incremental and
  stable across reconnects.
- **Persistence:** with `persist: true` (default), messages use `dataDir/relay.db` on a Node runtime
  with built-in SQLite support. Node 20 automatically falls back to `dataDir/messages.jsonl`;
  `broker.storage: jsonl` selects that compatibility backend explicitly. Both backends preserve the
  same envelope and lease state across restarts.
- **Acks:** optional; when `ack: true` is set on a sent envelope, the receiver SHOULD reply via the
  ack endpoint so the sender can correlate with `replyTo`.

### 5.1 v1.1 additive extensions (backward compatible, protocol stays 1.0)

These are **additive**: every v1.0 field and endpoint keeps its exact meaning; older clients continue
to work unchanged. Feature revision label: **v1.1** (package 0.3.0+).

**New envelope fields (all optional):**

| Field | Type | Description |
|---|---|---|
| `kind` | `"message" \| "request" \| "reply"` | Default `"message"`. `request` opens a conversation; `reply` carries `parentId`. Anything else → `400`. |
| `rootId` | string \| null | Id of the first message in a request/reply chain. |
| `parentId` | string \| null | For a `reply`, the id of the message being answered. |
| `status` | string | Broker-managed: `queued` \| `leased` \| `done` \| `failed`. Not settable by clients. |
| `attempts` | number | Broker-managed delivery attempts. |
| `leaseUntil` | string \| null | Broker-managed lease deadline (epoch ms). |

**Delivery state machine** (replaces plain polling for v1.1 clients):

```
queued →(pull) leased →(ack completed) done
         │              └→(ack retry) queued (attempts+1; > maxAttempts → failed)
         └→(lease expiry, leaseSweep) queued
```

Lease defaults: `leaseSeconds` **600**, `maxAttempts` **3** (both broker config, `broker.leaseSeconds` /
`broker.maxAttempts`).

**New endpoints (all HMAC-authenticated, same headers as §3):**

| Endpoint | Body | Returns |
|---|---|---|
| `POST /v1/pull` | `{ "limit"?, "leaseSeconds"? }` (agent must match header) | `{ "messages": [...leased...], "count" }` |
| `POST /v1/ack` | `{ "messageId", "leaseId", "outcome": "completed"\|"retry", "error"? }` | `{ "ok", "status", "attempts" }` (403 if not the recipient; 404 unknown id; 409 `not_leased` / `lease_mismatch`) |
| `POST /v1/status` | `{ "messageIds": [...] }` | `{ "messages": [{id,status,attempts,ts,from,to,kind}] }` |
| `POST /v1/recent` | `{ "limit"? }` (agent must match header) | `{ "messages": [...], "count" }` — most recent for this agent, any status, read-only |
| `POST /v1/messages/query` | `{ "limit"?, "kind"?, "status"?, "from"?, "to"? }` | `{ "messages": [...], "count" }` — read-only filtered search |

- `/v1/pull` leases queued messages (queued→leased); a leased message is not returned to anyone again
  until its lease expires. Each lease carries an opaque `leaseId` in the returned envelope.
- `/v1/ack` with `completed` finalizes a message; `retry` re-queues it (attempts+1, re-pullable). The
  `leaseId` from the `/v1/pull` envelope is **required** — the broker only accepts an acknowledgement
  for the current lease generation, so a worker that lost its lease (expired, or superseded by a newer
  pull) cannot ack or revive a message it no longer holds. This is a **breaking change vs. earlier
  v1.1 drafts**: clients that acked without `leaseId` must be upgraded to echo it back.
- The v1.0 `GET /messages` poll still works and now returns only `queued` messages, so a v1.0 client
  sees new undelivered messages and never double-delivers leased/done ones. When a v1.1 lease expires
  after a v1.0 cursor has advanced past that message, the broker returns that re-queued message once as
  a cursor-independent recovery delivery. The response cursor does not move backwards; this preserves
  incremental polling while preventing a mixed v1.0/v1.1 deployment from permanently skipping the
  expired lease.

**Routing ACL (optional, v1.1):**

`broker/config.yaml` may declare per-agent send whitelists:

```yaml
agents:
  alpha:
    allowed_targets: [beta, gamma]
```

`POST /messages` returns `403 forbidden` when `from` has an `allowed_targets`
list that does not contain `to`. An agent with **no** entry (or `allowed_targets` absent) may send to
anyone — v1.0 default.

**Receipts (client-side, v1.1):** the dsh plugin persists completed replies per agent to
`~/.dsh-agent-relay-receipts-<hash>.json` (TTL 1 day, atomic write; the hash is derived from the agent
name so multiple plugin instances on one machine never share a receipt store). On a redelivered request
whose id is in the receipts, the plugin replays the cached reply (stable id, idempotent) and acks
`completed` — it never re-runs a completed turn after a restart.

## 6. Errors

All errors use a uniform body:

```json
{ "error": { "code": "<machine_code>", "message": "<human message>" } }
```

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `bad_request` | Malformed body, `to` missing, `from` mismatch, self-send, bad `type`, body too large, invalid `leaseSeconds` |
| 401 | `unauthenticated` | Missing/invalid signature or timestamp skew |
| 401 | `unknown_agent` | Per-agent authentication: the agent name is not configured |
| 403 | `locked` | Agent locked out after repeated auth failures |
| 403 | `forbidden` | ACL rejects the send, or the acking agent is not the recipient |
| 404 | `no_such_agent` | Recipient has never registered |
| 404 | `no_such_message` | Ack target id unknown or expired |
| 404 | `not_found` | No route for `METHOD path` |
| 409 | `not_leased` | `/v1/ack`: the message is not currently leased |
| 409 | `lease_mismatch` | `/v1/ack`: the supplied `leaseId` does not match the current lease |
| 429 | `rate_limited` | Per-IP rate limit exceeded |
| 503 | `busy` | Internal broker error (message content is never included) |

## 7. Versioning

- Protocol version is exposed by `GET /` and enforced at adapter startup.
- **Backward-compatible** changes (new optional fields, new endpoints): patch version, CHANGELOG entry.
- **Breaking** changes (envelope shape, auth scheme, endpoint semantics): major version bump; the
  broker and all adapters must be upgraded together; CHANGELOG documents migration.
