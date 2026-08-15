import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceLease, workspaceKey, canonicalWorkspace, pidAlive } from '../lib/lease.js'

function temp() {
  const root = mkdtempSync(join(tmpdir(), 'relay-lease-'))
  return { root, dir: join(root, 'ws') }
}

test('tryAcquire succeeds on a fresh workspace and is exclusive per path', () => {
  const { root, dir } = temp()
  try {
    const a = WorkspaceLease.tryAcquire(root, dir, 'task-1')
    assert.ok(a.lease, 'first acquire must succeed')
    assert.equal(a.owner, null)
    // Second acquire of the same workspace is blocked by the live owner.
    const b = WorkspaceLease.tryAcquire(root, dir, 'task-2')
    assert.equal(b.lease, null)
    assert.ok(b.owner)
    // A different workspace acquires fine.
    const c = WorkspaceLease.tryAcquire(root, join(root, 'other'), 'task-3')
    assert.ok(c.lease)
    c.lease.release()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('release allows re-acquire; heartbeat refreshes mtime', async () => {
  const { root, dir } = temp()
  try {
    const a = WorkspaceLease.tryAcquire(root, dir, 't')
    assert.ok(a.lease)
    const before = (await import('node:fs')).statSync(a.lease.path).mtimeMs
    await new Promise((r) => setTimeout(r, 20))
    a.lease.heartbeat()
    const after = (await import('node:fs')).statSync(a.lease.path).mtimeMs
    assert.ok(after >= before)
    a.lease.release()
    const again = WorkspaceLease.tryAcquire(root, dir, 't')
    assert.ok(again.lease, 'after release the lease must be acquirable')
    again.lease.release()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a lock from a dead process is recovered', () => {
  const { root, dir } = temp()
  try {
    // Craft a lock file owned by a dead pid.
    const path = join(root, `${workspaceKey(dir)}.lock`)
    writeFileSync(path, JSON.stringify({ owner_id: 'dead', pid: 999999999, task_id: 'x', workspace: dir }), 'utf8')
    assert.equal(pidAlive(999999999), false)
    const a = WorkspaceLease.tryAcquire(root, dir, 't')
    assert.ok(a.lease, 'a dead owner lock must be recovered')
    a.lease.release()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('canonicalWorkspace / workspaceKey are stable and case-insensitive', () => {
  const p = join('C:', 'Users', 'Me', 'ws')
  const k1 = workspaceKey(p)
  const k2 = workspaceKey(p.toLowerCase())
  assert.equal(k1, k2)
  assert.match(k1, /^[0-9a-f]{24}$/)
  assert.equal(canonicalWorkspace(join('a', 'b')), join(process.cwd(), 'a', 'b'))
})
