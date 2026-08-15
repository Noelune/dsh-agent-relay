#!/usr/bin/env node
/**
 * Migrate a self-use Python broker's message database into the Node broker's
 * v2 store (relay-v2.db).
 *
 * Usage:
 *   node setup/migrate-v2.mjs --source <self-use agent-relay.db> --data-dir <repo broker dataDir>
 *
 * Reads every row from the self-use `relay_messages` table and inserts it into
 * the repo v2 store's `relay_v2_messages` table (preserving state, attempts,
 * timestamps, idempotency). Requires Node with built-in SQLite (>= 22.13).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--source') out.source = argv[++i]
    else if (argv[i] === '--data-dir') out.dataDir = argv[++i]
    else if (argv[i] === '--help') out.help = true
  }
  return out
}

const COLUMNS = [
  'message_id', 'root_id', 'parent_id', 'origin', 'target', 'kind', 'body',
  'session_ref', 'execution_mode', 'context', 'topic', 'idempotency_key',
  'status', 'attempts', 'lease_until', 'last_error', 'created_at',
  'expires_at', 'completed_at', 'notified_at',
]

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.source || !args.dataDir) {
    console.error('usage: node setup/migrate-v2.mjs --source <agent-relay.db> --data-dir <repo dataDir>')
    process.exit(2)
  }
  if (!existsSync(args.source)) {
    console.error(`source database not found: ${args.source}`)
    process.exit(2)
  }
  const targetPath = join(args.dataDir, 'relay-v2.db')
  const { DatabaseSync } = require('node:sqlite')

  const src = new DatabaseSync(args.source, { readOnly: true })
  const target = new DatabaseSync(targetPath)
  try {
    target.exec(`
      CREATE TABLE IF NOT EXISTS relay_v2_messages (
        message_id TEXT PRIMARY KEY,
        root_id TEXT NOT NULL,
        parent_id TEXT,
        origin TEXT NOT NULL,
        target TEXT NOT NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        session_ref TEXT,
        execution_mode TEXT NOT NULL DEFAULT 'read',
        context TEXT NOT NULL DEFAULT '',
        topic TEXT NOT NULL DEFAULT '',
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_until REAL,
        last_error TEXT,
        created_at REAL NOT NULL,
        expires_at REAL NOT NULL,
        completed_at REAL,
        notified_at REAL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_idempotency ON relay_v2_messages(origin, idempotency_key);
    `)
    const rows = src.prepare('SELECT * FROM relay_messages').all()
    const insert = target.prepare(
      `INSERT OR IGNORE INTO relay_v2_messages (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`,
    )
    let imported = 0
    let skipped = 0
    for (const row of rows) {
      const values = COLUMNS.map((col) => row[col] ?? null)
      const info = insert.run(...values)
      if (info.changes > 0) imported += 1
      else skipped += 1
    }
    target.exec('PRAGMA journal_mode=WAL')
    console.log(`migrated ${imported} message(s) from ${args.source} -> ${targetPath} (${skipped} duplicate idempotency row(s) skipped)`)
  } finally {
    src.close()
    target.close()
  }
}

main()
