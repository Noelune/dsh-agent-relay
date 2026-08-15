import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createStore } from '../broker/src/store.js'
import { createAuthenticator } from '../broker/src/auth.js'
import { createBrokerServer } from '../broker/src/server.js'
import { RelayClient } from '../lib/client.js'
import { authHeaders } from '../lib/sign.js'

const SECRET = randomBytes(32).toString('hex')
let server
let port
let dir

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'relay-e2e-'))
  const config = {
    host: '127.0.0.1', port: 0, secret: SECRET, tls: false,
    rateLimitLoopback: 100000, rateLimitRemote: 100000, messageTtlDays: 7,
    persist: false, dataDir: dir, lockAfterFailures: 5, lockMinutes: 5,
  }
  const store = createStore({ ttlDays: 7, persist: false, dataDir: dir })
  const auth = createAuthenticator({ secret: SECRET, lockAfterFailures: 5, lockMinutes: 5, rateLimitLoopback: 100000, rateLimitRemote: 100000 })
  server = createBrokerServer({ config, store, auth })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

after(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

function client(agent) {
  return new RelayClient({ brokerUrl: `http://127.0.0.1:${port}`, agent, secret: SECRET })
}

test('version negotiation', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/`)
  const info = await res.json()
  assert.equal(info.protocol, '1.0')
  assert.equal(info.broker, 'dsh-agent-relay')
})

test('unauthenticated request -> 401', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/peers`)
  assert.equal(res.status, 401)
  const body = await res.json()
  assert.equal(body.error.code, 'unauthenticated')
})

test('register + peers', async () => {
  const a = client('e2e-alpha')
  const b = client('e2e-beta')
  await a.register()
  await b.register()
  const peers = await a.peers()
  assert.ok(peers.some((p) => p.agent === 'e2e-alpha' && p.online))
  assert.ok(peers.some((p) => p.agent === 'e2e-beta' && p.online))
})

test('send/recv round trip with ack', async () => {
  const a = client('e2e-alpha')
  const b = client('e2e-beta')
  await a.register(); await b.register()
  const sent = await a.send({ to: 'e2e-beta', body: { text: 'hello beta' }, ack: true })
  assert.equal(sent.accepted, true)
  const inbox = await b.recv(10)
  const got = inbox.messages.find((m) => m.id === sent.id)
  assert.ok(got, 'message must be delivered')
  assert.equal(got.body.text, 'hello beta')
  assert.equal(got.from, 'e2e-alpha')
  await b.ack(sent.id, 'ok')
  const aInbox = await a.recv(10)
  const receipt = aInbox.messages.find((m) => m.type === 'ack' && m.replyTo === sent.id)
  assert.ok(receipt, 'sender must receive the ack')
  assert.equal(receipt.body.status, 'ok')
})

test('idempotent resend returns duplicate:true and does not double-deliver', async () => {
  const a = client('e2e-alpha')
  const b = client('e2e-beta')
  await a.register(); await b.register()
  const id = randomBytes(16).toString('hex')
  const first = await a.send({ to: 'e2e-beta', body: { text: 'dup' }, id })
  assert.equal(first.duplicate, false)
  const second = await a.send({ to: 'e2e-beta', body: { text: 'dup' }, id })
  assert.equal(second.duplicate, true)
  const inbox = await b.recv(10)
  const matches = inbox.messages.filter((m) => m.id === id)
  assert.equal(matches.length, 1)
})

test('unknown recipient -> 404 no_such_agent', async () => {
  const a = client('e2e-alpha')
  await a.register()
  await assert.rejects(
    () => a.send({ to: 'ghost', body: { text: 'x' } }),
    (err) => err.code === 'no_such_agent',
  )
})

test('self-send rejected', async () => {
  const a = client('e2e-alpha')
  await a.register()
  await assert.rejects(
    () => a.send({ to: 'e2e-alpha', body: { text: 'x' } }),
    (err) => err.code === 'bad_request',
  )
})

test('wrong secret -> 401', async () => {
  const evil = new RelayClient({ brokerUrl: `http://127.0.0.1:${port}`, agent: 'e2e-evil', secret: '0'.repeat(64) })
  await assert.rejects(() => evil.register(), (err) => err.code === 'unauthenticated')
})

test('protocol mismatch is detected by the client handshake', async () => {
  const a = client('e2e-alpha')
  const info = await a.handshake()
  assert.equal(info.protocol, '1.0')
})

test('v1.1 endpoints reject malformed JSON instead of silently using defaults', async () => {
  const rawBody = '{'
  for (const path of ['/v1/pull', '/v1/recent', '/v1/messages/query']) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(SECRET, 'e2e-alpha', 'POST', path, rawBody),
      },
      body: rawBody,
    })
    assert.equal(res.status, 400, path)
    assert.equal((await res.json()).error.code, 'bad_request', path)
  }
})
