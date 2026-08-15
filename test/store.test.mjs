import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createStore, normalizeEnvelope } from '../broker/src/store.js'

const require = createRequire(import.meta.url)
// Node 20 has no node:sqlite, and 22.5–22.12 gate it behind a flag. These tests
// assert SQLite-specific behavior, so skip them where the backend is unavailable
// (the JSONL fallback is covered by the non-skipped persistence tests).
let sqliteAvailable = false
try { require('node:sqlite'); sqliteAvailable = true } catch {}

function tempStore(ttlDays = 7) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-store-'))
  const store = createStore({ ttlDays, persist: true, dataDir: dir })
  return { store, dir }
}

function msg(id, from, to, ts = new Date().toISOString(), type = 'message') {
  return normalizeEnvelope({ id, from, to, ts, type, body: { text: 'x' } }, from, ts)
}

test('store: add / dedup / findById', () => {
  const { store, dir } = tempStore()
  try {
    const a = store.add(msg('id-1', 'alpha', 'beta'))
    assert.equal(a.added, true)
    const b = store.add(msg('id-1', 'alpha', 'beta'))
    assert.equal(b.added, false)
    assert.equal(b.duplicate, true)
    assert.equal(store.findById('id-1').to, 'beta')
    assert.equal(store.findById('nope'), null)
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('store: getSince is incremental and per-recipient', () => {
  const { store, dir } = tempStore()
  try {
    store.add(msg('m1', 'alpha', 'beta'))
    store.add(msg('m2', 'beta', 'alpha'))
    store.add(msg('m3', 'alpha', 'beta'))
    const r1 = store.getSince('beta', null, 50)
    assert.deepEqual(r1.messages.map((m) => m.id), ['m1', 'm3'])
    const r2 = store.getSince('beta', r1.cursor, 50)
    assert.deepEqual(r2.messages.map((m) => m.id), [])
    const r3 = store.getSince('alpha', null, 50)
    assert.deepEqual(r3.messages.map((m) => m.id), ['m2'])
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('store: legacy polling skips leased messages without permanently losing them after lease expiry', () => {
  const { store, dir } = tempStore()
  try {
    store.add(msg('m1', 'alpha', 'beta'))
    store.add(msg('m2', 'alpha', 'beta'))
    store.pull('beta', 1, 1)
    const firstPoll = store.getSince('beta', null, 50)
    assert.deepEqual(firstPoll.messages.map((message) => message.id), ['m2'])

    store.findById('m1').leaseUntil = Date.now() - 1
    store.leaseSweep()
    assert.deepEqual(
      store.getSince('beta', firstPoll.cursor, 50).messages.map((message) => message.id),
      ['m1'],
    )
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('store: persists across restarts (JSONL)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-persist-'))
  let s1
  let s2
  try {
    s1 = createStore({ ttlDays: 7, persist: true, storage: 'jsonl', dataDir: dir })
    s1.add(msg('p1', 'alpha', 'beta'))
    s1.close()
    s2 = createStore({ ttlDays: 7, persist: true, storage: 'jsonl', dataDir: dir })
    assert.equal(s2.findById('p1').to, 'beta')
  } finally { s1?.close(); s2?.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('store: SQLite persistence survives restart', { skip: !sqliteAvailable }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-sqlite-'))
  try {
    const options = { ttlDays: 7, persist: true, storage: 'sqlite', dataDir: dir, maxAttempts: 3 }
    const first = createStore(options)
    first.add(msg('sqlite-1', 'alpha', 'beta'))
    first.close()
    const second = createStore(options)
    assert.equal(second.findById('sqlite-1').to, 'beta')
    assert.ok(existsSync(join(dir, 'relay.db')))
    first.close(); second.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('store: SQLite creates a missing data directory on first start', { skip: !sqliteAvailable }, () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-sqlite-parent-'))
  const dataDir = join(root, 'new-data-dir')
  let store
  try {
    store = createStore({ ttlDays: 7, persist: true, storage: 'sqlite', dataDir, maxAttempts: 3 })
    assert.equal(store.storage, 'sqlite')
    assert.ok(existsSync(join(dataDir, 'relay.db')))
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('store: selected SQLite backend fails closed when its data path cannot open', { skip: !sqliteAvailable }, () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-sqlite-fail-'))
  const notDirectory = join(root, 'plain-file')
  try {
    writeFileSync(notDirectory, 'not a directory', 'utf8')
    assert.throws(
      () => createStore({ ttlDays: 7, persist: true, storage: 'sqlite', dataDir: notDirectory, maxAttempts: 3 }),
      /SQLite storage initialization failed/,
    )
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('store: TTL sweep drops expired messages', () => {
  const { store, dir } = tempStore(1)
  try {
    const expired = msg('t1', 'alpha', 'beta')
    expired.ts = new Date(Date.now() - 2 * 86_400_000).toISOString()
    store.add(expired)
    store.add(msg('t2', 'alpha', 'beta'))
    store.sweepExpired()
    assert.equal(store.findById('t1'), null)
    assert.equal(store.findById('t2').id, 't2')
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('store: lease state survives restart for each persistent backend', () => {
  for (const storage of ['jsonl', 'sqlite']) {
    const dir = mkdtempSync(join(tmpdir(), `relay-${storage}-state-`))
    const options = { ttlDays: 7, persist: true, storage, dataDir: dir, maxAttempts: 3 }
    let first
    let second
    let third
    try {
      first = createStore(options)
      first.add(msg(`state-${storage}`, 'alpha', 'beta'))
      let lease = first.pull('beta', 1, 600)[0]
      assert.equal(first.ack(`state-${storage}`, lease.leaseId, 'retry').status, 'queued')
      first.close()

      second = createStore(options)
      assert.deepEqual(second.getStatus([`state-${storage}`]), [{
        id: `state-${storage}`,
        status: 'queued',
        attempts: 1,
        ts: second.findById(`state-${storage}`).ts,
        from: 'alpha',
        to: 'beta',
        kind: 'message',
      }])
      lease = second.pull('beta', 1, 600)[0]
      assert.equal(second.ack(`state-${storage}`, lease.leaseId, 'completed').status, 'done')
      second.close()

      third = createStore(options)
      assert.equal(third.findById(`state-${storage}`).status, 'done')
      assert.equal(third.findById(`state-${storage}`).attempts, 1)
    } finally {
      first?.close(); second?.close(); third?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('normalizeEnvelope: fills id/from/ts and validates', () => {
  const full = normalizeEnvelope({ id: 'x', to: 'b', from: 'a', ts: 't', type: 'message', body: {}, ack: true }, 'a', 'now')
  assert.deepEqual(full, {
    id: 'x', from: 'a', to: 'b', ts: 'now', type: 'message', body: {}, replyTo: null, ack: true,
    kind: 'message', rootId: null, parentId: null, status: 'queued', attempts: 0, leaseUntil: null, leaseId: null,
  })
  const short = normalizeEnvelope({ to: 'b', body: { text: 'hi' } }, 'a', 'now')
  assert.equal(short.from, 'a')
  assert.equal(short.type, 'message')
  assert.equal(short.replyTo, null)
  assert.equal(short.status, 'queued')
  assert.equal(short.kind, 'message')
  const req = normalizeEnvelope({ to: 'b', kind: 'request', rootId: 'r', parentId: 'p' }, 'a', 'now')
  assert.equal(req.kind, 'request')
  assert.equal(req.rootId, 'r')
  assert.equal(req.parentId, 'p')
  assert.throws(() => normalizeEnvelope({ to: 'b', kind: 'bogus' }, 'a', 'now'), /kind must be/)
  assert.throws(() => normalizeEnvelope({}, 'a', 'now'), /to is required/)
  assert.throws(() => normalizeEnvelope(null, 'a', 'now'), /must be a JSON object/)
})
