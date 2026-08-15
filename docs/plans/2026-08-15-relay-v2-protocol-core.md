# Relay v2 Wire Protocol Core — Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the self-use v2 wire protocol (canonical JSON signing, v2 auth, `/healthz`, `POST /v1/messages`) to the Node broker, byte-for-byte compatible with the self-use Python `relay/protocol.py`, without breaking the existing v1 protocol.

**Architecture:** The v2 wire format is added as an additive layer next to the existing v1 broker. `broker/src/protocol.js` holds the protocol primitives (canonical serializer, signature, `RelayMessage`) — the single source of truth, locked by golden-vector tests generated from the real self-use `protocol.py`. The broker detects v2 requests by the `X-Agent-Relay-*` headers and authenticates them with the v2 signature scheme; v1 requests keep using the existing `X-Relay-*` flow. `POST /v1/messages` stores v2 messages in a dedicated transitional `store-v2.js` (merged into the unified store in Phase 2).

**Tech Stack:** Node.js ≥ 20, ESM, `node:test`, Node built-ins only (no new dependencies). Python 3.10+ for the cross-language golden test.

## Global Constraints

- **Zero external dependencies** — only Node built-ins (`node:crypto`, `node:fs`, `node:path`, `node:http`).
- **v1 wire must keep working unchanged** — every existing v1 test stays green.
- **v2 wire must be byte-for-byte identical to self-use `relay/protocol.py`** — canonical body: `json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)`. Signature: `HMAC-SHA256(secret, agent + "\n" + timestamp + "\n" + method + "\n" + path + "\n" + sha256hex(body))`.
- **Headers (v2):** `X-Agent-Relay-Agent`, `X-Agent-Relay-Timestamp`, `X-Agent-Relay-Signature`.
- **Constants (v2):** `MAX_CLOCK_SKEW_SECONDS=300`, `MAX_BODY_CHARS=48000`, `EXECUTION_MODES=["read","continue","write"]`, `DEFAULT_REQUEST_TTL_SECONDS=3600`, TTL clamp `[60, 3600]`.
- **No secrets in tests** — fixture values (`s3cret`, `test-agent`).
- **Follow repo style** — ESM, `node:test`, JSDoc comments on exported functions.
- **Golden vectors in tests are hard-coded** and were generated from the real self-use `protocol.py` (do not regenerate by hand).

---

### Task 1: v2 protocol primitives — `broker/src/protocol.js`

**Files:**
- Create: `broker/src/protocol.js`
- Create: `test/protocol-v2.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 3–5):
  - `canonicalBody(payload: object) -> Buffer`
  - `makeSignature(agent: string, secret: string, method: string, path: string, timestamp: string, body: Buffer) -> string`
  - `verifySignature(agent, secret, method, path, timestamp, body, signature) -> boolean`
  - `PROTOCOL_VERSION` (number, = 2)
  - `SIGNATURE_HEADERS` (agent/timestamp/signature → lowercase header names)
  - `MAX_CLOCK_SKEW_SECONDS`, `MAX_BODY_CHARS`, `EXECUTION_MODES`, `DEFAULT_REQUEST_TTL_SECONDS`
  - `RelayMessage` class with `static fromDict(payload)` and `toDict()`

- [ ] **Step 1: Write the failing test** `test/protocol-v2.test.mjs`

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalBody, makeSignature, verifySignature } from '../broker/src/protocol.js'

const AGENT = 'test-agent'
const SECRET = 's3cret'
const METHOD = 'POST'
const PATH = '/v1/messages'
const TS = '1755250000'

const VECTORS = [
  {
    name: 'request_ascii',
    payload: {
      body: 'Please review this change',
      execution_mode: 'read',
      idempotency_key: 'dsh:9f2c1a',
      kind: 'request',
      origin: 'dsh',
      session_ref: 'dsh',
      target: 'codex',
      ttl_seconds: 3600,
    },
    bodyHex: '7b22626f6479223a22506c65617365207265766965772074686973206368616e6765222c22657865637574696f6e5f6d6f6465223a2272656164222c226964656d706f74656e63795f6b6579223a226473683a396632633161222c226b696e64223a2272657175657374222c226f726967696e223a22647368222c2273657373696f6e5f726566223a22647368222c22746172676574223a22636f646578222c2274746c5f7365636f6e6473223a333630307d',
    signature: '191f619a22bf4d177bfe8f74a1074e5dc4e929e05507269a9584cc2e49513225',
  },
  {
    name: 'request_cjk',
    payload: {
      body: '请帮我核查一下这段代码的边界条件',
      context: '项目路径 D:/workspace/proj，注意不要改动凭据',
      execution_mode: 'write',
      idempotency_key: 'hermes:7e1b',
      kind: 'request',
      origin: 'hermes',
      session_ref: 'hermes',
      target: 'claude',
      topic: 'code-review',
      ttl_seconds: 1800,
    },
    bodyHex: '7b22626f6479223a22e8afb7e5b8aee68891e6a0b8e69fa5e4b880e4b88be8bf99e6aeb5e4bba3e7a081e79a84e8beb9e7958ce69da1e4bbb6222c22636f6e74657874223a22e9a1b9e79baee8b7afe5be8420443a2f776f726b73706163652f70726f6aefbc8ce6b3a8e6848fe4b88de8a681e694b9e58aa8e587ade68dae222c22657865637574696f6e5f6d6f6465223a227772697465222c226964656d706f74656e63795f6b6579223a226865726d65733a37653162222c226b696e64223a2272657175657374222c226f726967696e223a226865726d6573222c2273657373696f6e5f726566223a226865726d6573222c22746172676574223a22636c61756465222c22746f706963223a22636f64652d726576696577222c2274746c5f7365636f6e6473223a313830307d',
    signature: 'b9c1be8b482d5b8e520685528f453722e2828c346f1e7c066d2178afe1cafb92',
  },
  {
    name: 'reply',
    payload: {
      body: '已审查，结论：无问题。\n风险：无。',
      idempotency_key: 'reply:abc123def456',
      kind: 'reply',
      origin: 'codex',
      parent_id: 'abc123def456',
      session_ref: 'dsh',
      target: 'dsh',
      ttl_seconds: 300,
    },
    bodyHex: '7b22626f6479223a22e5b7b2e5aea1e69fa5efbc8ce7bb93e8aebaefbc9ae697a0e997aee9a298e380825c6ee9a38ee999a9efbc9ae697a0e38082222c226964656d706f74656e63795f6b6579223a227265706c793a616263313233646566343536222c226b696e64223a227265706c79222c226f726967696e223a22636f646578222c22706172656e745f6964223a22616263313233646566343536222c2273657373696f6e5f726566223a22647368222c22746172676574223a22647368222c2274746c5f7365636f6e6473223a3330307d',
    signature: '4417643795f62017d2a0bd509ffa641e17c035f00930f3eec7e636f0f7f4d7d1',
  },
]

test('canonicalBody matches the self-use Python golden bytes', () => {
  for (const vector of VECTORS) {
    assert.equal(canonicalBody(vector.payload).toString('hex'), vector.bodyHex, vector.name)
  }
})

test('makeSignature matches the self-use Python golden signatures', () => {
  for (const vector of VECTORS) {
    const body = canonicalBody(vector.payload)
    assert.equal(
      makeSignature(AGENT, SECRET, METHOD, PATH, TS, body),
      vector.signature,
      vector.name,
    )
  }
})

test('verifySignature accepts the golden signature and rejects a tampered one', () => {
  const body = canonicalBody(VECTORS[0].payload)
  assert.equal(verifySignature(AGENT, SECRET, METHOD, PATH, TS, body, VECTORS[0].signature), true)
  assert.equal(verifySignature(AGENT, SECRET, METHOD, PATH, TS, body, '0'.repeat(64)), false)
  assert.equal(verifySignature(AGENT, SECRET, METHOD, PATH, TS, body, ''), false)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/protocol-v2.test.mjs`
Expected: FAIL — `Cannot find module '../broker/src/protocol.js'`

- [ ] **Step 3: Implement `broker/src/protocol.js`**

```js
/**
 * v2 wire protocol primitives (byte-for-byte compatible with the self-use
 * Python `relay/protocol.py`).
 *
 * Canonical body:   JSON with sorted keys, compact separators, non-ASCII kept
 *                   raw UTF-8 (Python ensure_ascii=False).
 * Signature string: HMAC-SHA256(secret, agent\n ts\n METHOD\n path\n sha256hex(body))
 * Headers:          X-Agent-Relay-Agent / -Timestamp / -Signature
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export const PROTOCOL_VERSION = 2
export const SIGNATURE_HEADERS = {
  agent: 'x-agent-relay-agent',
  timestamp: 'x-agent-relay-timestamp',
  signature: 'x-agent-relay-signature',
}
export const MAX_CLOCK_SKEW_SECONDS = 300
export const MAX_BODY_CHARS = 48000
export const EXECUTION_MODES = ['read', 'continue', 'write']
export const DEFAULT_REQUEST_TTL_SECONDS = 3600
export const TTL_MIN_SECONDS = 60
export const TTL_MAX_SECONDS = 3600

/** Serialize a string the way Python json.dumps(ensure_ascii=False) does. */
function quoteString(str) {
  let out = '"'
  for (const ch of str) {
    const code = ch.codePointAt(0)
    if (code === 0x22) out += '\\"'
    else if (code === 0x5c) out += '\\\\'
    else if (code === 0x08) out += '\\b'
    else if (code === 0x09) out += '\\t'
    else if (code === 0x0a) out += '\\n'
    else if (code === 0x0c) out += '\\f'
    else if (code === 0x0d) out += '\\r'
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`
    else out += ch // non-ASCII preserved raw; surrogate pairs handled by for...of
  }
  return out + '"'
}

/** Serialize a number the way Python json.dumps does (integral floats get .0). */
function quoteNumber(value) {
  if (Number.isInteger(value)) return String(value)
  if (!Number.isFinite(value)) return value === Infinity ? 'Infinity' : value === -Infinity ? '-Infinity' : 'NaN'
  const text = String(value)
  return /[.eE]/.test(text) ? text : `${text}.0`
}

/** Recursive JSON serializer: sorted keys, compact separators, raw UTF-8. */
export function stringifyCanonical(value) {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return quoteNumber(value)
  if (typeof value === 'string') return quoteString(value)
  if (Array.isArray(value)) return `[${value.map(stringifyCanonical).join(',')}]`
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${quoteString(key)}:${stringifyCanonical(value[key])}`).join(',')}}`
  }
  return 'null' // undefined / functions serialize as null, like Python cannot happen on the wire
}

/** Return the exact bytes signed over the wire (matches self-use canonical_body). */
export function canonicalBody(payload) {
  return Buffer.from(stringifyCanonical(payload), 'utf8')
}

/** Build the v2 signature (matches self-use make_signature). */
export function makeSignature(agent, secret, method, path, timestamp, body) {
  const digest = createHash('sha256').update(body).digest('hex')
  const signed = [agent, timestamp, method.toUpperCase(), path, digest].join('\n')
  return createHmac('sha256', secret).update(signed).digest('hex')
}

/** Constant-time v2 signature check (matches self-use verify_signature). */
export function verifySignature(agent, secret, method, path, timestamp, body, signature) {
  if (typeof signature !== 'string' || signature.length === 0) return false
  const expected = makeSignature(agent, secret, method, path, timestamp, body)
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** One v2 message on the wire (request or reply). Mirrors self-use RelayMessage. */
export class RelayMessage {
  constructor({
    message_id, root_id, parent_id, origin, target, kind, body, session_ref,
    created_at, expires_at, execution_mode = 'read', context = '', topic = '',
  }) {
    this.message_id = String(message_id)
    this.root_id = String(root_id)
    this.parent_id = parent_id ? String(parent_id) : null
    this.origin = String(origin)
    this.target = String(target)
    this.kind = String(kind)
    this.body = String(body)
    this.session_ref = String(session_ref || '')
    this.created_at = Number(created_at)
    this.expires_at = Number(expires_at)
    this.execution_mode = String(execution_mode || 'read').toLowerCase()
    this.context = String(context || '')
    this.topic = String(topic || '')
  }

  static fromDict(payload) {
    return new RelayMessage({
      message_id: payload.message_id,
      root_id: payload.root_id,
      parent_id: payload.parent_id || null,
      origin: payload.origin,
      target: payload.target,
      kind: payload.kind,
      body: payload.body,
      session_ref: payload.session_ref || '',
      created_at: payload.created_at,
      expires_at: payload.expires_at,
      execution_mode: payload.execution_mode || 'read',
      context: payload.context || '',
      topic: payload.topic || '',
    })
  }

  toDict() {
    const result = {
      message_id: this.message_id,
      root_id: this.root_id,
      parent_id: this.parent_id,
      origin: this.origin,
      target: this.target,
      kind: this.kind,
      body: this.body,
      session_ref: this.session_ref,
      created_at: this.created_at,
      expires_at: this.expires_at,
      execution_mode: this.execution_mode,
    }
    if (this.context) result.context = this.context
    if (this.topic) result.topic = this.topic
    return result
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/protocol-v2.test.mjs`
Expected: 3 tests PASS (all golden bytes + signatures match)

- [ ] **Step 5: Commit**

```bash
git add broker/src/protocol.js test/protocol-v2.test.mjs
git commit -m "feat(v2): add v2 wire protocol primitives with self-use golden vectors"
```

---

### Task 2: Cross-language golden consistency (Python mirror)

**Files:**
- Create: `test/protocol_v2_golden.py`
- Create: `test/protocol-v2-python.test.mjs`

**Interfaces:**
- Consumes: the hard-coded golden vectors from Task 1 (same values).
- Produces: a Python script that exits 0 when the Python re-implementation reproduces the same canonical bytes + signatures. A Node test that spawns it.

- [ ] **Step 1: Write `test/protocol_v2_golden.py`**

```python
# -*- coding: utf-8 -*-
"""Cross-language golden check: the v2 wire format must be byte-for-byte
identical between the Node broker (broker/src/protocol.js) and this Python
mirror of the self-use relay/protocol.py. The vectors below were generated by
running the real self-use protocol.py; both implementations must reproduce them.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import sys

VECTORS = [
    {
        "name": "request_ascii",
        "payload": {
            "body": "Please review this change",
            "execution_mode": "read",
            "idempotency_key": "dsh:9f2c1a",
            "kind": "request",
            "origin": "dsh",
            "session_ref": "dsh",
            "target": "codex",
            "ttl_seconds": 3600,
        },
        "body_hex": "7b22626f6479223a22506c65617365207265766965772074686973206368616e6765222c22657865637574696f6e5f6d6f6465223a2272656164222c226964656d706f74656e63795f6b6579223a226473683a396632633161222c226b696e64223a2272657175657374222c226f726967696e223a22647368222c2273657373696f6e5f726566223a22647368222c22746172676574223a22636f646578222c2274746c5f7365636f6e6473223a333630307d",
        "signature": "191f619a22bf4d177bfe8f74a1074e5dc4e929e05507269a9584cc2e49513225",
    },
    {
        "name": "request_cjk",
        "payload": {
            "body": "请帮我核查一下这段代码的边界条件",
            "context": "项目路径 D:/workspace/proj，注意不要改动凭据",
            "execution_mode": "write",
            "idempotency_key": "hermes:7e1b",
            "kind": "request",
            "origin": "hermes",
            "session_ref": "hermes",
            "target": "claude",
            "topic": "code-review",
            "ttl_seconds": 1800,
        },
        "body_hex": "7b22626f6479223a22e8afb7e5b8aee68891e6a0b8e69fa5e4b880e4b88be8bf99e6aeb5e4bba3e7a081e79a84e8beb9e7958ce69da1e4bbb6222c22636f6e74657874223a22e9a1b9e79baee8b7afe5be8420443a2f776f726b73706163652f70726f6aefbc8ce6b3a8e6848fe4b88de8a681e694b9e58aa8e587ade68dae222c22657865637574696f6e5f6d6f6465223a227772697465222c226964656d706f74656e63795f6b6579223a226865726d65733a37653162222c226b696e64223a2272657175657374222c226f726967696e223a226865726d6573222c2273657373696f6e5f726566223a226865726d6573222c22746172676574223a22636c61756465222c22746f706963223a22636f64652d726576696577222c2274746c5f7365636f6e6473223a313830307d",
        "signature": "b9c1be8b482d5b8e520685528f453722e2828c346f1e7c066d2178afe1cafb92",
    },
    {
        "name": "reply",
        "payload": {
            "body": "已审查，结论：无问题。\n风险：无。",
            "idempotency_key": "reply:abc123def456",
            "kind": "reply",
            "origin": "codex",
            "parent_id": "abc123def456",
            "session_ref": "dsh",
            "target": "dsh",
            "ttl_seconds": 300,
        },
        "body_hex": "7b22626f6479223a22e5b7b2e5aea1e69fa5efbc8ce7bb93e8aebaefbc9ae697a0e997aee9a298e380825c6ee9a38ee999a9efbc9ae697a0e38082222c226964656d706f74656e63795f6b6579223a227265706c793a616263313233646566343536222c226b696e64223a227265706c79222c226f726967696e223a22636f646578222c22706172656e745f6964223a22616263313233646566343536222c2273657373696f6e5f726566223a22647368222c22746172676574223a22647368222c2274746c5f7365636f6e6473223a3330307d",
        "signature": "4417643795f62017d2a0bd509ffa641e17c035f00930f3eec7e636f0f7f4d7d1",
    },
]

AGENT = "test-agent"
SECRET = "s3cret"
METHOD = "POST"
PATH = "/v1/messages"
TS = "1755250000"


def canonical_body(payload):
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def make_signature(agent, secret, method, path, timestamp, body):
    digest = hashlib.sha256(body).hexdigest()
    signed = "\n".join((agent, timestamp, method.upper(), path, digest)).encode("utf-8")
    return hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()


def main() -> int:
    failures = 0
    for vector in VECTORS:
        body = canonical_body(vector["payload"])
        if body.hex() != vector["body_hex"]:
            print(f"FAIL {vector['name']}: canonical body mismatch")
            failures += 1
            continue
        signature = make_signature(AGENT, SECRET, METHOD, PATH, TS, body)
        if signature != vector["signature"]:
            print(f"FAIL {vector['name']}: signature mismatch")
            failures += 1
            continue
        print(f"ok {vector['name']}")
    if failures:
        print(f"{failures} golden vector(s) FAILED")
        return 1
    print("all golden vectors ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Run it to verify it passes locally**

Run: `python test/protocol_v2_golden.py`
Expected: `ok request_ascii` / `ok request_cjk` / `ok reply` / `all golden vectors ok`

- [ ] **Step 3: Write `test/protocol-v2-python.test.mjs`**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function findPython() {
  const candidates = process.platform === 'win32'
    ? [['py', ['-3']], ['python', []]]
    : [['python3', []], ['python', []]]
  for (const [command, prefix] of candidates) {
    const result = spawnSync(command, [...prefix, '--version'], { encoding: 'utf8' })
    if (result.status === 0) return { command, prefix }
  }
  return null
}

test('v2 protocol golden vectors agree with the Python mirror', () => {
  const python = findPython()
  assert.ok(python, 'Python 3.10+ is required to run the cross-language golden check')
  const result = spawnSync(
    python.command,
    [...python.prefix, 'test/protocol_v2_golden.py'],
    { cwd: repoRoot, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})
```

- [ ] **Step 4: Run the full suite to verify the Node+Python consistency**

Run: `node --test`
Expected: all existing tests + the 2 new ones pass (Python golden exits 0)

- [ ] **Step 5: Commit**

```bash
git add test/protocol_v2_golden.py test/protocol-v2-python.test.mjs
git commit -m "test(v2): cross-language golden consistency check for the v2 wire format"
```

---

### Task 3: v2 authentication + `GET /healthz`

**Files:**
- Modify: `broker/src/server.js`
- Create: `test/v2-auth.test.mjs`

**Interfaces:**
- Consumes: `protocol.js` (Task 1) — `SIGNATURE_HEADERS`, `verifySignature`, `MAX_CLOCK_SKEW_SECONDS`, `PROTOCOL_VERSION`.
- Consumes: `config` (from `createBrokerServer` deps) — `agents` (per-agent secrets), `secret` (shared).
- Produces: `GET /healthz` (public) and v2-authenticated request handling. `verdict.protocol` on the auth result.

- [ ] **Step 1: Add the v2 auth helper + protocol detection + `/healthz` to `broker/src/server.js`**

In `server.js`:
- Add imports: `import { PROTOCOL_VERSION as V2_VERSION, SIGNATURE_HEADERS as V2_HEADERS, MAX_CLOCK_SKEW_SECONDS as V2_SKEW, verifySignature as verifyV2Signature } from './protocol.js'`
- Add an `isV2Request(req)` helper: `return req.headers['x-agent-relay-agent'] !== undefined`
- Add a `verifyV2Request(req, rawBody, config)` helper returning `{ ok: true, agent } | { ok: false, status, code, message }` (resolve the agent's secret from `config.agents[name]?.secret ?? config.secret`).
- In the main handler, after `readBody` and before the existing `GET /` check, add:

```js
// Public liveness + protocol metadata (v2). No auth.
if (req.method === 'GET' && (path === '/healthz')) {
  sendJson(res, 200, {
    ok: true,
    protocol_version: V2_VERSION,
    broker: BROKER_NAME,
    version: BROKER_VERSION,
    storage: store.storage,
    agents: [...new Set([...store.listPeers(Math.floor(Date.now() / 1000), 90).map((p) => p.agent), ...Object.keys(config.agents ?? {})])].sort(),
  })
  return
}
```

- Replace the single `auth.check` call with protocol-aware dispatch:

```js
const verdict = isV2Request(req) ? verifyV2Request(req, rawBody, config) : auth.check(req, rawBody)
if (!verdict.ok) {
  sendJson(res, verdict.status, errorBody(verdict.code, verdict.message))
  return
}
const agent = verdict.agent
```

- [ ] **Step 2: Write the failing test `test/v2-auth.test.mjs`**

```js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../broker/src/store.js'
import { createAuthenticator } from '../broker/src/auth.js'
import { createBrokerServer } from '../broker/src/server.js'
import { canonicalBody, makeSignature, SIGNATURE_HEADERS } from '../broker/src/protocol.js'

const SHARED = 'shared-secret-value'
const AGENT = 'v2test'
let server
let port

before(async () => {
  const config = {
    host: '127.0.0.1', port: 0, secret: SHARED, tls: false,
    rateLimitLoopback: 100000, rateLimitRemote: 100000, messageTtlDays: 7,
    persist: false, dataDir: mkdtempSync(join(tmpdir(), 'relay-v2auth-')),
    lockAfterFailures: 5, lockMinutes: 5, agents: {},
  }
  const store = createStore({ ttlDays: 7, persist: false, dataDir: config.dataDir })
  const auth = createAuthenticator({ secret: SHARED, lockAfterFailures: 5, lockMinutes: 5, rateLimitLoopback: 100000, rateLimitRemote: 100000 })
  server = createBrokerServer({ config, store, auth })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  rmSync(dataDir, { recursive: true, force: true })
})

function v2Headers(method, path, payload) {
  const body = canonicalBody(payload)
  const ts = String(Math.floor(Date.now() / 1000))
  const signature = makeSignature(AGENT, SHARED, method, path, ts, body)
  return {
    'content-type': 'application/json',
    [SIGNATURE_HEADERS.agent]: AGENT,
    [SIGNATURE_HEADERS.timestamp]: ts,
    [SIGNATURE_HEADERS.signature]: signature,
  }
}

test('GET /healthz is public and reports v2 protocol metadata', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/healthz`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.protocol_version, 2)
  assert.equal(body.broker, 'dsh-agent-relay')
  assert.ok(Array.isArray(body.agents))
})

test('a v2-signed request to a protected endpoint authenticates', async () => {
  const payload = { agent: AGENT, limit: 1 }
  const res = await fetch(`http://127.0.0.1:${port}/v1/pull`, {
    method: 'POST',
    headers: v2Headers('POST', '/v1/pull', payload),
    body: JSON.stringify(payload),
  })
  assert.notEqual(res.status, 401, 'v2 signature must authenticate')
})

test('a tampered v2 signature is rejected with 401', async () => {
  const payload = { agent: AGENT, limit: 1 }
  const headers = v2Headers('POST', '/v1/pull', payload)
  headers[SIGNATURE_HEADERS.signature] = '0'.repeat(64)
  const res = await fetch(`http://127.0.0.1:${port}/v1/pull`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })
  assert.equal(res.status, 401)
  assert.equal((await res.json()).error.code, 'unauthenticated')
})

test('v1 requests still authenticate with the v1 scheme', async () => {
  const { authHeaders } = await import('../lib/sign.js')
  const ts = Math.floor(Date.now() / 1000)
  const sig = authHeaders(SHARED, 'v1agent', 'GET', '/peers', '')
  const res = await fetch(`http://127.0.0.1:${port}/peers`, {
    headers: { 'x-relay-agent': 'v1agent', 'x-relay-timestamp': String(ts), 'x-relay-signature': sig['x-relay-signature'] },
  })
  assert.equal(res.status, 200)
})
```

Note: the test needs a stable `dataDir` reference for `after` cleanup — move `dataDir` to a `let` at module scope (edit the `before`/`after` accordingly).

- [ ] **Step 3: Run the test to verify it passes**

Run: `node --test test/v2-auth.test.mjs`
Expected: 4 tests PASS

- [ ] **Step 4: Run the full suite to verify no v1 regression**

Run: `node --test`
Expected: all tests pass (existing 50 + new)

- [ ] **Step 5: Commit**

```bash
git add broker/src/server.js test/v2-auth.test.mjs
git commit -m "feat(v2): authenticate v2 requests and expose GET /healthz"
```

---

### Task 4: `POST /v1/messages` (v2 message creation)

**Files:**
- Create: `broker/src/store-v2.js`
- Modify: `broker/src/server.js`
- Create: `test/v2-messages.test.mjs`

**Interfaces:**
- Consumes: `RelayMessage`, `MAX_BODY_CHARS`, `EXECUTION_MODES`, `TTL_MIN_SECONDS`, `TTL_MAX_SECONDS`, `PROTOCOL_VERSION` from `protocol.js`.
- Consumes: `config` — `agents` (per-mode ACL via `allowedTargets`; write mode disabled in Phase 1).
- Produces:
  - `createV2Store({ dataDir, persist }) -> { create(message, idempotencyKey) -> {message_id, created}, get(messageId), close }`
  - `POST /v1/messages` handler.

- [ ] **Step 1: Write `broker/src/store-v2.js`**

```js
/**
 * Transitional v2 message store (Phase 1).
 *
 * Holds v2 RelayMessage records with idempotency_key deduplication scoped to
 * (origin, idempotency_key), persisted to dataDir/relay-v2.jsonl. This is a
 * stepping stone: Phase 2 merges v2 into the unified store that also serves
 * pull/ack/status, after which this file is deleted.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export function createV2Store({ dataDir, persist = true }) {
  const messages = new Map() // message_id -> record
  const byIdempotency = new Map() // `${origin}\u0000${key}` -> message_id
  const path = join(dataDir, 'relay-v2.jsonl')

  function idemKey(origin, key) {
    return `${origin}\u0000${key}`
  }

  function load() {
    if (!persist || !existsSync(path)) return
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean)) {
      try {
        const rec = JSON.parse(line)
        messages.set(rec.message.message_id, rec.message)
        if (rec.message.idempotency_key) {
          byIdempotency.set(idemKey(rec.message.origin, rec.message.idempotency_key), rec.message.message_id)
        }
      } catch { /* skip corrupt line */ }
    }
  }

  function persistAll() {
    if (!persist) return
    mkdirSync(dataDir, { recursive: true })
    const lines = [...messages.values()].map((message) => JSON.stringify({ message }))
    writeFileSync(path, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8')
  }

  function create(message, idempotencyKey) {
    const existing = byIdempotency.get(idemKey(message.origin, idempotencyKey))
    if (existing) return { message_id: existing, created: false }
    const record = { ...message, idempotency_key: idempotencyKey, status: 'queued', attempts: 0 }
    messages.set(record.message_id, record)
    byIdempotency.set(idemKey(record.origin, idempotencyKey), record.message_id)
    if (persist) {
      mkdirSync(dataDir, { recursive: true })
      appendFileSync(path, JSON.stringify({ message: record }) + '\n', 'utf8')
    }
    return { message_id: record.message_id, created: true }
  }

  function get(messageId) {
    return messages.get(String(messageId)) ?? null
  }

  function close() {}

  load()
  return { create, get, close }
}
```

- [ ] **Step 2: Add the `POST /v1/messages` handler to `broker/src/server.js`**

Add to the imports: `import { createV2Store } from './store-v2.js'` and from protocol.js: `RelayMessage`, `MAX_BODY_CHARS as V2_MAX_BODY`, `EXECUTION_MODES as V2_MODES`, `TTL_MIN_SECONDS as V2_TTL_MIN`, `TTL_MAX_SECONDS as V2_TTL_MAX`, `PROTOCOL_VERSION as V2_VERSION`.

Change `createBrokerServer` signature to accept an optional `storeV2`:

```js
export function createBrokerServer({ config, store, auth, storeV2 = createV2Store({ dataDir: config.dataDir, persist: config.persist }) }) {
```

Add the v2 message route (place it next to the other v1 routes, after `/v1/messages/query`):

```js
if (req.method === 'POST' && path === '/v1/messages') {
  const parsed = parseJsonObject(rawBody)
  if (!parsed) {
    sendJson(res, 400, errorBody('bad_request', 'body must be a JSON object'))
    return
  }
  const origin = String(parsed.origin || '').trim().toLowerCase()
  const target = String(parsed.target || '').trim().toLowerCase()
  const kind = String(parsed.kind || '').trim().toLowerCase()
  const body = String(parsed.body || '').trim()
  const sessionRef = String(parsed.session_ref || '').slice(0, 300)
  const idempotencyKey = String(parsed.idempotency_key || '').trim().slice(0, 120)
  const parentId = parsed.parent_id ? String(parsed.parent_id).trim() : null
  const executionMode = String(parsed.execution_mode || 'read').trim().toLowerCase()
  if (origin !== agent) {
    sendJson(res, 403, errorBody('forbidden', 'origin does not match authenticated agent'))
    return
  }
  if (kind !== 'request' && kind !== 'reply') {
    sendJson(res, 400, errorBody('bad_request', 'invalid message kind'))
    return
  }
  if (!body || body.length > V2_MAX_BODY || !idempotencyKey) {
    sendJson(res, 400, errorBody('bad_request', 'message body or idempotency key is invalid'))
    return
  }
  const now = Date.now() / 1000
  const requestedTtl = Number(parsed.ttl_seconds) || 3600
  const ttl = Math.max(V2_TTL_MIN, Math.min(requestedTtl, V2_TTL_MAX))
  const topic = String(parsed.topic || '').slice(0, 200)
  let rootId = parsed.root_id ? String(parsed.root_id) : null
  let sessionRefFinal = sessionRef
  let executionModeFinal = executionMode
  let topicFinal = topic
  if (kind === 'request') {
    if (!V2_MODES.includes(executionMode)) {
      sendJson(res, 400, errorBody('bad_request', 'execution_mode must be read, continue, or write'))
      return
    }
    if (executionMode === 'write') {
      // Phase 1: workspace isolation / write lease not built yet — refuse.
      sendJson(res, 403, errorBody('forbidden', 'write mode is not enabled yet'))
      return
    }
    if (!config.agents?.[target] && target !== origin) {
      // Unknown recipient: the target must be a configured agent or yourself-check below.
    }
    const allowed = config.agents?.[origin]?.allowedTargets
    if (allowed && !allowed.includes(target)) {
      sendJson(res, 403, errorBody('forbidden', `target is not allowed for ${executionMode} mode`))
      return
    }
    rootId = rootId ?? cryptoRandomHex()
  } else {
    if (!parentId) {
      sendJson(res, 400, errorBody('bad_request', 'reply requires parent_id'))
      return
    }
    const parent = storeV2.get(parentId)
    if (!parent) {
      sendJson(res, 404, errorBody('no_such_message', 'parent relay message was not found'))
      return
    }
    if (parent.target !== origin || parent.origin !== target) {
      sendJson(res, 403, errorBody('forbidden', 'reply is not authorized for this message'))
      return
    }
    rootId = parent.root_id
    sessionRefFinal = parent.session_ref
    executionModeFinal = parent.execution_mode
    topicFinal = parent.topic
  }
  const message = new RelayMessage({
    message_id: cryptoRandomHex(),
    root_id: rootId,
    parent_id: parentId,
    origin,
    target,
    kind,
    body,
    session_ref: sessionRefFinal,
    created_at: now,
    expires_at: now + ttl,
    execution_mode: executionModeFinal,
    context: String(parsed.context || '').slice(0, V2_MAX_BODY),
    topic: topicFinal,
  })
  const { message_id, created } = storeV2.create(message, idempotencyKey)
  sendJson(res, 200, { message_id, created, protocol_version: V2_VERSION })
  return
}
```

Add a `cryptoRandomHex` helper near the top of server.js (or import `randomUUID` from `node:crypto` and use it for `message_id`/`root_id` — the self-use uses `uuid.uuid4().hex` which is a 32-char hex; `randomUUID()` returns a dashed UUID. For wire compatibility the id format is opaque, but to match self-use, use a 32-hex helper). Add:

```js
function cryptoRandomHex(bytes = 16) {
  return randomBytes(bytes).toString('hex')
}
```

(import `randomBytes` from `node:crypto`)

- [ ] **Step 3: Write `test/v2-messages.test.mjs`**

```js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../broker/src/store.js'
import { createAuthenticator } from '../broker/src/auth.js'
import { createBrokerServer } from '../broker/src/server.js'
import { createV2Store } from '../broker/src/store-v2.js'
import { canonicalBody, makeSignature, SIGNATURE_HEADERS } from '../broker/src/protocol.js'

const SHARED = 'shared-secret-value'
const AGENT = 'v2msg'
const DATA_DIR = mkdtempSync(join(tmpdir(), 'relay-v2msg-'))
let server
let port
let v2Store

before(async () => {
  const config = {
    host: '127.0.0.1', port: 0, secret: SHARED, tls: false,
    rateLimitLoopback: 100000, rateLimitRemote: 100000, messageTtlDays: 7,
    persist: false, dataDir: DATA_DIR, lockAfterFailures: 5, lockMinutes: 5,
    agents: { [AGENT]: { secret: SHARED, allowedTargets: ['peer'] } },
  }
  const store = createStore({ ttlDays: 7, persist: false, dataDir: DATA_DIR })
  const auth = createAuthenticator({ secret: SHARED, lockAfterFailures: 5, lockMinutes: 5, rateLimitLoopback: 100000, rateLimitRemote: 100000 })
  v2Store = createV2Store({ dataDir: DATA_DIR, persist: false })
  server = createBrokerServer({ config, store, auth, storeV2: v2Store })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  v2Store.close()
  rmSync(DATA_DIR, { recursive: true, force: true })
})

function postV2(payload) {
  const body = canonicalBody(payload)
  const ts = String(Math.floor(Date.now() / 1000))
  const signature = makeSignature(AGENT, SHARED, 'POST', '/v1/messages', ts, body)
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [SIGNATURE_HEADERS.agent]: AGENT, [SIGNATURE_HEADERS.timestamp]: ts, [SIGNATURE_HEADERS.signature]: signature },
    body,
  })
}

test('creates a v2 request and returns a message_id', async () => {
  const res = await postV2({
    origin: AGENT, target: 'peer', kind: 'request', body: 'please review',
    session_ref: AGENT, idempotency_key: 'v2msg:1', ttl_seconds: 3600, execution_mode: 'read',
  })
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.created, true)
  assert.match(data.message_id, /^[0-9a-f]{32}$/)
  assert.equal(data.protocol_version, 2)
  assert.ok(v2Store.get(data.message_id))
})

test('duplicate idempotency_key returns the same message_id with created=false', async () => {
  const first = await (await postV2({
    origin: AGENT, target: 'peer', kind: 'request', body: 'please review',
    session_ref: AGENT, idempotency_key: 'v2msg:dup', ttl_seconds: 3600, execution_mode: 'read',
  })).json()
  const second = await (await postV2({
    origin: AGENT, target: 'peer', kind: 'request', body: 'please review',
    session_ref: AGENT, idempotency_key: 'v2msg:dup', ttl_seconds: 3600, execution_mode: 'read',
  })).json()
  assert.equal(second.message_id, first.message_id)
  assert.equal(second.created, false)
})

test('invalid kind is rejected', async () => {
  const res = await postV2({
    origin: AGENT, target: 'peer', kind: 'nonsense', body: 'x',
    session_ref: AGENT, idempotency_key: 'v2msg:badkind', ttl_seconds: 3600, execution_mode: 'read',
  })
  assert.equal(res.status, 400)
})

test('write mode is refused in Phase 1', async () => {
  const res = await postV2({
    origin: AGENT, target: 'peer', kind: 'request', body: 'please edit',
    session_ref: AGENT, idempotency_key: 'v2msg:write', ttl_seconds: 3600, execution_mode: 'write',
  })
  assert.equal(res.status, 403)
})

test('reply without a parent is rejected', async () => {
  const res = await postV2({
    origin: AGENT, target: 'peer', kind: 'reply', body: 'done',
    session_ref: AGENT, idempotency_key: 'v2msg:reply', ttl_seconds: 300, parent_id: 'doesnotexist',
  })
  assert.equal(res.status, 404)
})

test('ACL: disallowed target is rejected', async () => {
  const res = await postV2({
    origin: AGENT, target: 'stranger', kind: 'request', body: 'hi',
    session_ref: AGENT, idempotency_key: 'v2msg:acl', ttl_seconds: 3600, execution_mode: 'read',
  })
  assert.equal(res.status, 403)
})
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/v2-messages.test.mjs`
Expected: 6 tests PASS

- [ ] **Step 5: Run the full suite + commit**

Run: `node --test`
Expected: all tests pass

```bash
git add broker/src/store-v2.js broker/src/server.js test/v2-messages.test.mjs
git commit -m "feat(v2): POST /v1/messages with idempotent creation via the transitional v2 store"
```

---

### Task 5: `docs/PROTOCOL-V2.md`

**Files:**
- Create: `docs/PROTOCOL-V2.md`

- [ ] **Step 1: Write the normative spec**

Document: transport/conventions; message envelope (all v2 fields, snake_case, types); canonical body (sort_keys, compact, ensure_ascii=False — with a worked example); signature string + headers; auth (per-agent secret resolution, clock skew 300s, error codes); endpoints (`GET /healthz`, `POST /v1/messages` with request/reply rules, TTL clamp, idempotency, ACL and the Phase-1 write-mode refusal); error table; versioning note that this wire format is byte-compatible with the self-use broker and that `protocol_version: 2` is reported.

- [ ] **Step 2: Commit**

```bash
git add docs/PROTOCOL-V2.md
git commit -m "docs(v2): normative wire protocol spec for the v2 format"
```

---

## Self-Review

**Spec coverage:**
- v2 canonical body + signature byte-compat → Task 1 (golden vectors from real self-use protocol.py).
- Cross-language consistency (JS vs Python) → Task 2.
- v2 auth (headers, per-agent secret, skew) → Task 3.
- `GET /healthz` → Task 3.
- `POST /v1/messages` (request/reply, idempotency, ACL, TTL) → Task 4.
- v1 compatibility preserved → Task 3 (v1 auth still works) + full-suite runs in Tasks 2/3/4.
- `docs/PROTOCOL-V2.md` → Task 5.

**Placeholder scan:** No TBD/TODO; every step has concrete code.

**Type consistency:** `canonicalBody(payload) -> Buffer`, `makeSignature(agent, secret, method, path, timestamp, body) -> string`, `verifySignature(...) -> boolean`; `createV2Store({dataDir, persist}) -> {create, get, close}`; `POST /v1/messages` returns `{message_id, created, protocol_version}` — consistent across tasks.

## Execution Handoff

Plan complete. After execution: Phase 2 (unified store + state machine + pull/ack/status for v2) follows this same repo.
