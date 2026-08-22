/**
 * Regression tests for v3 protocol compatibility (self-use Python clients):
 *   - bilingual signatures: X-Agent-Relay-Key-Id present → v3 keyring scheme,
 *     absent → v2 legacy scheme; both authenticate the same agent
 *   - keyring config: unknown key id and not_after expiry are rejected
 *   - pull returns lease_token/lease_until; ack is token-guarded (409 on
 *     mismatch); /v1/lease/renew extends an active lease (409 otherwise)
 *   - allow_shared_write round-trips on requests and never on replies
 *   - admin authz mirrors the self-use broker (origin cancels, target requeues
 *     unfinished requests, admin_agents override) with an audit log line
 *   - pre-v3 sqlite databases migrate in place (lease_token/allow_shared_write)
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createStore } from '../broker/src/store.js'
import { createAuthenticator } from '../broker/src/auth.js'
import { createBrokerServer } from '../broker/src/server.js'
import { createV2Store } from '../broker/src/store-v2.js'
import { canonicalBody, makeSignature, SIGNATURE_HEADERS } from '../broker/src/protocol.js'

const require = createRequire(import.meta.url)
const SHARED = 'shared-secret-value'
const ALPHA_SECRET = 'alpha-own-secret'
const DATA_DIR = mkdtempSync(join(tmpdir(), 'relay-v3compat-'))
let server
let port

// Config shape the way config.js normalizes it: alpha has an explicit keyring
// with a rotated key plus the legacy one; beta carries only its own secret.
const CONFIG = {
  host: '127.0.0.1', port: 0, secret: SHARED,
  rateLimitLoopback: 100000, rateLimitRemote: 100000, messageTtlDays: 7,
  persist: false, dataDir: DATA_DIR,
  lockAfterFailures: 5, lockMinutes: 5,
  adminAgents: new Set(['ops']),
  agents: {
    alpha: {
      secret: ALPHA_SECRET,
      keys: {
        legacy: { secret: ALPHA_SECRET, notAfter: null },
        k2027: { secret: 'alpha-rotated-secret', notAfter: null },
        kexpired: { secret: 'alpha-old-secret', notAfter: Math.floor(Date.now() / 1000) - 3600 },
      },
      allowedReadTargets: ['beta'],
      allowedWriteTargets: ['beta'],
    },
    beta: { secret: 'beta-own-secret', keys: { legacy: { secret: 'beta-own-secret', notAfter: null } }, allowedReadTargets: ['alpha'] },
    ops: { secret: 'ops-secret', keys: { legacy: { secret: 'ops-secret', notAfter: null } }, allowedReadTargets: [] },
  },
}

function headers(agent, secret, method, path, payload, keyId = '') {
  const body = canonicalBody(payload)
  const ts = String(Math.floor(Date.now() / 1000))
  return {
    'content-type': 'application/json',
    [SIGNATURE_HEADERS.agent]: agent,
    ...(keyId ? { [SIGNATURE_HEADERS.keyId]: keyId } : {}),
    [SIGNATURE_HEADERS.timestamp]: ts,
    [SIGNATURE_HEADERS.signature]: makeSignature(agent, secret, method, path, ts, body, keyId),
  }
}

async function post(agent, secret, path, payload, keyId = '') {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: headers(agent, secret, 'POST', path, payload, keyId),
    body: canonicalBody(payload),
  })
}

before(async () => {
  const store = createStore({ ttlDays: 7, persist: false, dataDir: DATA_DIR })
  const auth = createAuthenticator({ secret: SHARED, lockAfterFailures: 5, lockMinutes: 5, rateLimitLoopback: 100000, rateLimitRemote: 100000 })
  server = createBrokerServer({ config: CONFIG, store, auth })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  rmSync(DATA_DIR, { recursive: true, force: true })
})

test('bilingual auth: v3 (key-id header) and v2 (no header) both authenticate', async () => {
  const v3 = await post('alpha', ALPHA_SECRET, '/v1/recent', { agent: 'alpha', limit: 1 }, 'legacy')
  assert.equal(v3.status, 200)
  const v2 = await post('alpha', ALPHA_SECRET, '/v1/recent', { agent: 'alpha', limit: 1 })
  assert.equal(v2.status, 200)
  // The shared secret must not authenticate a configured agent in isolated mode.
  const shared = await post('alpha', SHARED, '/v1/recent', { agent: 'alpha', limit: 1 }, 'legacy')
  assert.equal(shared.status, 401)
  // An unconfigured agent name is rejected in isolated mode.
  const stranger = await post('gamma', SHARED, '/v1/recent', { agent: 'gamma', limit: 1 })
  assert.equal(stranger.status, 401)
})

test('keyring: rotated key authenticates; unknown and expired keys do not', async () => {
  const rotated = await post('alpha', 'alpha-rotated-secret', '/v1/recent', { agent: 'alpha', limit: 1 }, 'k2027')
  assert.equal(rotated.status, 200)
  const unknown = await post('alpha', ALPHA_SECRET, '/v1/recent', { agent: 'alpha', limit: 1 }, 'nope')
  assert.equal(unknown.status, 401)
  assert.equal((await unknown.json()).error.code, 'unknown_key')
  const expired = await post('alpha', 'alpha-old-secret', '/v1/recent', { agent: 'alpha', limit: 1 }, 'kexpired')
  assert.equal(expired.status, 401)
  assert.equal((await expired.json()).error.code, 'unknown_key')
})

test('v3 flow: send → pull (lease_token) → renew → token-guarded ack', async () => {
  const sendRes = await post('alpha', ALPHA_SECRET, '/v1/messages', {
    origin: 'alpha', target: 'beta', kind: 'request', body: 'v3 roundtrip',
    session_ref: 'alpha', idempotency_key: 'v3:1', ttl_seconds: 3600, execution_mode: 'read',
  }, 'legacy')
  assert.equal(sendRes.status, 200)
  const messageId = (await sendRes.json()).message_id

  const pullRes = await post('beta', 'beta-own-secret', '/v1/pull', { agent: 'beta', limit: 8 }, 'legacy')
  assert.equal(pullRes.status, 200)
  const pulled = (await pullRes.json()).messages
  assert.equal(pulled.length, 1)
  assert.ok(pulled[0].lease_token, 'pull must return a lease_token for v3 clients')
  assert.ok(typeof pulled[0].lease_until === 'number')
  const token = pulled[0].lease_token

  const renewRes = await post('beta', 'beta-own-secret', '/v1/lease/renew', { agent: 'beta', message_id: messageId, lease_token: token, lease_seconds: 300 }, 'legacy')
  assert.equal(renewRes.status, 200)
  assert.ok((await renewRes.json()).lease_until > Date.now() / 1000)

  const wrongToken = await post('beta', 'beta-own-secret', '/v1/ack', { agent: 'beta', message_id: messageId, lease_token: 'forged', outcome: 'completed' }, 'legacy')
  assert.equal(wrongToken.status, 409)
  assert.equal((await wrongToken.json()).error.code, 'lease_mismatch')

  const renewWrong = await post('beta', 'beta-own-secret', '/v1/lease/renew', { agent: 'beta', message_id: messageId, lease_token: 'forged', lease_seconds: 300 }, 'legacy')
  assert.equal(renewWrong.status, 409)

  const ackRes = await post('beta', 'beta-own-secret', '/v1/ack', { agent: 'beta', message_id: messageId, lease_token: token, outcome: 'completed' }, 'legacy')
  assert.equal(ackRes.status, 200)

  // The consumed token must not work a second time.
  const replay = await post('beta', 'beta-own-secret', '/v1/ack', { agent: 'beta', message_id: messageId, lease_token: token, outcome: 'retry' }, 'legacy')
  assert.equal(replay.status, 409)
})

test('v2 flow still works without tokens (dsh plugin compatibility)', async () => {
  const sendRes = await post('alpha', ALPHA_SECRET, '/v1/messages', {
    origin: 'alpha', target: 'beta', kind: 'request', body: 'v2 roundtrip',
    session_ref: 'alpha', idempotency_key: 'v3:2', ttl_seconds: 3600, execution_mode: 'read',
  })
  assert.equal(sendRes.status, 200)
  const messageId = (await sendRes.json()).message_id
  const pullRes = await post('beta', 'beta-own-secret', '/v1/pull', { agent: 'beta', limit: 8 })
  const pulled = (await pullRes.json()).messages
  assert.equal(pulled.length, 1)
  const ackRes = await post('beta', 'beta-own-secret', '/v1/ack', { agent: 'beta', message_id: messageId, outcome: 'completed' })
  assert.equal(ackRes.status, 200)
})

test('allow_shared_write round-trips on requests and is stripped from replies', async () => {
  const sendRes = await post('alpha', ALPHA_SECRET, '/v1/messages', {
    origin: 'alpha', target: 'beta', kind: 'request', body: 'write please',
    session_ref: 'alpha', idempotency_key: 'v3:3', ttl_seconds: 3600, execution_mode: 'write',
    allow_shared_write: true,
  }, 'legacy')
  assert.equal(sendRes.status, 200)
  const messageId = (await sendRes.json()).message_id
  const pullRes = await post('beta', 'beta-own-secret', '/v1/pull', { agent: 'beta', limit: 8 }, 'legacy')
  const pulled = (await pullRes.json()).messages
  assert.equal(pulled[0].message_id, messageId)
  assert.equal(pulled[0].allow_shared_write, true)

  const replyRes = await post('beta', 'beta-own-secret', '/v1/messages', {
    origin: 'beta', target: 'alpha', kind: 'reply', body: 'done',
    session_ref: 'alpha', parent_id: messageId, idempotency_key: 'v3:3:r', ttl_seconds: 3600,
    allow_shared_write: true,
  }, 'legacy')
  assert.equal(replyRes.status, 200)
  const inbox = await post('alpha', ALPHA_SECRET, '/v1/pull', { agent: 'alpha', limit: 8 }, 'legacy')
  const reply = (await inbox.json()).messages.find((m) => m.kind === 'reply')
  assert.ok(reply)
  assert.notEqual(reply.allow_shared_write, true, 'replies must never carry write privileges')

  const badFlag = await post('alpha', ALPHA_SECRET, '/v1/messages', {
    origin: 'alpha', target: 'beta', kind: 'request', body: 'x',
    session_ref: 'a', idempotency_key: 'v3:4', ttl_seconds: 3600, execution_mode: 'write',
    allow_shared_write: 'yes',
  }, 'legacy')
  assert.equal(badFlag.status, 400)
})

test('admin authz: origin cancels, target requeues unfinished, admin_agents override', async () => {
  const cancelId = (await (await post('alpha', ALPHA_SECRET, '/v1/messages', {
    origin: 'alpha', target: 'beta', kind: 'request', body: 'cancel me',
    session_ref: 'a', idempotency_key: 'v3:5', ttl_seconds: 3600, execution_mode: 'read',
  }, 'legacy')).json()).message_id
  // The recipient may NOT cancel someone else's request.
  const byTarget = await post('beta', 'beta-own-secret', '/v1/admin/cancel', { agent: 'beta', message_id: cancelId }, 'legacy')
  assert.equal(byTarget.status, 403)
  const byOrigin = await post('alpha', ALPHA_SECRET, '/v1/admin/cancel', { agent: 'alpha', message_id: cancelId }, 'legacy')
  assert.equal(byOrigin.status, 200)

  const requeueId = (await (await post('alpha', ALPHA_SECRET, '/v1/messages', {
    origin: 'alpha', target: 'beta', kind: 'request', body: 'requeue me',
    session_ref: 'a', idempotency_key: 'v3:6', ttl_seconds: 3600, execution_mode: 'read',
  }, 'legacy')).json()).message_id
  // The origin may NOT requeue (that is the recipient's remedy).
  const originTry = await post('alpha', ALPHA_SECRET, '/v1/admin/requeue', { agent: 'alpha', message_id: requeueId }, 'legacy')
  assert.equal(originTry.status, 403)
  // An admin listed in security.admin_agents may requeue even a completed message.
  const completedId = cancelId
  const adminRequeue = await post('ops', 'ops-secret', '/v1/admin/requeue', { agent: 'ops', message_id: completedId }, 'legacy')
  assert.equal(adminRequeue.status, 200)
})

test('pre-v3 sqlite databases migrate in place', () => {
  const { DatabaseSync } = require('node:sqlite')
  const dir = mkdtempSync(join(tmpdir(), 'relay-v3migrate-'))
  try {
    // A database in the old (pre-lease_token, pre-allow_shared_write) shape.
    const old = new DatabaseSync(join(dir, 'relay-v2.db'))
    old.exec('CREATE TABLE relay_v2_messages (message_id TEXT PRIMARY KEY, root_id TEXT NOT NULL, parent_id TEXT, origin TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, session_ref TEXT, execution_mode TEXT NOT NULL DEFAULT \'read\', context TEXT NOT NULL DEFAULT \'\', topic TEXT NOT NULL DEFAULT \'\', idempotency_key TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lease_until REAL, last_error TEXT, created_at REAL NOT NULL, expires_at REAL NOT NULL, completed_at REAL, notified_at REAL)')
    old.prepare('INSERT INTO relay_v2_messages(message_id, root_id, parent_id, origin, target, kind, body, session_ref, execution_mode, context, topic, idempotency_key, status, attempts, lease_until, last_error, created_at, expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'm1', 'r1', null, 'alpha', 'beta', 'request', 'legacy row', '', 'read', '', '', 'ik', 'queued', 0, null, null, Date.now() / 1000, Date.now() / 1000 + 3600,
    )
    old.close()

    const store = createV2Store({ dataDir: dir, persist: true, leaseSeconds: 600, maxAttempts: 3 })
    const m = store.get('m1')
    assert.ok(m, 'legacy row survives the migration')
    assert.equal(m.allow_shared_write, false)
    assert.equal(m.lease_token, null)
    // New lifecycle writes use the new columns without error.
    store.pull('beta', Date.now() / 1000, { limit: 4 })
    store.ack('m1', 'beta', 'completed', null, Date.now() / 1000, '')
    store.close()
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* tolerated: Windows sqlite handle linger */ }
  }
})
