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
const DATA_DIR = mkdtempSync(join(tmpdir(), 'relay-v2life-'))
let server
let port
let v2Store

before(async () => {
  const config = {
    host: '127.0.0.1', port: 0, secret: SHARED, tls: false,
    rateLimitLoopback: 100000, rateLimitRemote: 100000, messageTtlDays: 7,
    persist: false, dataDir: DATA_DIR, lockAfterFailures: 5, lockMinutes: 5,
    leaseSeconds: 600, maxAttempts: 1, agents: {},
  }
  const store = createStore({ ttlDays: 7, persist: false, dataDir: DATA_DIR })
  const auth = createAuthenticator({ secret: SHARED, lockAfterFailures: 5, lockMinutes: 5, rateLimitLoopback: 100000, rateLimitRemote: 100000 })
  v2Store = createV2Store({ dataDir: DATA_DIR, persist: false, leaseSeconds: 600, maxAttempts: 1 })
  server = createBrokerServer({ config, store, auth, storeV2: v2Store })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  v2Store.close()
  rmSync(DATA_DIR, { recursive: true, force: true })
})

function v2Fetch(agent, method, path, payload) {
  const body = canonicalBody(payload)
  const ts = String(Math.floor(Date.now() / 1000))
  const signature = makeSignature(agent, SHARED, method, path, ts, body)
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      [SIGNATURE_HEADERS.agent]: agent,
      [SIGNATURE_HEADERS.timestamp]: ts,
      [SIGNATURE_HEADERS.signature]: signature,
    },
    body,
  })
}

async function createRequest(origin, target, body, key) {
  const res = await v2Fetch(origin, 'POST', '/v1/messages', {
    origin, target, kind: 'request', body, session_ref: origin,
    idempotency_key: key, ttl_seconds: 3600, execution_mode: 'read',
  })
  assert.equal(res.status, 200)
  return (await res.json()).message_id
}

async function pull(agent) {
  const res = await v2Fetch(agent, 'POST', '/v1/pull', { agent, limit: 5 })
  assert.equal(res.status, 200)
  return (await res.json()).messages
}

async function ack(agent, messageId, outcome, error) {
  const payload = { agent, message_id: messageId, outcome }
  if (error) payload.error = error
  return v2Fetch(agent, 'POST', '/v1/ack', payload)
}

test('full lifecycle: create → pull(leased) → ack completed → status completed', async () => {
  const messageId = await createRequest('alpha', 'beta', 'please review the diff', 'life:1')
  let messages = await pull('beta')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].message_id, messageId)
  assert.equal(messages[0].origin, 'alpha')
  assert.equal(messages[0].execution_mode, 'read')
  assert.equal(v2Store.get(messageId).status, 'leased')

  const ackRes = await ack('beta', messageId, 'completed')
  assert.equal(ackRes.status, 200)
  assert.equal(v2Store.get(messageId).status, 'completed')

  const status = await (await v2Fetch('beta', 'POST', '/v1/status', { agent: 'beta', message_ids: [messageId] })).json()
  assert.equal(status.messages[0].status, 'completed')
  // A completed message must not be pulled again.
  assert.equal((await pull('beta')).length, 0)
})

test('retry re-queues; exceeding maxAttempts marks failed; admin requeue revives', async () => {
  const messageId = await createRequest('alpha', 'beta', 'do it twice', 'life:retry')
  await pull('beta')
  // maxAttempts = 1: the pull already incremented attempts to 1, so a retry
  // ack pushes it to failed.
  const retryRes = await ack('beta', messageId, 'retry', 'worker crashed')
  assert.equal(retryRes.status, 200)
  assert.equal(v2Store.get(messageId).status, 'failed')

  // requeue (admin) revives it to queued with attempts reset.
  const reqRes = await v2Fetch('beta', 'POST', '/v1/admin/requeue', { agent: 'beta', message_id: messageId })
  assert.equal(reqRes.status, 200)
  assert.equal(v2Store.get(messageId).status, 'queued')
  const again = await pull('beta')
  assert.equal(again.length, 1)
  assert.equal(again[0].message_id, messageId)
})

test('only the recipient may ack; a sender ack is forbidden', async () => {
  const messageId = await createRequest('alpha', 'beta', 'private', 'life:auth')
  await pull('beta')
  const badAck = await ack('alpha', messageId, 'completed')
  assert.equal(badAck.status, 403)
  assert.equal(v2Store.get(messageId).status, 'leased')
})

test('recent lists messages the agent was involved in; query filters by kind', async () => {
  await createRequest('alpha', 'beta', 'for recent', 'life:recent')
  const recent = await (await v2Fetch('alpha', 'POST', '/v1/recent', { agent: 'alpha', limit: 10 })).json()
  assert.ok(recent.messages.some((m) => m.kind === 'request'))
  const query = await (await v2Fetch('beta', 'POST', '/v1/messages/query', { agent: 'beta', kind: 'request', limit: 10 })).json()
  assert.ok(query.messages.some((m) => m.target === 'beta'))
  // An agent must not see messages it is not party to.
  const stranger = await (await v2Fetch('stranger', 'POST', '/v1/messages/query', { agent: 'stranger', limit: 10 })).json()
  assert.equal(stranger.messages.length, 0)
})

test('cancel marks a queued message completed and stops delivery', async () => {
  const messageId = await createRequest('alpha', 'beta', 'cancel me', 'life:cancel')
  const cancelRes = await v2Fetch('alpha', 'POST', '/v1/admin/cancel', { agent: 'alpha', message_id: messageId })
  assert.equal(cancelRes.status, 200)
  assert.equal(v2Store.get(messageId).status, 'completed')
  const after = await pull('beta')
  assert.ok(!after.some((m) => m.message_id === messageId), 'cancelled message must not be delivered')
})

test('store-v2 cleanup: past expires_at becomes expired; expired lease re-queues', () => {
  const now = Date.now() / 1000
  const expiredId = v2Store.create(
    {
      message_id: 'e'.repeat(32), root_id: 'f'.repeat(32), parent_id: null,
      origin: 'alpha', target: 'beta', kind: 'request', body: 'too late',
      session_ref: 's', created_at: now - 7200, expires_at: now - 3600, execution_mode: 'read',
    },
    'life:expired',
  ).message_id
  const leasedId = v2Store.create(
    {
      message_id: 'g'.repeat(32), root_id: 'h'.repeat(32), parent_id: null,
      origin: 'alpha', target: 'beta', kind: 'request', body: 'lease ran out',
      session_ref: 's', created_at: now, expires_at: now + 3600, execution_mode: 'read',
    },
    'life:leasere',
  ).message_id
  // Manually lease the second message with an expired lease.
  const leased = v2Store.get(leasedId)
  leased.status = 'leased'
  leased.lease_until = now - 10
  v2Store.cleanup(now)
  assert.equal(v2Store.get(expiredId).status, 'expired')
  assert.equal(v2Store.get(leasedId).status, 'queued')
  assert.equal(v2Store.get(leasedId).lease_until, null)
})
