import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { signRequest, authHeaders, signaturesEqual } from '../lib/sign.js'
import { createAuthenticator } from '../broker/src/auth.js'

const SECRET = 'test-fixture-value' // fake test secret (low-entropy on purpose)

test('signRequest produces the documented HMAC input', () => {
  // method + "\n" + path + "\n" + timestamp + "\n" + rawBody
  const sig = signRequest(SECRET, 'POST', '/messages', 1755250000, '{"a":1}')
  // recompute with node:crypto to make the fixture meaningful
  const real = createHmac('sha256', SECRET)
    .update('POST\n/messages\n1755250000\n{"a":1}')
    .digest('hex')
  assert.equal(sig, real)
  assert.equal(sig.length, 64)
})

test('authHeaders carry agent/timestamp/signature', () => {
  const h = authHeaders(SECRET, 'alpha', 'GET', '/peers', '')
  assert.equal(h['x-relay-agent'], 'alpha')
  assert.match(h['x-relay-signature'], /^[0-9a-f]{64}$/)
  assert.ok(Math.abs(Number(h['x-relay-timestamp']) - Math.floor(Date.now() / 1000)) <= 1)
})

test('signaturesEqual is constant-time and correct', () => {
  const a = signRequest(SECRET, 'GET', '/', 1, '')
  assert.ok(signaturesEqual(a, a))
  assert.ok(!signaturesEqual(a, signRequest(SECRET, 'GET', '/x', 1, '')))
  assert.ok(!signaturesEqual('abc', 'abcdef'))
})

function fakeReq(agent, timestamp, signature, ip = '127.0.0.1') {
  return {
    method: 'GET',
    url: '/peers',
    headers: { 'x-relay-agent': agent, 'x-relay-timestamp': String(timestamp), 'x-relay-signature': signature },
    socket: { remoteAddress: ip },
  }
}

test('auth: valid signature passes', () => {
  const auth = createAuthenticator({ secret: SECRET, lockAfterFailures: 5, lockMinutes: 5, rateLimitLoopback: 1000, rateLimitRemote: 1000 })
  const ts = Math.floor(Date.now() / 1000)
  const sig = signRequest(SECRET, 'GET', '/peers', ts, '')
  const verdict = auth.check(fakeReq('alpha', ts, sig), '')
  assert.equal(verdict.ok, true)
  assert.equal(verdict.agent, 'alpha')
})

test('auth: missing headers -> 401', () => {
  const auth = createAuthenticator({ secret: SECRET, lockAfterFailures: 5, lockMinutes: 5, rateLimitLoopback: 1000, rateLimitRemote: 1000 })
  const verdict = auth.check(fakeReq('alpha', 0, ''), '')
  assert.equal(verdict.ok, false)
  assert.equal(verdict.status, 401)
})

test('auth: timestamp skew -> 401', () => {
  const auth = createAuthenticator({ secret: SECRET, lockAfterFailures: 5, lockMinutes: 5, rateLimitLoopback: 1000, rateLimitRemote: 1000 })
  const ts = Math.floor(Date.now() / 1000) - 3600
  const sig = signRequest(SECRET, 'GET', '/peers', ts, '')
  const verdict = auth.check(fakeReq('alpha', ts, sig), '')
  assert.equal(verdict.ok, false)
  assert.equal(verdict.status, 401)
  assert.equal(verdict.code, 'unauthenticated')
})

test('auth: 5 failures lock the agent for lockMinutes', () => {
  const auth = createAuthenticator({ secret: SECRET, lockAfterFailures: 5, lockMinutes: 5, rateLimitLoopback: 1000, rateLimitRemote: 1000 })
  const ts = Math.floor(Date.now() / 1000)
  for (let i = 0; i < 5; i++) {
    const verdict = auth.check(fakeReq('evil', ts, '0'.repeat(64)), '')
    assert.equal(verdict.ok, false)
  }
  // now even a VALID signature must be rejected while locked
  const goodSig = signRequest(SECRET, 'GET', '/peers', ts, '')
  const verdict = auth.check(fakeReq('evil', ts, goodSig), '')
  assert.equal(verdict.ok, false)
  assert.equal(verdict.status, 403)
  assert.equal(verdict.code, 'locked')
})

test('auth: rate limit enforced per IP', () => {
  const auth = createAuthenticator({ secret: SECRET, lockAfterFailures: 5, lockMinutes: 5, rateLimitLoopback: 3, rateLimitRemote: 1000 })
  const ts = Math.floor(Date.now() / 1000)
  const sig = signRequest(SECRET, 'GET', '/peers', ts, '')
  for (let i = 0; i < 3; i++) {
    assert.equal(auth.check(fakeReq('alpha', ts, sig), '').ok, true)
  }
  const verdict = auth.check(fakeReq('alpha', ts, sig), '')
  assert.equal(verdict.ok, false)
  assert.equal(verdict.status, 429)
})
