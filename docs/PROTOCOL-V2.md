# dsh-agent-relay Wire Protocol v2

> **Normative reference for the v2 wire format.** This format is **byte-for-byte
> compatible** with the self-use Python broker (`relay/protocol.py`). The Node
> broker (`broker/src/protocol.js`) is the reference implementation; the
> cross-language golden check (`test/protocol_v2_golden.py` + `test/protocol-v2.test.mjs`)
> locks the canonical bytes and signatures so both implementations can never
> drift. The legacy v1 (camelCase) format is documented in `PROTOCOL.md`.
>
> Versioning note: the wire format described here is called **v2** and reported
> as `protocol_version: 2` from `GET /healthz`. The self-use broker internally
> labels the same wire format version `1`; the version *number* is
> informational (no shipped client gates on it) — what matters is that the
> **bytes are identical**.

---

## 1. Transport & conventions

- HTTP/1.1 over TCP. Default endpoint `http://127.0.0.1:19121` (loopback).
- All request/response bodies are JSON (`application/json; charset=utf-8`).
- Paths are matched on the URL **pathname**; the **pathname (with query string) is
  part of the signed data** (see §3).
- Maximum request body: **48 000 characters** (`MAX_BODY_CHARS`), enforced on the
  `body`/`context` fields; the HTTP body itself is bounded by the server at
  `MAX_BODY_CHARS * 3` bytes.
- Message content is never logged by the broker — ids and events only.

## 2. Message envelope

Every v2 message is a JSON object with exactly these fields (snake_case):

| Field | Type | Required | Description |
|---|---|---|---|
| `message_id` | string (32-hex) | auto | Globally unique message id (broker-assigned, `uuid.uuid4().hex`). |
| `root_id` | string (32-hex) | auto | Id of the first message in the request/reply chain. A request generates one; replies inherit the request's. |
| `parent_id` | string \| null | replies only | For a reply, the id of the message being answered. |
| `origin` | string (lowercase) | yes | Sender agent name. **Must equal the authenticated agent.** |
| `target` | string (lowercase) | yes | Recipient agent name. |
| `kind` | `"request"` \| `"reply"` | yes | A request opens a conversation; a reply answers one. |
| `body` | string | yes | Free-form content (1–48 000 chars). |
| `session_ref` | string \| null | no | Sender-side session reference (≤300 chars); replies inherit it. |
| `created_at` | number (epoch s) | auto | Broker-set creation time. |
| `expires_at` | number (epoch s) | auto | `created_at + ttl`; the message is expired after this. |
| `execution_mode` | `"read"` \| `"continue"` \| `"write"` | no | Default `"read"`. Replies inherit the request's mode. |
| `context` | string | no | Optional structured context the peer may need (project path, constraints, memory excerpt); treated as untrusted data. |
| `topic` | string | no | Optional collaboration topic (≤200 chars) so a request/reply tree is searchable by subject; replies inherit it. |

Clients send the envelope **without** `message_id`, `root_id`, `created_at`,
`expires_at` (the broker assigns them) — the wire payload a client signs is a
*subset*: `origin`, `target`, `kind`, `body`, `session_ref`, `idempotency_key`,
`ttl_seconds`, `execution_mode`, `context`, `topic`, `parent_id`.

## 3. Authentication (HMAC-SHA256, v2 scheme)

Every request **except `GET /healthz`** must carry three headers:

| Header | Value |
|---|---|
| `X-Agent-Relay-Agent` | agent name (lowercase) |
| `X-Agent-Relay-Timestamp` | Unix epoch **seconds** (integer as string) |
| `X-Agent-Relay-Signature` | hex HMAC-SHA256 of the signing string |

Signing string (UTF-8, literal `\n` separators):

```
HMAC-SHA256( secret,
    agent + "\n" + timestampSeconds + "\n" + METHOD + "\n" + pathname + "\n" + sha256hex(body) )
```

where `sha256hex(body)` is the lowercase hex digest of the **canonical body
bytes** (§4) and `secret` is the agent's secret (per-agent when configured,
otherwise the shared broker secret).

The **canonical body bytes are what is sent on the wire** — the client MUST
serialize the payload with §4 canonicalization, sign those exact bytes, and send
those exact bytes. The server verifies against the raw bytes it received.

Verify with a **constant-time comparison**. Reject with `401` on:
- missing/empty headers,
- timestamp skew > **300 seconds**,
- signature mismatch,
- unknown agent (when per-agent secrets are configured).

## 4. Canonical body (byte-for-byte)

```text
json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
```

- Keys are sorted recursively (lexicographic, UTF-8 byte order).
- No spaces after `,` or `:`.
- Non-ASCII characters are **preserved as raw UTF-8** (NOT `\uXXXX`-escaped).
- Strings escape `"`, `\`, `\b \t \n \f \r`, and other control chars as `\u00XX`.
- Integral floats serialize as `N.0` (Python-style); integers as-is.

### Worked example

Payload (as a client would send it):

```json
{"body":"Please review this change","execution_mode":"read","idempotency_key":"dsh:9f2c1a","kind":"request","origin":"dsh","session_ref":"dsh","target":"codex","ttl_seconds":3600}
```

Canonical bytes (sorted keys, compact):

```
{"body":"Please review this change","execution_mode":"read","idempotency_key":"dsh:9f2c1a","kind":"request","origin":"dsh","session_ref":"dsh","target":"codex","ttl_seconds":3600}
```

With `agent=test-agent`, `secret=s3cret`, `method=POST`, `path=/v1/messages`,
`timestamp=1755250000`, the signature is:

```
191f619a22bf4d177bfe8f74a1074e5dc4e929e05507269a9584cc2e49513225
```

(Golden vectors — including non-ASCII and escaped-newline cases — live in
`test/protocol-v2.test.mjs` and `test/protocol_v2_golden.py`.)

## 5. Endpoints

### `GET /healthz` — liveness + protocol metadata (no auth)

```json
{
  "ok": true,
  "protocol_version": 2,
  "broker": "dsh-agent-relay",
  "version": "0.3.0",
  "storage": "sqlite",
  "agents": ["codex", "dsh", "hermes"]
}
```

### `POST /v1/messages` — create a message (auth)

Body: a v2 envelope subset (§2). Rules:

- `origin` must equal the authenticated agent → else `403`.
- `kind` must be `request` or `reply` → else `400`.
- `body` non-empty, ≤ 48 000 chars (Unicode code points), and `idempotency_key` non-empty → else `400`.
- `ttl_seconds` clamped to `[60, 3600]` (default 3600).
- **request**: `execution_mode` must be `read|continue|write`; the target must
  be allowed by the sender's **per-mode ACL** for that mode (see §5.1). Write is
  closed by default (`allowed_write_targets` empty). A fresh `root_id` is
  generated.
- **reply**: `parent_id` is required; the parent must exist (`404` if not) and
  the reply's `(origin, target)` must match the parent's `(target, origin)`
  (`403` otherwise). `root_id`, `session_ref`, `execution_mode`, `topic` are
  inherited from the parent.
- **Idempotency**: a repeated `(origin, idempotency_key)` returns the original
  `message_id` with `created: false`.

Response (HTTP 200):

```json
{ "message_id": "9f2c1a...", "created": true, "protocol_version": 2 }
```

### `POST /v1/pull` — lease queued messages (auth)

Body: `{ "agent"?, "limit"?, "lease_seconds"? }` (agent must match the
authenticated identity). `limit` clamps to `[1, 8]`, `lease_seconds` to
`[15, 3600]`. Leases up to `limit` queued messages addressed to the agent
(queued → leased, `attempts` +1) and returns their public views (no
broker-managed `status`/`attempts`). A message is not returned again until its
lease expires or it is acked.

### `POST /v1/ack` — acknowledge a leased message (auth)

Body: `{ "agent"?, "message_id", "outcome": "completed"|"retry", "error"? }`.
Only the recipient may ack (`403` otherwise), and only while the message is
leased (`400` otherwise — a late or duplicated ack never resurrects a
terminal message). `completed` finalizes the message;
`retry` re-queues it (`attempts`+1; over `maxAttempts` → `failed`). `error` is
recorded (≤300 chars).

### `POST /v1/status` — batch status lookup (auth)

Body: `{ "agent"?, "message_ids": [...] }` (≤100 ids). Returns status for
messages the agent is **origin or target** of; others are reported
`not_found`.

### `POST /v1/recent` — recent messages (auth)

Body: `{ "agent"?, "limit"? }` (`limit` 1–50, default 20). Most recent messages
(last 7 days) the agent was involved in, newest first. No body in the response.

### `POST /v1/messages/query` — read-only search (auth)

Body: `{ "agent"?, "message_id"?, "root_id"?, "origin"?, "target"?, "kind"?,
"status"?, "topic"?, "since"?, "limit"? }`. Returns messages the agent is
**origin or target** of (never other agents' messages), newest first, **with
body**. `since` is a `created_at` cutoff (epoch seconds).

### Admin helpers (authenticated parties only)

- `POST /v1/admin/requeue` — `{ "message_id" }`; revives a `leased`/`failed`/`expired`
  message to `queued` (resets `attempts`). `404` if not requeue-able. Only the
  originator or the recipient of the message may call this (`403` otherwise).
- `POST /v1/admin/cancel` — `{ "message_id" }`; marks a non-terminal message
  `completed` so it is never delivered. `404` if not cancellable. Only the
  originator or the recipient of the message may call this (`403` otherwise).
- `POST /v1/admin/status` — `{ "agent"?, "limit"? }`; lists non-terminal messages
  targeting the agent (`queued`/`leased`/`failed`/`expired`, last 7 days) with a
  `body_preview`, so an operator can decide what to requeue/cancel.

### 5.1 Per-mode ACL

Each configured agent may declare separate target whitelists per execution mode:

```yaml
broker:
  secret: ...
agents:
  alpha:
    allowed_targets: [beta]              # legacy default (read + continue)
    allowed_read_targets: [beta]         # optional; defaults to allowed_targets
    allowed_continue_targets: [beta]     # optional; defaults to allowed_targets
    allowed_write_targets: []            # write is OPT-IN; empty = closed
```

- An agent **without** a config entry may send to anyone (v1-compatible default).
- An agent **with** an entry is restricted to the whitelist for the requested
  mode; write is closed unless explicitly granted.
- `POST /v1/messages` returns `403` when the target is not allowed for the mode.

### 5.2 Undelivered notices

When a `request` exhausts its attempts (`failed`) or expires without being
acknowledged, the broker creates an `undelivered` reply back to the origin so
the requester learns the peer never processed it. Exactly one notice per request
(guarded by `notified_at`), idempotent via `idempotency_key: undelivered:<id>`.
Controlled by `broker.notifyFailedToSender` (default `true`).

## 6. Errors

Uniform body: `{ "error": { "code": "<machine_code>", "message": "<human>" } }`

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `bad_request` | Malformed body, invalid kind, missing body/idempotency key, invalid execution_mode, invalid limit/lease/since |
| 401 | `unauthenticated` / `unknown_agent` | Missing/invalid v2 signature, timestamp skew, unknown agent |
| 403 | `forbidden` | `origin` mismatch, per-mode ACL denies the target, reply not authorized, agent mismatch, ack by non-recipient |
| 404 | `no_such_message` | Reply parent not found, requeue/cancel on a non-eligible message |

## 7. State machine & lifecycle

```
queued →(pull) leased →(ack completed) completed
         │              └→(ack retry) queued (attempts+1; > maxAttempts → failed)
         └→(expires_at reached) expired
queued/leased →(attempts exhausted, cleanup) failed
failed / expired →(admin requeue) queued
```

- `expires_at` is set at creation (`created_at + ttl`) and enforced by the
  maintenance sweep (`cleanup`): an un-acked `queued`/`leased` message past its
  deadline becomes `expired`.
- A `queued`/`leased` message whose `attempts` reach `maxAttempts` without an
  ack is marked `failed` so the sender can see it was not processed.
- Terminal messages (`completed`/`expired`/`failed`) are retained for
  **30 days**, then purged.

## 8. Clients

- **JS** — `lib/client-v2.js` (`RelayClientV2`): `sendRequest`, `sendReply`,
  `pull`, `ack`, `status`, `recent`, `query`, `requeue`, `cancel`, `adminStatus`,
  `health`.
- **Python** — `adapters/hermes/relay_client_v2.py` (`RelayClientV2`, pure
  stdlib): the same surface, byte-compatible with the self-use `relay/client.py`.
- **CLI** — `adapters/cli/relay.mjs` exposes `v2 <subcommand>` for every v2
  endpoint (health / send / pull / ack / status / recent / query / requeue /
  cancel).

The legacy v1 clients (`lib/client.js`, `adapters/hermes/relay_client.py`, the
v1 CLI commands) remain for v1 compatibility.
