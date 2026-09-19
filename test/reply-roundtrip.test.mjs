/**
 * The answering path end to end. Added while testing a real Qoder → ZCode
 * exchange, which exposed that both front doors could *ask* and *read* but
 * nothing could answer on the same conversation thread — so `ask` had a waiter
 * and no possible answerer outside the automatic worker.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RelayClientV2 } from '../lib/client-v2.js'
import { startBroker, TEST_SECRET } from './helpers/broker.mjs'

function clients(endpoint) {
  const make = (agent) => new RelayClientV2({ endpoint, agent, secret: TEST_SECRET })
  return { alpha: make('alpha'), beta: make('beta') }
}

test('a request can be answered by id alone, and the answer inherits the thread', async () => {
  const fx = await startBroker({ secret: TEST_SECRET })
  const { alpha, beta } = clients(fx.endpoint)
  try {
    const sent = await alpha.sendRequestDetailed({
      target: 'beta', body: '这个函数线程安全吗？', sessionRef: 'alpha:session-7',
      idempotencyKey: 'rt-1', executionMode: 'read', context: 'path: lib/x.js', topic: '并发审查',
      ttlSeconds: 3600,
    })
    assert.equal(sent.created, true)

    const [claim] = await beta.pull({ limit: 4 })
    assert.equal(claim.message_id, sent.message_id)
    assert.equal(claim.topic, '并发审查')

    // Only the id is passed — this is the shape a human-driven member has after
    // reading its inbox: no stored envelope, no session reference.
    const replyId = await beta.replyTo(claim.message_id, '不安全：计数器没有加锁。')
    const [reply] = await alpha.pull({ limit: 4 })
    assert.equal(reply.message_id, replyId)
    assert.equal(reply.kind, 'reply')
    assert.equal(reply.origin, 'beta')
    assert.equal(reply.target, 'alpha')
    assert.equal(reply.parent_id, sent.message_id)
    assert.equal(reply.root_id, sent.root_id, 'the answer stays on the request thread')
    assert.equal(reply.session_ref, 'alpha:session-7', 'session is inherited from the parent')
    assert.equal(reply.topic, '并发审查')
    assert.equal(reply.body, '不安全：计数器没有加锁。')

    // ask() waits on the same thread, so a reply-by-id satisfies a waiting sender.
    await alpha.ack(reply.message_id, 'completed', undefined, reply.lease_token)
    await beta.ack(claim.message_id, 'completed', undefined, claim.lease_token)
    const status = await alpha.status([sent.message_id])
    assert.equal(status[0].status, 'completed')
  } finally {
    await fx.stop()
  }
})

test('a stranger cannot answer, and a missing id is a clear error', async () => {
  const fx = await startBroker({ secret: TEST_SECRET })
  const { alpha, beta } = clients(fx.endpoint)
  const gamma = new RelayClientV2({ endpoint: fx.endpoint, agent: 'gamma', secret: TEST_SECRET })
  try {
    const sent = await alpha.sendRequest({ target: 'beta', body: 'private', idempotencyKey: 'rt-2', ttlSeconds: 3600 })

    // gamma is neither the parent's origin nor its target, so the id resolves to
    // nothing for it: answering a message you were never party to is refused on
    // the client's own lookup instead of queueing an orphan reply.
    await assert.rejects(() => gamma.replyTo(sent, '我插一句'), /no such message/i)
    // An id that does not exist at all is an error, not a silent success.
    await assert.rejects(() => alpha.replyTo('f'.repeat(32), 'x'), /no such message/i)
    // The legitimate answerer still is the recipient (this is the positive case
    // the first test covers; asserted here only to pin the auth boundary).
    assert.ok(await beta.replyTo(sent, '只有接收方能答'))
  } finally {
    await fx.stop()
  }
})

test('an answer to a reply is refused: only requests open a thread', async () => {
  const fx = await startBroker({ secret: TEST_SECRET })
  const { alpha, beta } = clients(fx.endpoint)
  try {
    const sent = await alpha.sendRequest({ target: 'beta', body: 'question', idempotencyKey: 'rt-3', ttlSeconds: 3600 })
    const [claim] = await beta.pull({ limit: 4 })
    assert.equal(claim.message_id, sent)
    const replyId = await beta.replyTo(sent, 'answer')
    await assert.rejects(() => alpha.replyTo(replyId, '再追问'), /not a request to answer/i)
  } finally {
    await fx.stop()
  }
})
