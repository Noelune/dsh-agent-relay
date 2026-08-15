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
- `body` non-empty, ≤ 48 000 chars, and `idempotency_key` non-empty → else `400`.
- `ttl_seconds` clamped to `[60, 3600]` (default 3600).
- **request**: `execution_mode` must be `read|continue|write`; the target must
  be allowed by the sender's ACL for that mode; `write` mode is currently
  refused (`403`) until workspace isolation ships (Phase 2+ of the migration).
  A fresh `root_id` is generated.
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

## 6. Errors

Uniform body: `{ "error": { "code": "<machine_code>", "message": "<human>" } }`

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `bad_request` | Malformed body, invalid kind, missing body/idempotency key, invalid execution_mode |
| 401 | `unauthenticated` / `unknown_agent` | Missing/invalid v2 signature, timestamp skew, unknown agent |
| 403 | `forbidden` | `origin` mismatch, ACL denies the target, write mode not enabled, reply not authorized |
| 404 | `no_such_message` | Reply parent not found |

## 7. State machine & lifecycle

Phase 1 implements **creation only** (message enters the `queued` state in the
transitional v2 store). `pull` / `ack` / `status` / `expired` for v2 messages —
and the merge of the v2 store into the unified store — are the next migration
phases. The intended state machine (matching the self-use broker) is:

```
queued →(pull) leased →(ack completed) completed
         │              └→(ack retry) queued (attempts+1; > maxAttempts → failed)
         └→(expires_at reached) expired
failed / expired →(admin requeue) queued
```
