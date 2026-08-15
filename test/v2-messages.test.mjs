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
    agents: { [AGENT]: { allowedTargets: ['peer'] } },
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
    headers: {
      'content-type': 'application/json',
      [SIGNATURE_HEADERS.agent]: AGENT,
      [SIGNATURE_HEADERS.timestamp]: ts,
      [SIGNATURE_HEADERS.signature]: signature,
    },
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
  const payload = {
    origin: AGENT, target: 'peer', kind: 'request', body: 'please review',
    session_ref: AGENT, idempotency_key: 'v2msg:dup', ttl_seconds: 3600, execution_mode: 'read',
  }
  const first = await (await postV2(payload)).json()
  const second = await (await postV2(payload)).json()
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

test('a valid reply to an existing parent inherits root/session/mode/topic', async () => {
  const created = await (await postV2({
    origin: AGENT, target: 'peer', kind: 'request', body: 'please review X',
    session_ref: 'sess-1', idempotency_key: 'v2msg:parent', ttl_seconds: 3600, execution_mode: 'read', topic: 'review-x',
  })).json()
  const parent = v2Store.get(created.message_id)
  assert.ok(parent)

  // Reply as 'peer' (unconfigured agent falls back to the shared secret).
  const replyPayload = {
    origin: 'peer', target: AGENT, kind: 'reply', body: 'done',
    session_ref: 'sess-1', idempotency_key: 'reply:' + created.message_id, ttl_seconds: 300,
    parent_id: created.message_id,
  }
  const replyBody = canonicalBody(replyPayload)
  const ts = String(Math.floor(Date.now() / 1000))
  const sig = makeSignature('peer', SHARED, 'POST', '/v1/messages', ts, replyBody)
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [SIGNATURE_HEADERS.agent]: 'peer',
      [SIGNATURE_HEADERS.timestamp]: ts,
      [SIGNATURE_HEADERS.signature]: sig,
    },
    body: replyBody,
  })
  assert.equal(res.status, 200)
  const replyData = await res.json()
  const stored = v2Store.get(replyData.message_id)
  assert.equal(stored.root_id, parent.root_id)
  assert.equal(stored.session_ref, parent.session_ref)
  assert.equal(stored.execution_mode, parent.execution_mode)
  assert.equal(stored.topic, parent.topic)
})

test('store-v2 persists across restarts and preserves idempotency', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-v2persist-'))
  const now = Date.now() / 1000
  try {
    const first = createV2Store({ dataDir: dir, persist: true })
    const created = first.create(
      {
        message_id: 'a'.repeat(32), root_id: 'b'.repeat(32), parent_id: null,
        origin: 'alpha', target: 'beta', kind: 'request', body: 'persist me',
        session_ref: 's', created_at: now, expires_at: now + 3600, execution_mode: 'read',
      },
      'alpha:key1',
    )
    assert.equal(created.created, true)
    first.close()

    const second = createV2Store({ dataDir: dir, persist: true })
    assert.ok(second.get(created.message_id), 'message must survive restart')
    assert.equal(second.get(created.message_id).body, 'persist me')
    // The same idempotency key must still dedupe after reload.
    const dup = second.create(
      {
        message_id: 'c'.repeat(32), root_id: 'd'.repeat(32), parent_id: null,
        origin: 'alpha', target: 'beta', kind: 'request', body: 'persist me',
        session_ref: 's', created_at: now, expires_at: now + 3600, execution_mode: 'read',
      },
      'alpha:key1',
    )
    assert.equal(dup.message_id, created.message_id)
    assert.equal(dup.created, false)
    second.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
