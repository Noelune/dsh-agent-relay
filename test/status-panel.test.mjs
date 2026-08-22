import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRelayStatusSnapshot,
  mapRelayMessage,
  mapRelayPeer,
  sanitizeRelayError,
} from '../lib/status-panel.js'

test('status snapshot maps queue data without exposing secrets', () => {
  const snapshot = buildRelayStatusSnapshot({
    cfg: { endpoint: 'http://relay-user:never-return-this@127.0.0.1:19121', agent: 'dsh', secret: 'never-return-this' },
    peers: [{ agent: 'codex', online: true, last_seen_seconds: 2, queued: 3, leased: 1, failed: 0, expired: 2 }],
    messages: [{ message_id: 'aabbccddeeff00112233445566778899', origin: 'dsh', target: 'codex', kind: 'request', status: 'completed', created_at: 1710000000, body: 'private body', context: 'private context' }],
    protocolVersion: 2,
    lastError: 'secret=never-return-this',
    connected: true,
    now: new Date('2024-03-09T16:00:00.000Z'),
  })
  assert.equal(snapshot.broker.connected, true)
  assert.equal(snapshot.broker.protocolVersion, 2)
  assert.equal('endpoint' in snapshot.broker, false)
  assert.deepEqual(snapshot.peers[0], { agent: 'codex', online: true, lastSeenSeconds: 2, queued: 3, leased: 1, failed: 0, expired: 2 })
  assert.deepEqual(snapshot.recentMessages[0], { direction: 'out', peer: 'codex', kind: 'request', status: 'completed', timestamp: '2024-03-09T16:00:00.000Z' })
  assert.ok(!JSON.stringify(snapshot).includes('never-return-this'))
  assert.ok(!JSON.stringify(snapshot).includes('private body'))
  assert.ok(!JSON.stringify(snapshot).includes('private context'))
})

test('status mappers normalize partial broker records and cap lists', () => {
  assert.deepEqual(mapRelayPeer({ agent: 'claude' }), { agent: 'claude', online: false, lastSeenSeconds: null, queued: 0, leased: 0, failed: 0, expired: 0 })
  assert.deepEqual(mapRelayMessage({ message_id: 'm-1234567890', origin: 'hermes', target: 'dsh', created_at: 1710000000 }, 'dsh'), { direction: 'in', peer: 'hermes', kind: 'message', status: 'unknown', timestamp: '2024-03-09T16:00:00.000Z' })
  const snapshot = buildRelayStatusSnapshot({
    cfg: { endpoint: 'http://127.0.0.1:19121', agent: 'dsh' },
    peers: Array.from({ length: 25 }, (_, index) => ({ agent: `peer-${index}` })),
    messages: Array.from({ length: 25 }, (_, index) => ({ message_id: `message-${index}`, origin: 'dsh', target: 'codex', created_at: 1710000000 })),
    connected: true,
  })
  assert.equal(snapshot.peers.length, 20)
  assert.equal(snapshot.recentMessages.length, 20)
})

test('host route builds the complete status snapshot', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(source, /async function statusPayload\(\)/)
  assert.match(source, /buildRelayStatusSnapshot\(/)
  assert.match(source, /\/api\/dsh-agent-relay\/status/)
  assert.match(source, /await statusPayload\(\)/)
  assert.match(source, /inject = \['tools', 'agents', 'systemPrompt', 'timer', 'webServer'\]/)
  assert.match(source, /ctx\.webServer\.register\(/)
})

test('sanitizeRelayError removes credential-like values and truncates output', () => {
  assert.equal(sanitizeRelayError(''), null)
  for (const [value, secret] of [
    ['token: abcdef', 'abcdef'],
    ['Authorization: Bearer auth-secret-123', 'auth-secret-123'],
    ['Cookie: relay_session=cookie-secret-123; theme=dark', 'cookie-secret-123'],
    ['X-Agent-Relay-Signature: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'],
    ['lease_token=lease-secret-123', 'lease-secret-123'],
    ['session_ref=private-session', 'private-session'],
    ['broker rejected 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'],
  ]) assert.ok(!sanitizeRelayError(value).includes(secret))
  assert.ok(!sanitizeRelayError('Bearer xyz.123').includes('xyz.123'))
  assert.equal(sanitizeRelayError('x'.repeat(300)).length, 240)
})
