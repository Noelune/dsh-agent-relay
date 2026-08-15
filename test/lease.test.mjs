import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, normalizeEnvelope } from '../broker/src/store.js'

function tempStore(maxAttempts = 3) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-lease-'))
  const store = createStore({ ttlDays: 7, persist: false, dataDir: dir, maxAttempts })
  return { store, dir }
}

function msg(id, from, to, opts = {}) {
  return normalizeEnvelope({ id, from, to, ts: new Date().toISOString(), ...opts }, from, new Date().toISOString())
}

test('lease: pull marks queued messages as leased and returns them once', () => {
  const { store, dir } = tempStore()
  try {
    store.add(msg('1', 'alpha', 'beta'))
    store.add(msg('2', 'gamma', 'delta')) // not addressed to beta
    store.add(msg('3', 'alpha', 'beta'))
    const pulled = store.pull('beta', 10, 600)
    assert.equal(pulled.length, 2)
    assert.deepEqual(pulled.map((m) => m.id).sort(), ['1', '3'])
    assert.ok(pulled.every((m) => m.status === 'leased' && m.leaseUntil > Date.now()))
    // Second pull returns nothing — the leased ones are not re-delivered.
    assert.equal(store.pull('beta', 10, 600).length, 0)
    // v1.0 GET /messages also stops seeing leased ones.
    assert.equal(store.getSince('beta', null, 10).messages.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('lease: ack completed -> done; retry -> attempts+1; over max -> failed', () => {
  const { store, dir } = tempStore(1) // maxAttempts = 1
  try {
    store.add(msg('1', 'alpha', 'beta'))
    store.pull('beta', 10, 600)
    let r = store.ack('1', 'retry')
    assert.equal(r.status, 'queued')
    assert.equal(r.attempts, 1)
    assert.equal(store.pull('beta', 10, 600).length, 1) // re-queued, re-pullable
    r = store.ack('1', 'retry')
    assert.equal(r.status, 'failed') // attempts now 2 > maxAttempts 1
    assert.equal(r.attempts, 2)
    assert.equal(store.pull('beta', 10, 600).length, 0) // failed not re-delivered
    // completed
    store.add(msg('2', 'alpha', 'beta'))
    store.pull('beta', 10, 600)
    r = store.ack('2', 'completed')
    assert.equal(r.status, 'done')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('lease: expired lease re-queues the message', async () => {
  const { store, dir } = tempStore()
  try {
    store.add(msg('1', 'alpha', 'beta'))
    store.pull('beta', 10, 0) // 0s lease -> leaseUntil ~ now
    assert.equal(store.pull('beta', 10, 600).length, 0)
    await new Promise((r) => setTimeout(r, 10)) // let the 0s lease expire
    store.leaseSweep()
    const re = store.pull('beta', 10, 600)
    assert.equal(re.length, 1)
    assert.equal(re[0].id, '1')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('lease: ack requires the id to exist and validates outcome', () => {
  const { store, dir } = tempStore()
  try {
    assert.equal(store.ack('missing', 'completed').ok, false)
    assert.equal(store.ack('missing', 'completed').code, 'no_such_message')
    store.add(msg('1', 'alpha', 'beta'))
    assert.equal(store.ack('1', 'bogus').ok, false)
    assert.equal(store.ack('1', 'bogus').code, 'bad_request')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('lease: getStatus reports state; getRecent and query filter', () => {
  const { store, dir } = tempStore()
  try {
    store.add(msg('1', 'alpha', 'beta', { kind: 'request', rootId: 'r1' }))
    store.add(msg('2', 'gamma', 'beta', { kind: 'reply', parentId: '1' }))
    store.pull('beta', 10, 600)
    const st = store.getStatus(['1', '2', 'nope'])
    assert.equal(st.find((s) => s.id === '1').status, 'leased')
    assert.equal(st.find((s) => s.id === 'nope').status, 'not_found')
    assert.equal(st.find((s) => s.id === '2').kind, 'reply')
    assert.equal(store.getRecent('beta', 10).length, 2)
    assert.equal(store.query({ agent: 'beta', kind: 'request' }).length, 1)
    assert.equal(store.query({ agent: 'beta', status: 'leased' }).length, 2)
    assert.equal(store.query({ agent: 'beta', from: 'alpha' }).length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
