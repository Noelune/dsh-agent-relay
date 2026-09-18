/**
 * The inbox worker is what the DSH plugin uses to hear from the circle; it had
 * no coverage at all before 2026-09-19, which is how "requests arrive up to one
 * poll period late" survived as the default behaviour.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInboxWorker } from '../lib/inbox-worker.js'

const cfg = { longPollSeconds: 25, fastPollSeconds: 0.05, idlePollSeconds: 0.05, idleAfterSeconds: 3600 }

function makeClient({ batches, failFirst = 0 }) {
  const calls = []
  const acks = []
  let index = 0
  let failures = 0
  return {
    calls,
    acks,
    async pull(opts) {
      calls.push(opts)
      if (failures < failFirst) {
        failures += 1
        throw new Error('connection refused')
      }
      const batch = batches[Math.min(index, batches.length - 1)] ?? []
      index += 1
      return batch
    },
    async ack(id, outcome, error) {
      acks.push({ id, outcome, error })
    },
  }
}

test('the inbox worker long-polls with the configured hold', async () => {
  const seen = []
  const client = makeClient({ batches: [[{ message_id: 'm1' }], []] })
  const worker = createInboxWorker({
    cfg,
    diag: () => {},
    getClient: () => client,
    handleMessage: async (m) => { seen.push(m.message_id) },
    isStopping: () => false,
  })
  worker.scheduleNextPoll()
  await new Promise((r) => setTimeout(r, 120))
  worker.stop()

  assert.ok(seen.length >= 1, 'the message must be handled')
  assert.equal(client.calls[0].waitSeconds, 25, 'pull must be a long-poll, not an immediate claim')
  assert.equal(client.calls[0].limit, 4)
})

test('a non-empty batch is drained in the same cycle instead of waiting for the next period', async () => {
  const handled = []
  const client = makeClient({ batches: [[{ message_id: 'a' }, { message_id: 'b' }], [{ message_id: 'c' }], []] })
  const worker = createInboxWorker({
    cfg,
    diag: () => {},
    getClient: () => client,
    handleMessage: async (m) => { handled.push(m.message_id) },
    isStopping: () => false,
  })
  worker.scheduleNextPoll()
  await new Promise((r) => setTimeout(r, 150))
  worker.stop()

  assert.deepEqual(handled, ['a', 'b', 'c'])
  assert.ok(client.calls.length >= 2, 'backlog is drained back-to-back')
})

test('a failing handler requeues the message and the loop keeps running', async () => {
  const client = makeClient({ batches: [[{ message_id: 'boom' }], []] })
  const logs = []
  const worker = createInboxWorker({
    cfg,
    diag: (m) => logs.push(String(m)),
    getClient: () => client,
    handleMessage: async () => { throw new Error('handler exploded') },
    isStopping: () => false,
  })
  worker.scheduleNextPoll()
  await new Promise((r) => setTimeout(r, 200))
  worker.stop()

  assert.equal(client.acks.length, 1, 'a failed message is acked for retry')
  assert.equal(client.acks[0].outcome, 'retry')
  assert.match(client.acks[0].error, /handler exploded/)
})

test('an unreachable broker backs off exponentially and recovers quietly', async () => {
  const client = makeClient({ batches: [[]], failFirst: 1 })
  const logs = []
  const worker = createInboxWorker({
    cfg,
    diag: (m) => logs.push(String(m)),
    getClient: () => client,
    handleMessage: async () => {},
    isStopping: () => false,
  })
  worker.scheduleNextPoll()
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(client.calls.length, 1, 'the first failure must not be retried immediately')
  assert.ok(logs.some((l) => l.includes('broker unreachable') && l.includes('backing off 2000ms')))

  await new Promise((r) => setTimeout(r, 1900))
  worker.stop()
  assert.ok(client.calls.length >= 2, 'it retries on the backoff schedule')
})

test('a missing client or a stopping worker stays quiet', async () => {
  const worker = createInboxWorker({
    cfg, diag: () => {}, getClient: () => null,
    handleMessage: async () => {}, isStopping: () => false,
  })
  worker.scheduleNextPoll()
  await new Promise((r) => setTimeout(r, 80))
  worker.stop()

  const stopped = createInboxWorker({
    cfg, diag: () => {}, getClient: () => makeClient({ batches: [[]] }),
    handleMessage: async () => {}, isStopping: () => true,
  })
  stopped.scheduleNextPoll()
  await new Promise((r) => setTimeout(r, 80))
  stopped.scheduleNextPoll()
  stopped.stop()
})
