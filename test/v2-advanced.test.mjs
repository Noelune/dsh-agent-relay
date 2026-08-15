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
const DATA_DIR = mkdtempSync(join(tmpdir(), 'relay-v2adv-'))
let server
let port
let v2Store

before(async () => {
  const config = {
    host: '127.0.0.1', port: 0, secret: SHARED, tls: false,
    rateLimitLoopback: 100000, rateLimitRemote: 100000, messageTtlDays: 7,
    persist: false, dataDir: DATA_DIR, lockAfterFailures: 5, lockMinutes: 5,
    leaseSeconds: 600, maxAttempts: 1, notifyFailedToSender: true,
    agents: {
      alpha: {
        allowedReadTargets: ['beta'],
        allowedContinueTargets: ['beta'],
        allowedWriteTargets: ['gamma'],
      },
      // 'free' has no entry → permissive (may send to anyone)
    },
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

async function create(origin, target, mode, body, key) {
  const res = await v2Fetch(origin, 'POST', '/v1/messages', {
    origin, target, kind: 'request', body, session_ref: origin,
    idempotency_key: key, ttl_seconds: 3600, execution_mode: mode,
  })
  return res
}

async function pull(agent) {
  const res = await v2Fetch(agent, 'POST', '/v1/pull', { agent, limit: 10 })
  return (await res.json()).messages
}

async function ack(agent, messageId, outcome, error) {
  const payload = { agent, message_id: messageId, outcome }
  if (error) payload.error = error
  return v2Fetch(agent, 'POST', '/v1/ack', payload)
}

test('per-mode ACL: read to an allowed target succeeds', async () => {
  const res = await create('alpha', 'beta', 'read', 'review the diff', 'acl:read-ok')
  assert.equal(res.status, 200)
})

test('per-mode ACL: read to a target not in allowed_read_targets is forbidden', async () => {
  const res = await create('alpha', 'stranger', 'read', 'hi', 'acl:read-deny')
  assert.equal(res.status, 403)
})

test('per-mode ACL: write to an allowed_write_target succeeds', async () => {
  const res = await create('alpha', 'gamma', 'write', 'please edit workspace', 'acl:write-ok')
  assert.equal(res.status, 200)
})

test('per-mode ACL: write to a target not in allowed_write_targets is forbidden', async () => {
  const res = await create('alpha', 'beta', 'write', 'please edit', 'acl:write-deny')
  assert.equal(res.status, 403)
})

test('per-mode ACL: an agent without a config entry may send to anyone', async () => {
  const res = await create('free', 'whoever', 'read', 'ping', 'acl:free')
  assert.equal(res.status, 200)
})

test('per-mode ACL: write is closed for an agent without a config entry', async () => {
  const res = await create('free', 'whoever', 'write', 'please edit', 'acl:free-write')
  assert.equal(res.status, 403)
})

test('per-mode ACL: continue uses the continue whitelist', async () => {
  // alpha allowed_continue_targets = ['beta']; 'gamma' is only in write targets.
  const ok = await create('alpha', 'beta', 'continue', 'continue on it', 'acl:cont-ok')
  assert.equal(ok.status, 200)
  const denied = await create('alpha', 'gamma', 'continue', 'continue there', 'acl:cont-deny')
  assert.equal(denied.status, 403)
})

test('notify_failed_to_sender: a failed request delivers an undelivered notice', async () => {
  const created = await create('reqr', 'worker', 'read', 'please verify X', 'notify:1')
  const messageId = (await created.json()).message_id
  await pull('worker') // worker leases it (attempts → 1)
  const retry = await ack('worker', messageId, 'retry', 'worker crashed')
  assert.equal(retry.status, 200)
  // maxAttempts = 1 → the request is now failed and a notice was queued to reqr.
  const inbox = await pull('reqr')
  const notice = inbox.find((m) => m.kind === 'reply' && m.parent_id === messageId)
  assert.ok(notice, 'sender must receive an undelivered notice')
  assert.ok(notice.body.includes('未能送达'))
  assert.equal(notice.origin, 'worker')
  assert.equal(notice.target, 'reqr')
})

test('notify_failed_to_sender: exactly one notice is produced', async () => {
  const created = await create('reqr2', 'worker', 'read', 'please verify Y', 'notify:2')
  const messageId = (await created.json()).message_id
  await pull('worker')
  await ack('worker', messageId, 'retry', 'crashed')
  // Pull repeatedly — the notice must appear exactly once across all pulls
  // (it is leased on first delivery and never re-delivered).
  const p1 = await pull('reqr2')
  const p2 = await pull('reqr2')
  const p3 = await pull('reqr2')
  const notices = [...p1, ...p2, ...p3].filter((m) => m.kind === 'reply' && m.parent_id === messageId)
  assert.equal(notices.length, 1)
})

test('admin/status lists stuck messages and drops them once completed', async () => {
  const created = await create('boss', 'worker', 'read', 'stuck task', 'admin:1')
  const messageId = (await created.json()).message_id
  const statusRes = await v2Fetch('worker', 'POST', '/v1/admin/status', { agent: 'worker', limit: 10 })
  const stuck = (await statusRes.json()).messages
  assert.ok(stuck.some((m) => m.message_id === messageId && m.status === 'queued'))
  // Acknowledge it, then admin/status must no longer list it.
  await pull('worker')
  await ack('worker', messageId, 'completed')
  const after = await (await v2Fetch('worker', 'POST', '/v1/admin/status', { agent: 'worker', limit: 10 })).json()
  assert.ok(!after.messages.some((m) => m.message_id === messageId))
})
