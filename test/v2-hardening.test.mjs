/**
 * Regression tests for the v2 hardening fixes:
 *   - ack is only valid while a message is leased (no terminal resurrection)
 *   - admin requeue/cancel require originator-or-recipient membership
 *   - the idempotency index is pruned together with retention purges
 *   - sqlite lifecycle transitions persist correctly across store restarts
 */
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
const ALICE = 'alice'
const BOB = 'bob'
const MALLORY = 'mallory'
const DATA_DIR = mkdtempSync(join(tmpdir(), 'relay-v2hard-'))
let server
let port

function v2Headers(agent, method, path, payload) {
  const body = canonicalBody(payload)
  const ts = String(Math.floor(Date.now() / 1000))
  const signature = makeSignature(agent, SHARED, method, path, ts, body)
  return {
    'content-type': 'application/json',
    [SIGNATURE_HEADERS.agent]: agent,
    [SIGNATURE_HEADERS.timestamp]: ts,
    [SIGNATURE_HEADERS.signature]: signature,
  }
}

async function post(agent, path, payload) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: v2Headers(agent, 'POST', path, payload),
    body: canonicalBody(payload),
  })
}

async function sendRequest(from, to, key) {
  const res = await post(from, '/v1/messages', {
    origin: from, target: to, kind: 'request', body: 'hello',
    session_ref: '', idempotency_key: key, ttl_seconds: 3600, execution_mode: 'read',
  })
  assert.equal(res.status, 200)
  return (await res.json()).message_id
}

before(async () => {
  const config = {
    host: '127.0.0.1', port: 0, secret: SHARED,
    rateLimitLoopback: 100000, rateLimitRemote: 100000, messageTtlDays: 7,
    persist: false, dataDir: DATA_DIR,
    lockAfterFailures: 5, lockMinutes: 5, agents: {},
  }
  const store = createStore({ ttlDays: 7, persist: false, dataDir: DATA_DIR })
  const auth = createAuthenticator({ secret: SHARED, lockAfterFailures: 5, lockMinutes: 5, rateLimitLoopback: 100000, rateLimitRemote: 100000 })
  server = createBrokerServer({ config, store, auth })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  rmSync(DATA_DIR, { recursive: true, force: true })
})

test('a duplicated ack on a completed message is rejected, not resurrected', async () => {
  const id = await sendRequest(ALICE, BOB, 'hard-ack-1')
  const pulled = await post(BOB, '/v1/pull', { agent: BOB, limit: 8 })
  assert.equal(pulled.status, 200)
  assert.ok((await pulled.json()).messages.some((m) => m.message_id === id))

  const first = await post(BOB, '/v1/ack', { agent: BOB, message_id: id, outcome: 'completed' })
  assert.equal(first.status, 200)

  // A late retry ack (e.g. after a redelivery was acked mid-flight) must not
  // move the completed message back to queued.
  const second = await post(BOB, '/v1/ack', { agent: BOB, message_id: id, outcome: 'retry', error: 'late failure' })
  assert.equal(second.status, 400)
  assert.equal((await second.json()).error.code, 'bad_request')

  const status = await post(ALICE, '/v1/status', { agent: ALICE, message_ids: [id] })
  const row = (await status.json()).messages[0]
  assert.equal(row.status, 'completed')
})

test('admin requeue/cancel are restricted to the originator or recipient', async () => {
  const cancellable = await sendRequest(ALICE, BOB, 'hard-admin-1')
  const denied = await post(MALLORY, '/v1/admin/cancel', { agent: MALLORY, message_id: cancellable })
  assert.equal(denied.status, 403)
  assert.equal((await denied.json()).error.code, 'forbidden')
  const allowed = await post(ALICE, '/v1/admin/cancel', { agent: ALICE, message_id: cancellable })
  assert.equal(allowed.status, 200)

  const requeueable = await sendRequest(ALICE, BOB, 'hard-admin-2')
  const deniedRequeue = await post(MALLORY, '/v1/admin/requeue', { agent: MALLORY, message_id: requeueable })
  assert.equal(deniedRequeue.status, 403)
  // Recipient may requeue their own leased message.
  const pulled = await post(BOB, '/v1/pull', { agent: BOB, limit: 8 })
  assert.ok((await pulled.json()).messages.some((m) => m.message_id === requeueable))
  const byRecipient = await post(BOB, '/v1/admin/requeue', { agent: BOB, message_id: requeueable })
  assert.equal(byRecipient.status, 200)

  // Unknown message ids still 404 for members.
  const missing = await post(ALICE, '/v1/admin/cancel', { agent: ALICE, message_id: 'does-not-exist' })
  assert.equal(missing.status, 404)
})

test('idempotency keys are reusable after retention purges (index pruned with rows)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-v2idem-'))
  try {
    const s = createV2Store({ dataDir: dir, persist: true, leaseSeconds: 600, maxAttempts: 3 })
    const now = Date.now() / 1000
    const msg = { message_id: 'm-idem-1', root_id: 'r1', parent_id: null, origin: 'alpha', target: 'beta', kind: 'request', body: 'x', session_ref: '', created_at: now, expires_at: now + 3600, execution_mode: 'read', context: '', topic: '' }
    const first = s.create(msg, 'idem-key')
    assert.equal(first.created, true)
    s.pull('beta', now, { limit: 5 })
    s.ack('m-idem-1', 'beta', 'completed', null, now)
    // Not yet purged: the key still dedupes.
    assert.equal(s.create({ ...msg, message_id: 'm-idem-2' }, 'idem-key').created, false)
    // Past the 30-day retention the row and its index entry are gone.
    s.cleanup(now + 31 * 86400)
    assert.equal(s.get('m-idem-1'), null)
    assert.equal(s.create({ ...msg, message_id: 'm-idem-3' }, 'idem-key').created, true)
    s.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sqlite lifecycle transitions persist across store restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-v2persist-'))
  try {
    const now = Date.now() / 1000
    const s1 = createV2Store({ dataDir: dir, persist: true, leaseSeconds: 600, maxAttempts: 3 })
    s1.create({ message_id: 'm-p-1', root_id: 'r1', parent_id: null, origin: 'alpha', target: 'beta', kind: 'request', body: 'x', session_ref: '', created_at: now, expires_at: now + 3600, execution_mode: 'read', context: '', topic: '' }, 'idem-p1')
    const leased = s1.pull('beta', now, { limit: 5 })
    assert.equal(leased.length, 1)
    s1.close()

    const s2 = createV2Store({ dataDir: dir, persist: true, leaseSeconds: 600, maxAttempts: 3 })
    const m = s2.get('m-p-1')
    assert.equal(m.status, 'leased')
    assert.equal(m.attempts, 1)
    s2.ack('m-p-1', 'beta', 'completed', null, now + 1)
    s2.close()

    const s3 = createV2Store({ dataDir: dir, persist: true, leaseSeconds: 600, maxAttempts: 3 })
    assert.equal(s3.get('m-p-1').status, 'completed')
    assert.throws(() => s3.ack('m-p-1', 'beta', 'retry', 'late', now + 2), /not currently leased/)
    s3.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
