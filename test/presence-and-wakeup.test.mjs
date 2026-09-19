/**
 * Presence reporting, retention default, failure notices that do not depend on
 * a pull, and long-poll wake-up (P0/P1 of the 2026-09-19 optimisation).
 *
 * These lock the behaviours the 2026-09-19 audit found missing: 15 of 27 stored
 * messages had expired with attempts=0 because the recipient never polled, and
 * the "undelivered" notice was only ever produced from inside a pull handler.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrokerServer } from '../broker/src/server.js'
import { createV2Store } from '../broker/src/store-v2.js'
import {
  canonicalBody, makeSignature, SIGNATURE_HEADERS,
  DEFAULT_REQUEST_TTL_SECONDS, PRESENCE_STALE_SECONDS,
} from '../broker/src/protocol.js'

const SHARED = 'shared-secret-value'
const SENDER = 'presend'
const RECEIVER = 'pereceiver'
const GHOST = 'peghostmember'
const WOKEN = 'pewokenmember'
const DATA_DIR = mkdtempSync(join(tmpdir(), 'relay-presence-'))
let server
let port
let v2Store
let config

before(async () => {
  config = {
    host: '127.0.0.1', port: 0, secret: SHARED, tls: false,
    rateLimitLoopback: 100000, rateLimitRemote: 100000, messageTtlDays: 7,
    persist: false, dataDir: DATA_DIR, lockAfterFailures: 5, lockMinutes: 5,
    maxAttempts: 3, leaseSeconds: 600, notifyFailedToSender: true,
    // Entries without a secret/ACL keep shared-secret auth and open routing,
    // while making the members visible to /healthz the way a real config does.
    agents: { [SENDER]: {}, [RECEIVER]: {}, [GHOST]: {} },
  }
  v2Store = createV2Store({ dataDir: DATA_DIR, persist: false, leaseSeconds: 600, maxAttempts: 3 })
  server = createBrokerServer({ config, storeV2: v2Store })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  v2Store.close()
  rmSync(DATA_DIR, { recursive: true, force: true })
})

async function post(agent, path, payload) {
  const body = canonicalBody(payload)
  const ts = String(Math.floor(Date.now() / 1000))
  const signature = makeSignature(agent, SHARED, 'POST', path, ts, body)
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [SIGNATURE_HEADERS.agent]: agent,
      [SIGNATURE_HEADERS.timestamp]: ts,
      [SIGNATURE_HEADERS.signature]: signature,
    },
    body,
  })
}

function sendArgs(overrides = {}) {
  return {
    origin: SENDER, target: RECEIVER, kind: 'request', body: 'review this diff',
    session_ref: SENDER, idempotency_key: `presence:${Math.random()}`, execution_mode: 'read',
    ...overrides,
  }
}

test('send reports an unseen peer as offline instead of failing silently', async () => {
  const res = await post(SENDER, '/v1/messages', sendArgs({ idempotency_key: 'presence:offline' }))
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.created, true, 'the message is still durably queued')
  assert.match(data.message_id, /^[0-9a-f]{32}$/)
  assert.equal(data.target_online, false)
  assert.equal(data.last_seen_at, null)
  assert.match(data.hint, /未取件/, 'the caller gets an actionable reason immediately')
})

test('presence turns online once the peer has claimed, and the default retention is days not an hour', async () => {
  // Drain whatever the previous test queued, and register the peer as present.
  await post(RECEIVER, '/v1/pull', { agent: RECEIVER, limit: 8 })
  const res = await post(SENDER, '/v1/messages', sendArgs({ idempotency_key: 'presence:online' }))
  const data = await res.json()
  assert.equal(data.target_online, true)
  assert.ok(data.last_seen_at > 0)
  assert.equal(data.hint, undefined)
  assert.ok(Math.abs(v2Store.lastPullAt[RECEIVER] - Date.now() / 1000) < PRESENCE_STALE_SECONDS)

  const stored = v2Store.get(data.message_id)
  assert.ok(stored)
  assert.equal(
    Math.round(stored.expires_at - stored.created_at),
    DEFAULT_REQUEST_TTL_SECONDS,
    'a send without ttl_seconds must survive the recipient being offline',
  )
  assert.equal(DEFAULT_REQUEST_TTL_SECONDS, 7 * 86400)
})

test('an explicit ttl_seconds is still honoured, clamped into range', async () => {
  const short = await post(SENDER, '/v1/messages', sendArgs({ idempotency_key: 'presence:ttl', ttl_seconds: 120 }))
  const shortMsg = v2Store.get((await short.json()).message_id)
  assert.equal(Math.round(shortMsg.expires_at - shortMsg.created_at), 120)

  const huge = await post(SENDER, '/v1/messages', sendArgs({ idempotency_key: 'presence:ttl-max', ttl_seconds: 999_999_999 }))
  const hugeMsg = v2Store.get((await huge.json()).message_id)
  assert.ok(hugeMsg.expires_at - hugeMsg.created_at <= 30 * 86400, 'TTL is clamped to the 30 day ceiling')

  // Leave the queue empty for the wake-up test below.
  await post(RECEIVER, '/v1/pull', { agent: RECEIVER, limit: 8 })
})

test('long-poll pull is settled by an arriving message instead of waiting out the poll period', async () => {
  const started = Date.now()
  const held = post(RECEIVER, '/v1/pull', { agent: RECEIVER, limit: 8, wait_seconds: 20 })
  await new Promise((r) => setTimeout(r, 250))
  assert.equal(server.heldPulls(), 1, 'the empty pull is parked server-side')

  const sent = await post(SENDER, '/v1/messages', sendArgs({ idempotency_key: 'presence:wake' }))
  const sentData = await sent.json()
  const messages = await (await held).json()
  const elapsed = Date.now() - started

  assert.equal(messages.messages.length, 1)
  assert.equal(messages.messages[0].message_id, sentData.message_id)
  assert.ok(elapsed < 5000, `delivery must not wait for a poll period (took ${elapsed}ms)`)
  assert.equal(server.heldPulls(), 0, 'the settled waiter is deregistered')
})

test('long-poll returns empty at its deadline when nothing arrives', async () => {
  const started = Date.now()
  const res = await post(RECEIVER, '/v1/pull', { agent: RECEIVER, limit: 8, wait_seconds: 1 })
  const data = await res.json()
  const elapsed = Date.now() - started
  assert.deepEqual(data.messages, [])
  assert.ok(elapsed >= 900, `held until the deadline (took ${elapsed}ms)`)
  assert.equal(server.heldPulls(), 0)
})

test('a recipient that never polls still produces exactly one long-lived notice for its sender', async () => {
  const now = Date.now() / 1000
  v2Store.create({
    message_id: 'a'.repeat(32), root_id: 'r-notify', parent_id: null,
    origin: SENDER, target: GHOST, kind: 'request', body: 'anyone there?',
    session_ref: '', created_at: now - 7200, expires_at: now - 3600,
    execution_mode: 'read', context: '', topic: '',
  }, 'presence:dead-target')

  // The sweep is what makes a request expired; nobody had to pull for that.
  v2Store.cleanup(Date.now() / 1000)
  server.notifyFailedSenders()
  server.notifyFailedSenders() // notified_at must guard a duplicate notice

  const notices = v2Store.queryMessages(SENDER, { root_id: 'r-notify', kind: 'reply', limit: 50 })
  assert.equal(notices.length, 1, 'exactly one undelivered notice for the sender')
  const stored = v2Store.get(notices[0].message_id)
  assert.ok(stored)
  assert.ok(
    stored.expires_at - stored.created_at >= 7 * 86400,
    'the error report must not expire before the failure it reports is discoverable',
  )
  assert.equal(stored.target, SENDER)
  assert.ok(stored.notified_at == null, 'a notice is never itself re-notified')
})

test('healthz exposes presence so offline members are visible without reading the database', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/healthz`)
  const data = await res.json()
  assert.equal(data.ok, true)
  assert.equal(data.presence[RECEIVER].online, true)
  assert.equal(data.presence[GHOST].online, false)
  assert.equal(data.presence[GHOST].last_pull_at, null)
  assert.equal(data.presence[RECEIVER].last_pull_at, data.last_pull_at[RECEIVER])
  assert.equal(data.long_poll.max_wait_seconds, 120)
  assert.equal(data.long_poll.held, 0)
})

/* -- client surface: the synchronous handoff ------------------------------ */

const { RelayClientV2 } = await import('../lib/client-v2.js')

function clientFor(name) {
  return new RelayClientV2({ endpoint: `http://127.0.0.1:${port}`, agent: name, secret: SHARED })
}

test('ask() returns the peer reply from a single call without stealing its own inbox', async () => {
  const asker = clientFor(SENDER)
  const answerer = clientFor(RECEIVER)

  // Traffic addressed at the *asker* that its targeted wait must not consume:
  // this is what makes `match_root_id` meaningful (an agent that asks a peer
  // while still owning its own inbox).
  await clientFor('peerother').sendRequest({
    target: SENDER, body: 'unrelated inbox traffic',
    sessionRef: 'peerother', idempotencyKey: 'presence:unrelated',
  })
  await post(RECEIVER, '/v1/pull', { agent: RECEIVER, limit: 8 })

  const inflight = asker.ask({ target: RECEIVER, body: 'is this claim safe?', timeoutSeconds: 30 })
  await new Promise((r) => setTimeout(r, 250))

  // The peer answers through a normal inbox claim.
  const pending = await answerer.pull({ limit: 8 })
  const question = pending.find((m) => m.body === 'is this claim safe?')
  assert.ok(question, 'ask() must reach the peer inbox')
  await answerer.sendReply(question, 'yes, it is guarded', `reply:${question.message_id}`)

  const result = await inflight
  assert.equal(result.ok, true)
  assert.equal(result.reply, 'yes, it is guarded')
  assert.ok(result.waited_seconds <= 5, 'the reply arrives on the wake-up, not on a timer')

  // The asker's own inbox was untouched by the wait.
  const own = await asker.pull({ limit: 8 })
  assert.ok(own.some((m) => m.body === 'unrelated inbox traffic'))
})

test('ask() reports peer_offline immediately rather than waiting out the deadline', async () => {
  const started = Date.now()
  const result = await clientFor(SENDER).ask({ target: GHOST, body: 'anyone?', timeoutSeconds: 20 })
  const elapsed = Date.now() - started
  assert.equal(result.ok, false)
  assert.equal(result.target_online, false)
  assert.equal(result.reason, 'peer_offline')
  assert.ok(elapsed < 3000, `must not burn the whole deadline (took ${elapsed}ms)`)
  assert.ok(typeof result.hint === 'string' && result.hint.length > 0)
})

test('the Python client keeps parity on the new pull and send fields', async () => {
  const { execFileSync } = await import('node:child_process')
  // The Python client must expose the same presence + long-poll surface.
  const out = execFileSync(
    process.env.PYTHON || 'python',
    ['-c', `
import sys, inspect
sys.path.insert(0, ${JSON.stringify(join(process.cwd(), 'adapters', 'hermes'))})
import relay_client_v2 as m
sig = inspect.signature(m.RelayClientV2.pull)
assert 'wait_seconds' in sig.parameters, 'pull needs wait_seconds'
assert 'match_root_id' in sig.parameters, 'pull needs match_root_id'
assert hasattr(m.RelayClientV2, 'ask'), 'client needs ask()'
assert hasattr(m.RelayClientV2, 'send_request_detailed'), 'client needs send_request_detailed'
assert m.DEFAULT_REQUEST_TTL_SECONDS == 7 * 86400, m.DEFAULT_REQUEST_TTL_SECONDS
print('parity-ok')
`],
    { encoding: 'utf8' },
  )
  assert.match(out, /parity-ok/)
})

/**
 * On-demand delivery: an agent nobody is polling gets started by the broker when
 * a message lands for it. This is what removes "the recipient must already be
 * running" — the 2026-09-19 audit's root cause.
 */
test('a message for an unpolled agent starts its wake_command once', async () => {
  const { writeFileSync } = await import('node:fs')
  const marker = join(DATA_DIR, 'wake.marker')
  const helper = join(DATA_DIR, 'wake-helper.mjs')
  // Keep the command quote-free apart from the interpreter path: `shell: true`
  // on Windows hands the string to cmd.exe, whose quoting rules are exactly the
  // kind of thing a test must not be testing.
  writeFileSync(helper, [
    "import { writeFileSync } from 'node:fs'",
    `writeFileSync(${JSON.stringify(marker)}, process.argv[2] ?? '')`,
    'setTimeout(() => process.exit(0), 1500) // stay in flight so the dedup path is exercised',
  ].join('\n'), 'utf8')
  config.agents[WOKEN] = { wakeCommand: `"${process.execPath}" ${helper} {message_id}` }
  try {
    const res = await post(SENDER, '/v1/messages', sendArgs({ target: WOKEN, idempotencyKey: 'presence:wake-cmd' }))
    const data = await res.json()
    assert.equal(data.target_online, false, 'nobody is polling the woken agent')

    const deadline = Date.now() + 8000
    while (!existsSync(marker) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.ok(existsSync(marker), 'the broker must start the recipient on demand')
    assert.equal(readFileSync(marker, 'utf8'), data.message_id, 'the placeholder carries the message id')

    // A second message while that wake is still in flight must not double-start.
    rmSync(marker, { force: true })
    await post(SENDER, '/v1/messages', sendArgs({ target: WOKEN, idempotencyKey: 'presence:wake-cmd-2' }))
    await new Promise((r) => setTimeout(r, 500))
    assert.equal(existsSync(marker), false, 'one in-flight wake per agent')
  } finally {
    delete config.agents[WOKEN]
  }
})

/**
 * A member served by a timer-polling pre-0.6 client (the Feishu bot answering
 * for codex/claude) almost never holds a pull open. Spawning on "no held pull"
 * would put a headless worker in competition with it and double-handle the
 * message, so presence — not held requests — gates the wake.
 */
test('a recently-seen agent is not started on demand even when it holds no pull', async () => {
  const { writeFileSync } = await import('node:fs')
  const marker = join(DATA_DIR, 'wake-alive.marker')
  const helper = join(DATA_DIR, 'wake-alive-helper.mjs')
  writeFileSync(helper, [
    "import { writeFileSync } from 'node:fs'",
    `writeFileSync(${JSON.stringify(marker)}, 'spawned')`,
  ].join('\n'), 'utf8')
  config.agents[WOKEN] = { wakeCommand: `"${process.execPath}" ${helper}` }
  try {
    assert.equal(server.heldPulls(), 0, 'the woken agent holds no pull')
    await post(WOKEN, '/v1/pull', { agent: WOKEN, limit: 1 }) // a timer poll, like the bot does
    rmSync(marker, { force: true })

    await post(SENDER, '/v1/messages', sendArgs({ target: WOKEN, idempotencyKey: 'presence:wake-suppressed' }))
    await new Promise((r) => setTimeout(r, 600))
    assert.equal(existsSync(marker), false, 'a live member must never be double-served')
    // (The complementary case — an agent that never claimed does get started —
    // is the test above.)
  } finally {
    delete config.agents[WOKEN]
  }
})

