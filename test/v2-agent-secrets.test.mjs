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
const DATA_DIR = mkdtempSync(join(tmpdir(), 'relay-v2secrets-'))
let server
let port

before(async () => {
  const config = {
    host: '127.0.0.1', port: 0, secret: SHARED, tls: false,
    rateLimitLoopback: 100000, rateLimitRemote: 100000, messageTtlDays: 7,
    persist: false, dataDir: DATA_DIR, lockAfterFailures: 5, lockMinutes: 5,
    // Isolated mode: alpha has its own secret; an unconfigured agent must not
    // be able to authenticate with the shared secret.
    agents: { alpha: { secret: 'alpha-secret', allowedTargets: [] } },
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

function signedFetch(agent, secret, method, path, payload) {
  const body = canonicalBody(payload)
  const ts = String(Math.floor(Date.now() / 1000))
  const signature = makeSignature(agent, secret, method, path, ts, body)
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

test('isolated mode: a configured agent authenticates with its own secret', async () => {
  const res = await signedFetch('alpha', 'alpha-secret', 'POST', '/v1/pull', { agent: 'alpha', limit: 1 })
  assert.notEqual(res.status, 401)
})

test('isolated mode: the shared secret does not authenticate a configured agent', async () => {
  const res = await signedFetch('alpha', SHARED, 'POST', '/v1/pull', { agent: 'alpha', limit: 1 })
  assert.equal(res.status, 401)
})

test('isolated mode: an unconfigured agent is rejected even with the shared secret', async () => {
  const res = await signedFetch('stranger', SHARED, 'POST', '/v1/pull', { agent: 'stranger', limit: 1 })
  assert.equal(res.status, 401)
  assert.equal((await res.json()).error.code, 'unknown_agent')
})
