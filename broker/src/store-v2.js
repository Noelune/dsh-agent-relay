/**
 * v2 message store — full lifecycle, SQLite-backed.
 *
 * State machine: queued →(pull) leased →(ack completed) completed
 *                        └→(ack retry) queued (attempts+1; >= max → failed)
 *                queued/leased →(expires_at reached) expired
 *                failed/expired →(admin requeue) queued
 *
 * The database is the *only* copy of message state. Until this rewrite an
 * in-memory Map was the working copy and SQLite a mirror written on every
 * transition, which meant two answers to "what is the state of this message"
 * and a restart-dependent difference between them. Rows are now read and
 * written through one set of statements, so the queue has a single truth and
 * the broker keeps no per-message memory at all.
 *
 * `persist: false` selects `:memory:` rather than a second code path: the
 * statements, the state machine and the cleanup rules are identical in tests
 * and in production, which is the whole point of having one store.
 */
import { mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// Loaded defensively so that an old Node reports *why* it failed instead of a
// bare MODULE_NOT_FOUND; there is no second storage engine to fall back to.
const DatabaseSync = (() => {
  try {
    return require('node:sqlite').DatabaseSync
  } catch {
    return null
  }
})()

const STATUS = {
  QUEUED: 'queued',
  LEASED: 'leased',
  COMPLETED: 'completed',
  FAILED: 'failed',
  EXPIRED: 'expired',
}
const RETENTION_SECONDS = 30 * 86400
const RECENT_WINDOW_SECONDS = 7 * 86400
const MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000

const COLUMNS = `message_id, root_id, parent_id, origin, target, kind, body, session_ref,
  execution_mode, allow_shared_write, context, topic, idempotency_key, status, attempts,
  lease_until, lease_token, last_error, created_at, expires_at, completed_at, notified_at`

// `idx_v2_claim` is (target, status, created_at) on purpose: two equality
// prefixes and then the index order *is* the delivery order, so a pull walks the
// index and stops once it has `limit` rows. The shape this replaces — a range
// test on expires_at ahead of created_at — made every claim re-sort all ready
// rows. `expires_at` stays a residual filter because `cleanup()` has already
// moved past-due rows to `expired`.
const SCHEMA = `
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
  CREATE INDEX IF NOT EXISTS idx_v2_claim ON relay_v2_messages(target, status, created_at);
`

export function createV2Store({ dataDir, persist = true, leaseSeconds = 600, maxAttempts = 3 }) {
  // node:sqlite ships with Node >= 22.13; there is no second storage engine.
  if (typeof DatabaseSync !== 'function') {
    throw new Error('node:sqlite is unavailable — the broker requires Node >= 22.13 (built-in SQLite)')
  }
  const maxAttemptsValue = Math.max(1, Number(maxAttempts))
  const leaseSecondsValue = Math.max(15, Number(leaseSeconds))
  // Process-local presence and counters — queue metrics, not message state, so
  // they deliberately stay out of the table. `lastPullAt` backs presence and the
  // on-demand wake gate; a restart only makes it conservative (it re-wakes a
  // recipient rather than assuming someone is polling).
  const lastPullAt = new Map()
  const counters = { messages_created: 0, messages_duplicate: 0, pulls: 0, acks_completed: 0, acks_retry: 0 }

  if (persist) mkdirSync(dataDir, { recursive: true })
  const db = new DatabaseSync(persist ? join(dataDir, 'relay-v2.db') : ':memory:')
  // synchronous stays at SQLite's FULL default: this is a durable queue, and a
  // benchmark that says otherwise is measuring a 3,000-message backlog that no
  // local circle ever builds (one fsync per commit is ~2 ms, and the pull path
  // batches its claims into a single commit — see `tx`).
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000;')
  db.exec(SCHEMA)
  // lease_token / allow_shared_write came with the v3 protocol: add them to
  // databases created before it existed (a no-op on the current schema).
  const known = new Set(db.prepare('PRAGMA table_info(relay_v2_messages)').all().map((row) => String(row.name)))
  if (!known.has('allow_shared_write')) db.exec('ALTER TABLE relay_v2_messages ADD COLUMN allow_shared_write INTEGER NOT NULL DEFAULT 0')
  if (!known.has('lease_token')) db.exec('ALTER TABLE relay_v2_messages ADD COLUMN lease_token TEXT')
  // ...and retire the pre-rewrite index shape once (SCHEMA already created the
  // replacement above, so this is safe on every start).
  if (new Set(db.prepare('PRAGMA index_list(relay_v2_messages)').all().map((row) => String(row.name))).has('idx_v2_ready')) {
    db.exec('DROP INDEX idx_v2_ready')
  }

  // Prepared once: the pull/ack path runs these per request.
  const stmt = {
    get: db.prepare(`SELECT ${COLUMNS} FROM relay_v2_messages WHERE message_id=?`),
    byIdem: db.prepare('SELECT message_id FROM relay_v2_messages WHERE origin=? AND idempotency_key=?'),
    insert: db.prepare(`INSERT INTO relay_v2_messages(${COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    // Claim one ready message and hand it back, in a single statement. The
    // token is a fresh delivery credential (v3): acks and renewals must present
    // it while the lease is active, so a stale or duplicate ack can never
    // mutate the row. `idx_v2_claim` walks the selection in delivery order.
    claim: db.prepare(`
      UPDATE relay_v2_messages
         SET status='leased', attempts=attempts+1, lease_until=?, lease_token=?
       WHERE message_id = (
         SELECT message_id FROM relay_v2_messages
          WHERE target=? AND status='queued' AND expires_at>=? AND attempts<?
            AND (? IS NULL OR root_id=?)
          ORDER BY created_at, message_id LIMIT 1)
      RETURNING ${COLUMNS}`),
    expire: db.prepare(`
      UPDATE relay_v2_messages SET status='expired', lease_until=NULL, lease_token=NULL
       WHERE status IN ('queued', 'leased') AND expires_at < ?`),
    reclaim: db.prepare(`
      UPDATE relay_v2_messages SET status='queued', lease_until=NULL, lease_token=NULL
       WHERE status='leased' AND lease_until IS NOT NULL AND lease_until < ?`),
    exhaust: db.prepare(`
      UPDATE relay_v2_messages
         SET status='failed', lease_until=NULL, lease_token=NULL,
             completed_at=COALESCE(completed_at, ?),
             last_error=COALESCE(last_error, 'attempts exhausted without acknowledgement')
       WHERE status IN ('queued', 'leased') AND attempts >= ?`),
    purge: db.prepare(`
      DELETE FROM relay_v2_messages
       WHERE status IN ('completed', 'expired', 'failed') AND COALESCE(completed_at, created_at) < ?`),
    complete: db.prepare(`
      UPDATE relay_v2_messages SET status='completed', lease_until=NULL, lease_token=NULL,
             completed_at=?, last_error=NULL
       WHERE message_id=?`),
    retryQueue: db.prepare(`
      UPDATE relay_v2_messages SET status='queued', lease_until=NULL, lease_token=NULL, last_error=?
       WHERE message_id=?`),
    retryFail: db.prepare(`
      UPDATE relay_v2_messages SET status='failed', lease_until=NULL, lease_token=NULL,
             completed_at=?, last_error=?
       WHERE message_id=?`),
    renew: db.prepare('UPDATE relay_v2_messages SET lease_until=? WHERE message_id=?'),
    requeue: db.prepare(`
      UPDATE relay_v2_messages
         SET status='queued', attempts=0, lease_until=NULL, lease_token=NULL, notified_at=NULL,
             last_error=COALESCE(last_error, 'requeued by operator')
       WHERE message_id=? AND status IN ('leased', 'failed', 'expired', 'completed')`),
    cancel: db.prepare(`
      UPDATE relay_v2_messages SET status='completed', lease_until=NULL, lease_token=NULL,
             completed_at=?, last_error=COALESCE(last_error, 'cancelled by operator')
       WHERE message_id=? AND status IN ('queued', 'leased', 'failed', 'expired')`),
    notify: db.prepare('UPDATE relay_v2_messages SET notified_at=? WHERE message_id=? AND notified_at IS NULL'),
    failedToNotify: db.prepare(`
      SELECT ${COLUMNS} FROM relay_v2_messages
       WHERE kind='request' AND status IN ('failed', 'expired') AND notified_at IS NULL`),
    statusOne: db.prepare(`SELECT ${COLUMNS} FROM relay_v2_messages WHERE message_id=? AND (origin=? OR target=?)`),
    recent: db.prepare(`
      SELECT ${COLUMNS} FROM relay_v2_messages
       WHERE (origin=? OR target=?) AND created_at >= ?
       ORDER BY created_at DESC, message_id DESC LIMIT ?`),
    stuck: db.prepare(`
      SELECT ${COLUMNS} FROM relay_v2_messages
       WHERE target=? AND status IN ('queued', 'leased', 'failed', 'expired') AND created_at >= ?
       ORDER BY created_at DESC, message_id DESC LIMIT ?`),
    counts: db.prepare('SELECT target, status, COUNT(*) AS n, MIN(created_at) AS oldest FROM relay_v2_messages GROUP BY target, status'),
  }

  // -- rows in, records out ----------------------------------------------

  function record(row) {
    if (!row) return null
    return {
      message_id: row.message_id,
      root_id: row.root_id,
      parent_id: row.parent_id ?? null,
      origin: row.origin,
      target: row.target,
      kind: row.kind,
      body: row.body,
      session_ref: row.session_ref ?? '',
      execution_mode: row.execution_mode,
      allow_shared_write: Boolean(row.allow_shared_write),
      context: row.context ?? '',
      topic: row.topic ?? '',
      idempotency_key: row.idempotency_key,
      status: row.status,
      attempts: row.attempts,
      lease_until: row.lease_until ?? null,
      lease_token: row.lease_token ?? null,
      last_error: row.last_error ?? null,
      created_at: row.created_at,
      expires_at: row.expires_at,
      completed_at: row.completed_at ?? null,
      notified_at: row.notified_at ?? null,
    }
  }

  function summarize(m) {
    return {
      message_id: m.message_id,
      origin: m.origin,
      target: m.target,
      kind: m.kind,
      status: m.status,
      attempts: m.attempts,
      last_error: m.last_error ? String(m.last_error).slice(0, 300) : '',
      created_at: m.created_at,
      expires_at: m.expires_at,
      completed_at: m.completed_at ?? null,
      topic: m.topic || '',
    }
  }

  const select = (statement, ...args) => statement.all(...args).map(record)

  // -- lifecycle ---------------------------------------------------------

  /**
   * Run `body` as one write transaction. A pull is housekeeping plus up to
   * `limit` claims, and those must land together: otherwise a crash between two
   * statements could leave part of a batch leased, and — the reason it also
   * matters for speed — WAL mode fsyncs on every autocommitted statement, so a
   * pull of 8 messages would cost 9 commits instead of 1.
   */
  function tx(body) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const out = body()
      db.exec('COMMIT')
      return out
    } catch (err) {
      try { db.exec('ROLLBACK') } catch { /* already unwound */ }
      throw err
    }
  }

  /**
   * Bring the table up to date with `now`: expiry, lease recovery, exhausted
   * attempts, then retention. One set-based statement per rule replaces the
   * per-message JS loop, and terminal rows past retention leave with their
   * idempotency entry, so the unique index cannot grow without bound.
   */
  function sweep(now) {
    stmt.expire.run(now)
    stmt.reclaim.run(now)
    stmt.exhaust.run(now, maxAttemptsValue)
    stmt.purge.run(now - RETENTION_SECONDS)
  }

  function cleanup(now) {
    tx(() => sweep(now))
  }

  function create(message, idempotencyKey) {
    const origin = String(message.origin)
    const key = String(idempotencyKey)
    const existing = stmt.byIdem.get(origin, key)
    if (existing) {
      counters.messages_duplicate += 1
      return { message_id: existing.message_id, created: false }
    }
    stmt.insert.run(
      String(message.message_id), String(message.root_id ?? ''), message.parent_id ?? null,
      origin, String(message.target), String(message.kind), String(message.body ?? ''),
      String(message.session_ref ?? ''), String(message.execution_mode || 'read').toLowerCase(),
      message.allow_shared_write ? 1 : 0, String(message.context ?? ''), String(message.topic ?? ''),
      key, STATUS.QUEUED, 0, null, null, null,
      Number(message.created_at) || 0, Number(message.expires_at) || 0, null, null,
    )
    counters.messages_created += 1
    return { message_id: String(message.message_id), created: true }
  }

  function get(messageId) {
    return record(stmt.get.get(String(messageId)))
  }

  function pull(target, now, { limit = 8, leaseSeconds: requestedLease, matchRootId = '' } = {}) {
    lastPullAt.set(target, now)
    counters.pulls += 1
    const leaseUntil = now + (requestedLease ?? leaseSecondsValue)
    // A targeted claim lets a caller wait for one specific conversation (the
    // synchronous `relay ask` handoff) without stealing the rest of its inbox,
    // which stays available to a normal poller.
    const wantedRoot = matchRootId ? String(matchRootId) : null
    const wanted = Math.max(1, Math.trunc(Number(limit) || 8))
    return tx(() => {
      sweep(now)
      const out = []
      for (let i = 0; i < wanted; i += 1) {
        const row = stmt.claim.get(leaseUntil, randomBytes(32).toString('base64url'), target, now, maxAttemptsValue, wantedRoot, wantedRoot)
        if (!row) break
        out.push(record(row))
      }
      return out
    })
  }

  function ack(messageId, target, outcome, error, now, leaseToken = '') {
    const m = get(messageId)
    if (!m || m.target !== target) {
      const err = new Error('message is not assigned to this agent')
      err.code = 'forbidden'
      throw err
    }
    if (leaseToken) {
      // v3 strict path: the token from the pull must match and the lease must
      // still be active — one delivery credential, one state transition.
      if (m.status !== STATUS.LEASED || m.lease_token !== leaseToken || m.lease_until == null || m.lease_until < now) {
        const err = new Error('lease is no longer active')
        err.code = 'lease_mismatch'
        throw err
      }
    } else if (m.status !== STATUS.LEASED) {
      // v2 path (no token): a late or duplicated ack must not resurrect a
      // terminal message (e.g. completed → retry after a mid-flight ack).
      const err = new Error('message is not currently leased')
      err.code = 'bad_request'
      throw err
    }
    if (outcome === 'completed') {
      stmt.complete.run(now, m.message_id)
      counters.acks_completed += 1
      return
    }
    if (outcome !== 'retry') {
      const err = new Error('invalid acknowledgement outcome')
      err.code = 'bad_request'
      throw err
    }
    counters.acks_retry += 1
    if (m.attempts >= maxAttemptsValue) {
      stmt.retryFail.run(now, String(error || 'retry exhausted').slice(0, 300), m.message_id)
    } else {
      stmt.retryQueue.run(error ? String(error).slice(0, 300) : null, m.message_id)
    }
  }

  /** Extend the delivery lease of a leased message (v3). Returns the new lease_until. */
  function renewLease(messageId, target, leaseToken, now, seconds) {
    const m = get(messageId)
    const active = m && m.target === target && Boolean(leaseToken)
      && m.status === STATUS.LEASED && m.lease_token === leaseToken
      && m.lease_until != null && m.lease_until >= now
    if (!active) {
      const err = new Error('lease is no longer active')
      err.code = 'lease_mismatch'
      throw err
    }
    const leaseUntil = now + Math.max(15, Math.min(Math.floor(Number(seconds) || leaseSecondsValue), 3600))
    stmt.renew.run(leaseUntil, m.message_id)
    return leaseUntil
  }

  /** Operator reset: attempts go back to zero so an exhausted message can run again. */
  function requeue(messageId) {
    return stmt.requeue.run(String(messageId)).changes > 0
  }

  function cancel(messageId, now) {
    return stmt.cancel.run(now, String(messageId)).changes > 0
  }

  // -- queries -----------------------------------------------------------

  function statusFor(agent, ids) {
    return (ids ?? []).map((raw) => {
      const message_id = String(raw)
      const m = record(stmt.statusOne.get(message_id, agent, agent))
      return m ? summarize(m) : { message_id, status: 'not_found', attempts: 0 }
    })
  }

  function recentFor(agent, now, limit = 20) {
    return select(stmt.recent, agent, agent, now - RECENT_WINDOW_SECONDS, Math.max(1, Math.trunc(Number(limit) || 20))).map(summarize)
  }

  function queryMessages(agent, filters) {
    const where = ['(origin=? OR target=?)']
    const args = [agent, agent]
    for (const [column, value, fold] of [
      ['message_id', filters.message_id, false], ['root_id', filters.root_id, false],
      ['origin', filters.origin, true], ['target', filters.target, true],
      ['kind', filters.kind, true], ['status', filters.status, true],
    ]) {
      if (value === undefined || value === null || value === '') continue
      where.push(`${column}=?`)
      args.push(fold ? String(value).toLowerCase() : String(value))
    }
    // `instr` is a literal substring match, like the old in-memory filter —
    // LIKE would treat a `%` or `_` in a topic as a wildcard.
    if (filters.topic) { where.push('instr(topic, ?) > 0'); args.push(String(filters.topic)) }
    const since = Number(filters.since) || 0
    if (since > 0) { where.push('created_at >= ?'); args.push(since) }
    const limit = Math.max(1, Math.min(Math.trunc(Number(filters.limit) || 50), 100))
    const sql = `SELECT ${COLUMNS} FROM relay_v2_messages WHERE ${where.join(' AND ')} ORDER BY created_at DESC, message_id DESC LIMIT ?`
    return select(db.prepare(sql), ...args, limit).map((m) => ({ ...summarize(m), body: m.body }))
  }

  /** Non-terminal messages targeting `agent` (for admin/status). */
  function stuckFor(agent, now, limit = 50) {
    const wanted = Math.max(1, Math.min(Math.trunc(Number(limit) || 50), 100))
    return select(stmt.stuck, agent, now - RECENT_WINDOW_SECONDS, wanted).map((m) => ({
      ...summarize(m), body_preview: String(m.body).slice(0, 120),
    }))
  }

  /** Requests that failed or expired and have not yet produced a notice. */
  function getFailedToNotify() {
    return select(stmt.failedToNotify)
  }

  /** Mark a message as notified exactly once. Returns false if already notified. */
  function markNotified(messageId, now) {
    return stmt.notify.run(now, String(messageId)).changes > 0
  }

  /** Per-agent queue counts (for /healthz, matching the self-use broker). */
  function queueStats(agentNames) {
    const grouped = stmt.counts.all()
    const out = {}
    for (const name of agentNames ?? new Set(grouped.map((row) => row.target))) {
      out[name] = { queued: 0, leased: 0, completed: 0, failed: 0, expired: 0, oldest_queued_at: null }
    }
    for (const row of grouped) {
      const q = out[row.target]
      if (!q || q[row.status] === undefined) continue
      q[row.status] += row.n
      if (row.status === STATUS.QUEUED && (q.oldest_queued_at === null || row.oldest < q.oldest_queued_at)) {
        q.oldest_queued_at = row.oldest
      }
    }
    return out
  }

  function close() {
    if (maintenanceTimer) { clearInterval(maintenanceTimer); maintenanceTimer = null }
    if (persist) {
      // A read-heavy queue never writes, so nothing else flushes the WAL:
      // 2026-09-19 found a 136 KB database carrying a 3.5 MB uncheckpointed WAL.
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch { /* best-effort */ }
    }
    try { db.close() } catch { /* already closed */ }
  }

  // Housekeeping runs on a timer too, so a queue nobody polls still expires.
  let maintenanceTimer = null
  if (persist) {
    maintenanceTimer = setInterval(() => {
      try { cleanup(Date.now() / 1000) } catch { /* best-effort */ }
    }, MAINTENANCE_INTERVAL_MS)
    maintenanceTimer.unref()
  }

  cleanup(Date.now() / 1000)

  return {
    create, get, pull, ack, renewLease, requeue, cancel, statusFor, recentFor, queryMessages,
    getFailedToNotify, markNotified, stuckFor, queueStats, cleanup, close,
    get lastPullAt() { return Object.fromEntries(lastPullAt) },
    get counters() { return { ...counters } },
  }
}
