import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createStore } from '../broker/src/store.js'
import { createAuthenticator } from '../broker/src/auth.js'
import { createBrokerServer } from '../broker/src/server.js'
import { RelayClient, RelayError } from '../lib/client.js'

const SECRET = randomBytes(32).toString('hex')
let server
let port
let dir

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'relay-acl-'))
  const config = {
    host: '127.0.0.1', port: 0, secret: SECRET, tls: false,
    rateLimitLoopback: 100000, rateLimitRemote: 100000, messageTtlDays: 7,
    persist: false, dataDir: dir, lockAfterFailures: 5, lockMinutes: 5,
    leaseSeconds: 600, maxAttempts: 3,
    // alpha may only send to beta; gamma has no entry (allow all).
    agents: { alpha: { allowedTargets: ['beta'] } },
  }
  const store = createStore({ ttlDays: 7, persist: false, dataDir: dir, maxAttempts: 3 })
  const auth = createAuthenticator({ secret: SECRET, lockAfterFailures: 5, lockMinutes: 5, rateLimitLoopback: 100000, rateLimitRemote: 100000 })
  server = createBrokerServer({ config, store, auth })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

after(() => { server.close(); rmSync(dir, { recursive: true, force: true }) })

function client(agent) {
  return new RelayClient({ brokerUrl: `http://127.0.0.1:${port}`, agent, secret: SECRET })
}

test('acl: allowed target succeeds; disallowed target is 403', async () => {
  const alpha = client('alpha')
  const beta = client('beta')
  const gamma = client('gamma')
  await alpha.register(); await beta.register(); await gamma.register()
  const ok = await alpha.send({ to: 'beta', body: { text: 'hi' } })
  assert.equal(ok.accepted, true)
  await assert.rejects(
    () => alpha.send({ to: 'gamma', body: { text: 'no' } }),
    (err) => err instanceof RelayError && err.code === 'forbidden',
  )
  // An agent WITHOUT an ACL entry may send to anyone (v1.0 default).
  const okGamma = await gamma.send({ to: 'alpha', body: { text: 'ping' } })
  assert.equal(okGamma.accepted, true)
})

test('acl: v1.1 pull/ack round trip respects status', async () => {
  const alpha = client('alpha')
  const beta = client('beta')
  await alpha.register(); await beta.register()
  const sent = await alpha.send({ to: 'beta', body: { text: 'lease me' }, kind: 'request' })
  const pulled = await beta.pull(10, 600)
  const got = pulled.messages.find((m) => m.id === sent.id)
  assert.ok(got, 'beta must pull the leased message')
  assert.equal(got.status, 'leased')
  assert.equal(got.kind, 'request')
  const acked = await beta.ackOutcome(sent.id, 'completed')
  assert.equal(acked.status, 'done')
  const status = await beta.status([sent.id])
  assert.equal(status.find((s) => s.id === sent.id).status, 'done')
  assert.equal((await beta.recent(10)).some((m) => m.id === sent.id), true)
  assert.equal((await beta.query({ kind: 'request' })).length, 1)
})
