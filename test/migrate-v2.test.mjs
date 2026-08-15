import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

test('migrate-v2 imports a self-use broker DB into the v2 store preserving state', { skip: !sqliteAvailable() }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-migrate-'))
  try {
    const sourceDb = join(dir, 'agent-relay.db')
    const { DatabaseSync } = require('node:sqlite')
    // Build a self-use-style source DB (relay_messages, same schema/shape).
    const src = new DatabaseSync(sourceDb)
    src.exec(`
      CREATE TABLE relay_messages (
        message_id TEXT PRIMARY KEY, root_id TEXT NOT NULL, parent_id TEXT,
        origin TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
        session_ref TEXT, execution_mode TEXT NOT NULL DEFAULT 'read',
        context TEXT NOT NULL DEFAULT '', topic TEXT NOT NULL DEFAULT '',
        idempotency_key TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        lease_until REAL, last_error TEXT, created_at REAL NOT NULL,
        expires_at REAL NOT NULL, completed_at REAL, notified_at REAL
      );
    `)
    const now = Date.now() / 1000
    const insert = src.prepare('INSERT INTO relay_messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    insert.run('a'.repeat(32), 'r1', null, 'alpha', 'beta', 'request', 'queued body', 's', 'read', '', '', 'key:1', 'queued', 0, null, null, now, now + 3600, null, null)
    insert.run('b'.repeat(32), 'r2', null, 'alpha', 'beta', 'request', 'done body', 's', 'write', '', 't', 'key:2', 'completed', 3, null, null, now - 100, now + 100, now, null)
    src.close()

    const result = spawnSync(process.execPath, ['setup/migrate-v2.mjs', '--source', sourceDb, '--data-dir', dir], { cwd: repoRoot, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /migrated 2 message\(s\)/)

    // The v2 store must load the migrated messages with state preserved.
    const { createV2Store } = await import('../broker/src/store-v2.js')
    const store = createV2Store({ dataDir: dir, persist: true })
    const queued = store.get('a'.repeat(32))
    assert.equal(queued.status, 'queued')
    assert.equal(queued.origin, 'alpha')
    assert.equal(queued.target, 'beta')
    assert.equal(queued.kind, 'request')
    const done = store.get('b'.repeat(32))
    assert.equal(done.status, 'completed')
    assert.equal(done.attempts, 3)
    assert.equal(done.topic, 't')
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function sqliteAvailable() {
  try {
    require('node:sqlite')
    return true
  } catch {
    return false
  }
}
