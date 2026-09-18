import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  relaySessionId, isRelaySessionId, normalizeMessage, buildInboundPrompt,
  extractReplyText, createJsonStore, RELAY_SESSION_PREFIX,
} from '../lib/relay-plugin-core.js'

test('relaySessionId / isRelaySessionId', () => {
  assert.equal(relaySessionId('abc123'), 'agent-relay-abc123')
  assert.ok(isRelaySessionId('agent-relay-xyz'))
  assert.ok(!isRelaySessionId('user-session'))
  assert.ok(!isRelaySessionId(null))
})

test('normalizeMessage defaults all fields', () => {
  const m = normalizeMessage({ message_id: 'm1', origin: 'a', target: 'b', kind: 'request' })
  assert.equal(m.message_id, 'm1')
  assert.equal(m.root_id, '')
  assert.equal(m.parent_id, null)
  assert.equal(m.execution_mode, 'read')
  assert.equal(m.body, '')
  assert.equal(m.topic, '')
  // Lowercases execution_mode and keeps parent_id null when absent.
  assert.equal(normalizeMessage({ execution_mode: 'Write' }).execution_mode, 'write')
})

test('buildInboundPrompt frames read vs write and includes context', () => {
  const read = buildInboundPrompt({ origin: 'codex', message_id: 'm1', body: 'please review', execution_mode: 'read' })
  assert.ok(read.includes('read-only'))
  assert.ok(read.includes("from agent 'codex'"))
  assert.ok(read.includes('please review'))
  const write = buildInboundPrompt({ origin: 'codex', message_id: 'm2', body: 'edit this', execution_mode: 'write', context: 'path: /x' })
  assert.ok(write.includes('may modify only the assigned workspace'))
  assert.ok(write.includes('path: /x'))
})

test('extractReplyText returns the latest assistant text after the boundary', () => {
  const session = {
    events: [
      { seq: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'user' }] } } },
      { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'first' }] } } },
      { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'final answer' }, { type: 'tool_use' }] } } },
    ],
  }
  assert.equal(extractReplyText(session, 0), 'final answer')
  assert.equal(extractReplyText(session, 3), 'final answer')
  assert.equal(extractReplyText(session, 4), '')
  assert.equal(extractReplyText(null, 0), '')
})

/**
 * Host contract: DSH core 0.1.5-rc.2 dropped the iterable `session.events` in
 * favour of `snapshotEvents(fromSeq)`. That silently broke reply extraction —
 * the relay claimed a session, got no text back and the requester saw a timeout.
 * Both host shapes must keep working, and `fromSeq` is boundary-inclusive.
 */
test('extractReplyText supports the snapshotEvents(fromSeq) host accessor', () => {
  const events = [
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'stale' }] } } },
    { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'answer from snapshot' }] } } },
  ]
  const session = { snapshotEvents: (fromSeq) => events.filter((e) => e.seq >= fromSeq) }
  assert.equal(extractReplyText(session, 0), 'answer from snapshot')
  assert.equal(extractReplyText(session, 3), 'answer from snapshot')
  assert.equal(extractReplyText(session, 4), '')

  // The accessor is preferred; a session exposing both must not double-read.
  const both = { events: [{ seq: 9, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'from array' }] } } }], snapshotEvents: (from) => events.filter((e) => e.seq >= from) }
  assert.equal(extractReplyText(both, 0), 'answer from snapshot')
})

test('extractReplyText survives a throwing or empty host accessor', () => {
  assert.equal(extractReplyText({ snapshotEvents: () => { throw new Error('host moved on') } }, 0), '')
  assert.equal(extractReplyText({ snapshotEvents: () => undefined }, 0), '')
  assert.equal(extractReplyText({}, 0), '')
})

test('createJsonStore persists, TTL-expires, and is atomic', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-store-'))
  const file = join(dir, 'store.json')
  try {
    const s1 = createJsonStore(file, { keyField: 'receipts', ttlMs: 1000 })
    s1.set('a', { id: 'a', completed_at: Date.now() })
    s1.set('old', { id: 'old', _ts: Date.now() - 5000, completed_at: Date.now() - 5000 })
    assert.equal(s1.size(), 1)

    const s2 = createJsonStore(file, { keyField: 'receipts', ttlMs: 1000 })
    assert.equal(s2.get('a').id, 'a')
    assert.equal(s2.get('old'), null, 'expired entry must not survive reload')
    s2.delete('a')
    assert.equal(s2.size(), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
