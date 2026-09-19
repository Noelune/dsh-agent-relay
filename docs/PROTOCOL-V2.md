# dsh-agent-relay Wire Protocol v2/v3

> **Normative reference for the wire format.** This format is **byte-for-byte
> compatible** with the self-use Python broker (`relay/protocol.py`). The Node
> broker (`lib/protocol.js`, re-exported by `broker/src/protocol.js`) is the
> reference implementation; the cross-language golden check
> (`test/protocol_v2_golden.py` + `test/protocol-v2.test.mjs`) locks the canonical
> bytes and signatures so both implementations can never drift. The legacy v1
> (camelCase) generation was removed in 0.7.0 — its documents and clients went
> with it, and a v1-shaped request is refused with `400`.
>
> Two signature schemes are served side by side (§3): **v2** signs with the
> agent's single secret, **v3** additionally names a key id so secrets can be
> rotated. `GET /healthz` reports `protocol_version: 3` and
> `signature_schemes: ["v2", "v3"]`. What matters across languages is that the
> **bytes are identical**.

---

## 1. Transport & conventions

- HTTP/1.1 over TCP. Default endpoint `http://127.0.0.1:19121` (loopback).
- All request/response bodies are JSON (`application/json; charset=utf-8`).
- Paths are matched on the URL **pathname**; the **pathname (with query string) is
  part of the signed data** (see §3).
- Maximum HTTP request body: **1 MiB** (`MAX_BODY_BYTES`, `broker/src/http-utils.js`).
  Inside it, `body` and `context` are each capped at **48 000 characters**
  (`MAX_BODY_CHARS`), counted in Unicode code points rather than UTF-16 units.
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
| `allow_shared_write` | boolean | no | Requests only, and forwarded as declared: the sender says the recipient may act on the **shared** working copy instead of an isolated one. The broker stores and delivers it; honouring it is the recipient's job (the self-use Python agent does). Stripped from replies, so it never travels back. |
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

Verify with a **constant-time comparison**. A request with **no
`X-Agent-Relay-*` headers at all** is refused earlier, in dispatch, with `400`
and a pointer to this document — that is what an obsolete v1 client now gets.
Once the headers are present, reject with `401` on:
- an empty agent, timestamp or signature header,
- timestamp skew > **300 seconds**,
- signature mismatch,
- unknown agent (when per-agent secrets are configured).

### 3.1 v3 scheme (key rotation, self-use compatible)

A request may additionally carry `X-Agent-Relay-Key-Id`. When present, the
broker authenticates with the **v3** scheme instead:

| Header | Value |
|---|---|
| `X-Agent-Relay-Key-Id` | key id from the agent's keyring (e.g. `legacy`) |

Signing string (one extra field — the key id — inserted second):

```
HMAC-SHA256( secret, agent + "\n" + keyId + "\n" + timestampSeconds + "\n" + METHOD + "\n" + pathname + "\n" + sha256hex(body) )
```

Each agent's keyring maps key ids to `{ secret, not_after? }` (broker config
`agents.<name>.keys`; the implicit `legacy` key is the agent's single secret).
A key past its `not_after` unix timestamp is rejected with
`401 unknown_key` — rotate by publishing the new key id, switching clients
over, then expiring the old one. Both schemes are accepted side by side
(`/healthz` reports `signature_schemes: ["v2", "v3"]` and
`protocol_version: 3`), so existing v2 clients keep working while clients
migrate.

**v3 delivery credentials.** A v3 `pull` response additionally includes
`lease_token` and `lease_until` per message. While the lease is active the
token is required and single-use:

- `POST /v1/ack` with `lease_token` — the broker guards the state transition
  on `status='leased' AND lease_token matches AND lease_until >= now`
  (`409 lease_mismatch` otherwise). Acks without a token follow the v2 rules.
- `POST /v1/lease/renew` — `{ agent?, message_id, lease_token, lease_seconds? }`
  extends an active lease for long-running turns and returns
  `{ ok: true, lease_until }` (`409` when the lease is gone).

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
  "protocol_version": 3,
  "broker": "dsh-agent-relay",
  "version": "0.8.0",
  "storage": "sqlite",
  "signature_schemes": ["v2", "v3"],
  "long_poll": { "max_wait_seconds": 120, "held": 1 },
  "presence": {
    "dsh":    { "last_pull_at": 1789754385.1, "online": true,  "age_seconds": 9 },
    "codex":  { "last_pull_at": null,           "online": false, "age_seconds": null }
  },
  "agents": ["codex", "dsh", "hermes"]
}
```

`protocol_version` 3 reports the bilingual broker (v2 signatures accepted
alongside v3, see §3.1). `queues` additionally includes `oldest_queued_at`
per agent. `presence` is derived from real claim activity — it is the only
liveness signal v2 clients produce, because none of them ever called the legacy
v1 heartbeat that used to sit here. `online` means "claimed within 90 s".

### `POST /v1/messages` — create a message (auth)

Body: a v2 envelope subset (§2). Rules:

- `origin` must equal the authenticated agent → else `403`.
- `kind` must be `request` or `reply` → else `400`.
- `body` non-empty, ≤ 48 000 chars (Unicode code points), and `idempotency_key` non-empty → else `400`.
- `ttl_seconds` clamped to `[60, 2592000]` (30 days); default **604800 = 7 days**.
  Retention must outlive the recipient being offline — the old one-hour default
  made silent expiry the normal outcome (2026-09-19 audit: 15 of 27 stored
  messages expired with `attempts=0`).
- **request**: `execution_mode` must be `read|continue|write`; the target must
  be allowed by the sender's **per-mode ACL** for that mode (see §5.1). Write is
  closed by default (`allowed_write_targets` empty). A fresh `root_id` is
  generated, or the caller may supply its own — that is how `ask()` later claims
  exactly the answer with `match_root_id` (see §5.2).
- **reply**: `parent_id` is required; the parent must exist (`404` if not) and
  the reply's `(origin, target)` must match the parent's `(target, origin)`
  (`403` otherwise). `root_id`, `session_ref`, `execution_mode`, `topic` are
  inherited from the parent.
- **Idempotency**: a repeated `(origin, idempotency_key)` returns the original
  `message_id` with `created: false`.
- **On-demand delivery**: when nothing is holding a pull for the target *and* it
  has claimed nothing in the last 90 s, an `agents.<name>.wake_command` is
  started once (see §5.3). The presence gate is what keeps a woken worker from
  competing with a resident poller for the same message.

Response (HTTP 200) — presence is reported on every accepted send so the caller
learns immediately whether anybody is listening, instead of an hour later:

```json
{
  "message_id": "9f2c1a...", "created": true, "root_id": "7ab4...",
  "protocol_version": 3,
  "target_online": false, "last_seen_at": null, "will_wake": true,
  "hint": "目标 codex 自 未连接过 未取件，消息已留存 168 小时等待投递…"
}
```

`hint` is only present when the target is offline and the message is new.

### `POST /v1/pull` — lease queued messages (auth)

Body: `{ "agent"?, "limit"?, "lease_seconds"?, "wait_seconds"?, "match_root_id"? }`
(agent must match the authenticated identity). `limit` clamps to `[1, 8]`,
`lease_seconds` to `[15, 3600]`. Leases up to `limit` queued messages addressed
to the agent (queued → leased, `attempts` +1) and returns their public views (no
broker-managed `status`/`attempts`). A message is not returned again until its
lease expires or it is acked.

- `wait_seconds` (≤ 120) turns the claim into a **long-poll**: when nothing is
  queued the broker parks the request and answers the instant a message is
  created for this agent (measured **10–30 ms** between the send committing and
  a held pull returning, 2026-09-19), instead of the client asking every couple
  of seconds.
  It resolves with whatever the claim finds, so it can legitimately return an
  empty list (a competing puller won, or the deadline passed).
- `match_root_id` restricts the claim to one conversation, letting a caller wait
  for a specific answer without stealing the rest of its own inbox.

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

- `POST /v1/admin/requeue` — `{ "message_id" }`. **The receiving agent** may
  requeue its own unfinished `request` (a `leased`/`failed`/`expired` message goes
  back to `queued` with `attempts` reset); anyone else gets `403`, a missing id
  `404`, and a message in no requeue-able state `404`. Requeueing also wakes the
  recipient, so a revived message does not wait for the next poll period.
- `POST /v1/admin/cancel` — `{ "message_id" }`. **The originating agent** may
  cancel its own `request` (it becomes `completed` and is never delivered);
  `403` / `404` as above.
- Members listed in `security.admin_agents` may do either to **any** message; the
  rules above are what everybody else is held to.
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

- An agent **without** a config entry may send read/continue to anyone (the
  permissive default inherited from the self-use broker).
- An agent **with** an entry is restricted to the whitelist for the requested
  mode; write is closed unless explicitly granted.
- `POST /v1/messages` returns `403` when the target is not allowed for the mode.
- **The ACL gates requests only.** A `reply` is authorised by its parent instead —
  its `(origin, target)` must mirror the parent's `(target, origin)` — so removing
  a member from your list stops *new* requests to it but does not stop you from
  answering one it sent you. (Verified live: with `zcode` removed from every
  member's list, `qoder → zcode` requests get `403` while replies to zcode's own
  requests still arrive and settle.)

### 5.2 Undelivered notices

When a `request` exhausts its attempts (`failed`) or expires without being
acknowledged, the broker creates an `undelivered` reply back to the origin so
the requester learns the peer never processed it. Exactly one notice per request
(guarded by `notified_at`), idempotent via `idempotency_key: undelivered:<id>`.
Controlled by `broker.notifyFailedToSender` (default `true`).

Two properties matter, both added after the 2026-09-19 audit: the sweep runs on a
**60 s server-side timer** (it used to run only inside `pull`/`ack`, so a recipient
that never came online also swallowed its own error report), and the notice is
retained for **at least 7 days** — an error report must not expire before the
failure it describes is discoverable.

### 5.3 On-demand wake (`wake_command`)

Poll-based delivery assumes the recipient is running something. On a personal
machine that assumption fails constantly: at audit time 4 of 6 circle members had
no poller alive, so anything sent to them was doomed.

A member may therefore declare `agents.<name>.wake_command`. When a message is
created for a member that holds **no** open pull **and** has claimed nothing in
the last 90 s, the broker starts that command once:

- one in-flight wake per agent (a second message while it runs does not stack);
- placeholders `{agent}`, `{message_id}`, `{root_id}` are expanded in the command;
- `AGENT_RELAY_AGENT`, `AGENT_RELAY_SECRET` and `AGENT_RELAY_BROKER_URL` are put
  in the child's **environment**, never the command line — argv is visible in the
  process list on Windows;
- stdout/stderr are ignored; the broker logs ids only, never content.

`adapters/relay-agent.mjs --once` is the reference worker: it claims what is
queued, answers through its `--backend-cmd`, and exits when the queue is dry.

## 6. Errors

Uniform body: `{ "error": { "code": "<machine_code>", "message": "<human>" } }`

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `bad_request` | Malformed body, invalid kind, missing body/idempotency key, invalid execution_mode, invalid limit/lease/since — **and any request with no `X-Agent-Relay-*` headers at all**, which is what an obsolete v1 client now gets |
| 401 | `unauthenticated` / `unknown_agent` / `unknown_key` | Empty credential headers, timestamp skew, signature mismatch, unknown agent, or a key id that is unknown or past its `not_after` |
| 403 | `forbidden` | `origin` mismatch, per-mode ACL denies the target, reply not authorized, agent mismatch, ack/requeue/cancel by a party that is not the recipient/originator |
| 404 | `no_such_message` / `not_found` | Reply parent not found, requeue/cancel on a message in no eligible state, unknown route |
| 409 | `lease_mismatch` | A `lease_token` that no longer matches an active lease: ack or renew after the lease expired, was re-claimed, or never existed |

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

- **JS** — `lib/client-v2.js` (`RelayClientV2`): `health`, `sendRequest`,
  `sendRequestDetailed` (returns presence + `will_wake`), `sendReply`, `ask`
  (hand off and wait for the matching reply, claiming by `root_id`), `pull`
  (`limit`, `leaseSeconds`, `waitSeconds`, `matchRootId`), `ack`, `renewLease`,
  `status`, `recent`, `query`, `requeue`, `cancel`, `adminStatus`.
- **Python** — `adapters/hermes/relay_client_v2.py` (`RelayClientV2`, pure
  stdlib): the same surface, byte-compatible with the self-use `relay/client.py`.
- **CLI** — `node adapters/cli/relay.mjs v2 <command>`: `health`, `ask`, `send`,
  `pull` (`--wait` long-poll, `--root` targeted claim), `reply <parent_id> <body>`,
  `ack` (`--token`),
  `status`, `recent`, `query`, `requeue`, `cancel`. Identity and credentials come
  from the shared config layering (see `lib/relay-config.mjs`), so a deployed
  member needs no flags. Exit codes: 0 ok, 2 bad usage, **3 peer unreachable**.
- **MCP** — `mcp/relay-mcp.mjs` puts the same protocol in front of a host that
  starts an agent per session: `relay_ask`, `relay_send`, `relay_inbox`,
  `relay_reply`, `relay_status`, `relay_agents`.

There is no v1 client: `lib/client.js`, `adapters/hermes/relay_client.py` and the
v1 command set were removed with the v1 generation in 0.7.0.
