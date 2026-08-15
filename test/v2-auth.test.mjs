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
const DATA_DIR = mkdtempSync(join(tmpdir(), 'relay-v2auth-'))
let server
let port

before(async () => {
  const config = {
    host: '127.0.0.1', port: 0, secret: SHARED, tls: false,
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
    body: canonicalBody(payload),
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
    body: canonicalBody(payload),
  })
  assert.equal(res.status, 401)
  assert.equal((await res.json()).error.code, 'unauthenticated')
})

test('v1 requests still authenticate with the v1 scheme', async () => {
  const { authHeaders } = await import('../lib/sign.js')
  const headers = authHeaders(SHARED, 'v1agent', 'GET', '/peers', '')
  const res = await fetch(`http://127.0.0.1:${port}/peers`, {
    headers: {
      'x-relay-agent': 'v1agent',
      'x-relay-timestamp': headers['x-relay-timestamp'],
      'x-relay-signature': headers['x-relay-signature'],
    },
  })
  assert.equal(res.status, 200)
})
