/**
 * The store's contract since 2026-09-19: SQLite holds message state and there
 * is no second copy in the process. These tests pin the invariants that the old
 * "Map is the truth, the database is a mirror" design could not satisfy — if a
 * regression reintroduces in-memory state, the raw-connection assertions fail.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createV2Store } from '../broker/src/store-v2.js'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-v2truth-'))
  const store = createV2Store({ dataDir: dir, persist: true, leaseSeconds: 600, maxAttempts: 3 })
  try {
    return run(store, dir)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function msg(over = {}) {
  const now = Date.now() / 1000
  return {
    message_id: `m-${Math.random().toString(36).slice(2, 10)}`, root_id: 'r1', parent_id: null,
    origin: 'alpha', target: 'beta', kind: 'request', body: 'x', session_ref: '',
    created_at: now, expires_at: now + 3600, execution_mode: 'read', context: '', topic: '', ...over,
  }
}

test('a pull writes the lease to the table: an outside connection sees exactly what the caller got', () => {
  withStore((store, dir) => {
    const created = store.create(msg({ message_id: 'm-lease' }), 'k-lease')
    assert.equal(created.created, true)
    const [leased] = store.pull('beta', Date.now() / 1000, { limit: 1 })
    assert.equal(leased.status, 'leased')
    assert.ok(leased.lease_token)

    // A separate connection is the only way to prove the row — not a process
    // cache — is what the puller was handed.
    const raw = new DatabaseSync(join(dir, 'relay-v2.db'))
    try {
      const row = raw.prepare('SELECT status, attempts, lease_token, lease_until FROM relay_v2_messages WHERE message_id=?').get('m-lease')
      assert.deepEqual({ ...row }, { status: 'leased', attempts: 1, lease_token: leased.lease_token, lease_until: leased.lease_until })
    } finally {
      raw.close()
    }
  })
})

test('state an outside connection writes is what the store reports: no in-memory copy', () => {
  withStore((store, dir) => {
    store.create(msg({ message_id: 'm-ext' }), 'k-ext')
    const raw = new DatabaseSync(join(dir, 'relay-v2.db'))
    raw.prepare("UPDATE relay_v2_messages SET status='failed', attempts=7, last_error='written elsewhere' WHERE message_id='m-ext'").run()
    raw.close()

    const m = store.get('m-ext')
    assert.equal(m.status, 'failed')
    assert.equal(m.attempts, 7)
    // statusFor reads the same row, so an admin panel and the queue cannot disagree.
    assert.equal(store.statusFor('alpha', ['m-ext'])[0].last_error, 'written elsewhere')
  })
})

test('retention removes rows from the table, not only from a cache', () => {
  withStore((store, dir) => {
    const now = Date.now() / 1000
    store.create(msg({ message_id: 'm-old' }), 'k-old')
    store.pull('beta', now, { limit: 1 })
    store.ack('m-old', 'beta', 'completed', null, now)
    const raw = new DatabaseSync(join(dir, 'relay-v2.db'))
    try {
      assert.equal(raw.prepare('SELECT COUNT(*) n FROM relay_v2_messages').get().n, 1)
      store.cleanup(now + 31 * 86400)
      assert.equal(raw.prepare('SELECT COUNT(*) n FROM relay_v2_messages').get().n, 0)
    } finally {
      raw.close()
    }
    assert.equal(store.get('m-old'), null)
    assert.deepEqual(store.queueStats(['beta']).beta, { queued: 0, leased: 0, completed: 0, failed: 0, expired: 0, oldest_queued_at: null })
  })
})

test('cleanup is set-based: bulk expiry and exhausted attempts land in one pass', () => {
  withStore((store) => {
    const now = Date.now() / 1000
    for (let i = 0; i < 20; i += 1) {
      store.create(msg({ message_id: `m-exp-${i}`, created_at: now - 7200, expires_at: now - 60 }), `k-exp-${i}`)
    }
    for (let i = 0; i < 5; i += 1) {
      store.create(msg({ message_id: `m-att-${i}` }), `k-att-${i}`)
      store.pull('beta', now, { limit: 1 })
      store.ack(`m-att-${i}`, 'beta', 'retry', 'boom', now)
      store.pull('beta', now, { limit: 1 })
      store.ack(`m-att-${i}`, 'beta', 'retry', 'boom', now)
      store.pull('beta', now, { limit: 1 })
      store.ack(`m-att-${i}`, 'beta', 'retry', 'boom', now)
    }
    store.cleanup(now + 1)
    const statuses = store.queryMessages('alpha', { limit: 100 }).map((m) => m.status)
    assert.equal(statuses.filter((s) => s === 'expired').length, 20)
    assert.equal(statuses.filter((s) => s === 'failed').length, 5)
    // Not one of them is claimable any more.
    assert.equal(store.pull('beta', now + 1, { limit: 8 }).length, 0)
  })
})

test('counters and presence are metrics, not message state, and survive no DB write', () => {
  withStore((store, dir) => {
    const now = Date.now() / 1000
    store.create(msg({ message_id: 'm-metrics' }), 'k-metrics')
    assert.equal(store.counters.messages_created, 1)
    store.create(msg({ message_id: 'm-metrics-2' }), 'k-metrics')
    assert.deepEqual(store.counters, { messages_created: 1, messages_duplicate: 1, pulls: 0, acks_completed: 0, acks_retry: 0 })
    store.pull('beta', now, { limit: 1 })
    assert.equal(store.counters.pulls, 1)
    assert.ok(Math.abs(store.lastPullAt.beta - now) < 2)

    // The database holds only messages: no metrics table appeared.
    const raw = new DatabaseSync(join(dir, 'relay-v2.db'))
    try {
      const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
      assert.deepEqual(tables, ['relay_v2_messages'])
    } finally {
      raw.close()
    }
  })
})
