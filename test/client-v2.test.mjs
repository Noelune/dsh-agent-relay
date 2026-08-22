import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../broker/src/store.js'
import { createAuthenticator } from '../broker/src/auth.js'
import { createBrokerServer } from '../broker/src/server.js'
import { createV2Store } from '../broker/src/store-v2.js'
import { RelayClientV2 } from '../lib/client-v2.js'

const SHARED = 'shared-secret-value'
const DATA_DIR = mkdtempSync(join(tmpdir(), 'relay-cv2-'))
let server
let port
let v2Store

before(async () => {
  const config = {
    host: '127.0.0.1', port: 0, secret: SHARED, tls: false,
    rateLimitLoopback: 100000, rateLimitRemote: 100000, messageTtlDays: 7,
    persist: false, dataDir: DATA_DIR, lockAfterFailures: 5, lockMinutes: 5,
    leaseSeconds: 600, maxAttempts: 3, notifyFailedToSender: true, agents: {},
  }
  const store = createStore({ ttlDays: 7, persist: false, dataDir: DATA_DIR })
  const auth = createAuthenticator({ secret: SHARED, lockAfterFailures: 5, lockMinutes: 5, rateLimitLoopback: 100000, rateLimitRemote: 100000 })
  v2Store = createV2Store({ dataDir: DATA_DIR, persist: false, leaseSeconds: 600, maxAttempts: 3 })
  server = createBrokerServer({ config, store, auth, storeV2: v2Store })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  v2Store.close()
  rmSync(DATA_DIR, { recursive: true, force: true })
})

const base = () => ({ endpoint: `http://127.0.0.1:${port}`, secret: SHARED })

test('RelayClientV2: health reports the protocol version', async () => {
  const alpha = new RelayClientV2({ ...base(), agent: 'alpha' })
  const health = await alpha.health()
  assert.equal(health.ok, true)
  assert.equal(health.protocol_version, 3)
  assert.ok(Array.isArray(health.agents))
})

test('RelayClientV2: sendRequest → pull → ack completed → status', async () => {
  const alpha = new RelayClientV2({ ...base(), agent: 'alpha' })
  const beta = new RelayClientV2({ ...base(), agent: 'beta' })
  const messageId = await alpha.sendRequest({
    target: 'beta', body: 'please review this change', sessionRef: 'alpha',
    idempotencyKey: 'cv2:1', ttlSeconds: 3600, executionMode: 'read',
  })
  assert.match(messageId, /^[0-9a-f]{32}$/)

  const messages = await beta.pull({ limit: 5 })
  assert.equal(messages.length, 1)
  assert.equal(messages[0].message_id, messageId)
  assert.equal(messages[0].origin, 'alpha')
  assert.equal(messages[0].execution_mode, 'read')

  await beta.ack(messageId, 'completed')
  const status = await alpha.status([messageId])
  assert.equal(status[0].status, 'completed')
})

test('RelayClientV2: reply inherits root/session and is delivered to the requester', async () => {
  const alpha = new RelayClientV2({ ...base(), agent: 'alpha' })
  const beta = new RelayClientV2({ ...base(), agent: 'beta' })
  const messageId = await alpha.sendRequest({
    target: 'beta', body: 'verify the edge case', sessionRef: 'sess-9',
    idempotencyKey: 'cv2:reply-req', ttlSeconds: 3600, executionMode: 'read', topic: 'edge',
  })
  const [incoming] = await beta.pull({ limit: 5 })
  const replyId = await beta.sendReply(incoming, 'verified, no edge issue', `reply:${messageId}`)
  assert.match(replyId, /^[0-9a-f]{32}$/)
  const inbox = await alpha.pull({ limit: 5 })
  const reply = inbox.find((m) => m.message_id === replyId)
  assert.ok(reply, 'requester must receive the reply')
  assert.equal(reply.parent_id, messageId)
  assert.equal(reply.kind, 'reply')
  assert.equal(reply.topic, 'edge')
})

test('RelayClientV2: query filters and admin helpers work', async () => {
  const alpha = new RelayClientV2({ ...base(), agent: 'alpha' })
  const beta = new RelayClientV2({ ...base(), agent: 'beta' })
  const messageId = await alpha.sendRequest({
    target: 'beta', body: 'queryable request', sessionRef: 'alpha',
    idempotencyKey: 'cv2:query', ttlSeconds: 3600, executionMode: 'read',
  })
  const found = await beta.query({ kind: 'request', target: 'beta' })
  assert.ok(found.some((m) => m.message_id === messageId))
  const recent = await alpha.recent(10)
  assert.ok(recent.some((m) => m.message_id === messageId))
  const admin = await beta.adminStatus(10)
  assert.ok(admin.some((m) => m.message_id === messageId))
})
