/**
 * v2 message store — full lifecycle (mirrors the self-use relay/store.py).
 *
 * State machine: queued →(pull) leased →(ack completed) completed
 *                        └→(ack retry) queued (attempts+1; > max → failed)
 *                queued/leased →(expires_at reached) expired
 *                failed/expired →(admin requeue) queued
 *
 * Persistence: node:sqlite (relay_v2_messages table) when available, else
 * JSONL (relay-v2.jsonl). Both preserve the same records across restarts.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const STATUS = {
  QUEUED: 'queued',
  LEASED: 'leased',
  COMPLETED: 'completed',
  FAILED: 'failed',
  EXPIRED: 'expired',
}
const RETENTION_SECONDS = 30 * 86400

export function createV2Store({ dataDir, persist = true, leaseSeconds = 600, maxAttempts = 3 }) {
  const messages = new Map() // message_id -> record
  const byIdempotency = new Map() // origin -> Map<idempotency_key, message_id>
  const maxAttemptsValue = Math.max(1, Number(maxAttempts))
  const leaseSecondsValue = Math.max(15, Number(leaseSeconds))
  const jsonlPath = join(dataDir, 'relay-v2.jsonl')
  let db = null

  // Probe node:sqlite like the v1 store does; fall back to JSONL when absent.
  let DatabaseSync = null
  try {
    ({ DatabaseSync } = require('node:sqlite'))
  } catch {
    DatabaseSync = null
  }
  if (persist && typeof DatabaseSync === 'function') {
    try {
      mkdirSync(dataDir, { recursive: true })
      db = new DatabaseSync(join(dataDir, 'relay-v2.db'))
      db.exec(`
        PRAGMA journal_mode=WAL;
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
        CREATE INDEX IF NOT EXISTS idx_v2_ready ON relay_v2_messages(target, status, expires_at, created_at);
      `)
    } catch {
      try { db?.close() } catch {}
      db = null
    }
  }

  function idemIndex(origin) {
    let index = byIdempotency.get(origin)
    if (!index) {
      index = new Map()
      byIdempotency.set(origin, index)
    }
    return index
  }

  // -- persistence ------------------------------------------------------

  function persistAll() {
    if (!persist) return
    mkdirSync(dataDir, { recursive: true })
    if (db) {
      db.exec('BEGIN IMMEDIATE; DELETE FROM relay_v2_messages;')
      try {
        const insert = db.prepare('INSERT OR REPLACE INTO relay_v2_messages(message_id, root_id, parent_id, origin, target, kind, body, session_ref, execution_mode, context, topic, idempotency_key, status, attempts, lease_until, last_error, created_at, expires_at, completed_at, notified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        for (const m of messages.values()) {
          insert.run(
            m.message_id, m.root_id, m.parent_id, m.origin, m.target, m.kind, m.body,
            m.session_ref, m.execution_mode, m.context, m.topic, m.idempotency_key,
            m.status, m.attempts, m.lease_until, m.last_error ?? null,
            m.created_at, m.expires_at, m.completed_at ?? null, m.notified_at ?? null,
          )
        }
        db.exec('COMMIT;')
      } catch (error) {
        try { db.exec('ROLLBACK;') } catch {}
        throw error
      }
      return
    }
    const lines = [...messages.values()].map((m) => JSON.stringify({ message: m }))
    writeFileSync(jsonlPath, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8')
  }

  function appendOne(m) {
    if (!persist) return
    mkdirSync(dataDir, { recursive: true })
    if (db) {
      db.prepare('INSERT OR REPLACE INTO relay_v2_messages(message_id, root_id, parent_id, origin, target, kind, body, session_ref, execution_mode, context, topic, idempotency_key, status, attempts, lease_until, last_error, created_at, expires_at, completed_at, notified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        m.message_id, m.root_id, m.parent_id, m.origin, m.target, m.kind, m.body,
        m.session_ref, m.execution_mode, m.context, m.topic, m.idempotency_key,
        m.status, m.attempts, m.lease_until, m.last_error ?? null,
        m.created_at, m.expires_at, m.completed_at ?? null, m.notified_at ?? null,
      )
      return
    }
    appendFileSync(jsonlPath, JSON.stringify({ message: m }) + '\n', 'utf8')
  }

  function load() {
    if (!persist) return
    if (db) {
      const rows = db.prepare('SELECT message_id, root_id, parent_id, origin, target, kind, body, session_ref, execution_mode, context, topic, idempotency_key, status, attempts, lease_until, last_error, created_at, expires_at, completed_at, notified_at FROM relay_v2_messages').all()
      for (const row of rows) {
        const m = {
          message_id: row.message_id, root_id: row.root_id, parent_id: row.parent_id,
          origin: row.origin, target: row.target, kind: row.kind, body: row.body,
          session_ref: row.session_ref ?? '', execution_mode: row.execution_mode,
          context: row.context ?? '', topic: row.topic ?? '',
          idempotency_key: row.idempotency_key, status: row.status, attempts: row.attempts,
          lease_until: row.lease_until, last_error: row.last_error, created_at: row.created_at,
          expires_at: row.expires_at, completed_at: row.completed_at, notified_at: row.notified_at,
        }
        messages.set(m.message_id, m)
        idemIndex(m.origin).set(m.idempotency_key, m.message_id)
      }
      return
    }
    if (!existsSync(jsonlPath)) return
    for (const line of readFileSync(jsonlPath, 'utf8').split(/\r?\n/).filter(Boolean)) {
      try {
        const rec = JSON.parse(line)
        messages.set(rec.message.message_id, rec.message)
        if (rec.message.idempotency_key) idemIndex(rec.message.origin).set(rec.message.idempotency_key, rec.message.message_id)
      } catch { /* skip corrupt line */ }
    }
  }

  // -- lifecycle ---------------------------------------------------------

  function cleanup(now) {
    let changed = false
    for (const m of messages.values()) {
      if ((m.status === STATUS.QUEUED || m.status === STATUS.LEASED) && m.expires_at < now) {
        m.status = STATUS.EXPIRED
        m.lease_until = null
        changed = true
      } else if (m.status === STATUS.LEASED && m.lease_until != null && m.lease_until < now) {
        m.status = STATUS.QUEUED
        m.lease_until = null
        changed = true
      } else if ((m.status === STATUS.QUEUED || m.status === STATUS.LEASED) && m.attempts >= maxAttemptsValue) {
        m.status = STATUS.FAILED
        m.lease_until = null
        m.completed_at = m.completed_at ?? now
        m.last_error = m.last_error ?? 'attempts exhausted without acknowledgement'
        changed = true
      }
    }
    // Retention: drop terminal messages older than RETENTION_SECONDS.
    const cutoff = now - RETENTION_SECONDS
    let purged = false
    for (const [messageId, m] of messages) {
      if ([STATUS.COMPLETED, STATUS.EXPIRED, STATUS.FAILED].includes(m.status) && (m.completed_at ?? m.created_at) < cutoff) {
        messages.delete(messageId)
        purged = true
      }
    }
    if (changed || purged) persistAll()
  }

  function create(message, idempotencyKey) {
    const existing = idemIndex(message.origin).get(idempotencyKey)
    if (existing) return { message_id: existing, created: false }
    const record = {
      message_id: String(message.message_id),
      root_id: String(message.root_id ?? ''),
      parent_id: message.parent_id ?? null,
      origin: String(message.origin),
      target: String(message.target),
      kind: String(message.kind),
      body: String(message.body ?? ''),
      session_ref: String(message.session_ref ?? ''),
      execution_mode: String(message.execution_mode || 'read').toLowerCase(),
      context: String(message.context ?? ''),
      topic: String(message.topic ?? ''),
      idempotency_key: String(idempotencyKey),
      created_at: Number(message.created_at) || 0,
      expires_at: Number(message.expires_at) || 0,
      status: STATUS.QUEUED,
      attempts: 0,
      lease_until: null,
      last_error: null,
      completed_at: null,
      notified_at: null,
    }
    messages.set(record.message_id, record)
    idemIndex(record.origin).set(idempotencyKey, record.message_id)
    appendOne(record)
    return { message_id: record.message_id, created: true }
  }

  function get(messageId) {
    return messages.get(String(messageId)) ?? null
  }

  function pull(target, now, { limit = 8, leaseSeconds: requestedLease } = {}) {
    cleanup(now)
    const leaseUntil = now + (requestedLease ?? leaseSecondsValue)
    const out = []
    const ready = [...messages.values()]
      .filter((m) => m.target === target && m.status === STATUS.QUEUED && m.expires_at >= now && m.attempts < maxAttemptsValue)
      .sort((a, b) => a.created_at - b.created_at)
      .slice(0, limit)
    for (const m of ready) {
      m.status = STATUS.LEASED
      m.lease_until = leaseUntil
      m.attempts += 1
      out.push(m)
    }
    if (out.length) persistAll()
    return out
  }

  function ack(messageId, target, outcome, error, now) {
    const m = messages.get(String(messageId))
    if (!m || m.target !== target) {
      const err = new Error('message is not assigned to this agent')
      err.code = 'forbidden'
      throw err
    }
    if (outcome === 'completed') {
      m.status = STATUS.COMPLETED
      m.lease_until = null
      m.completed_at = now
      m.last_error = null
    } else if (outcome === 'retry') {
      if (m.attempts >= maxAttemptsValue) {
        m.status = STATUS.FAILED
        m.lease_until = null
        m.completed_at = now
        m.last_error = String(error || 'retry exhausted').slice(0, 300)
      } else {
        m.status = STATUS.QUEUED
        m.lease_until = null
        m.last_error = error ? String(error).slice(0, 300) : null
      }
    } else {
      const err = new Error('invalid acknowledgement outcome')
      err.code = 'bad_request'
      throw err
    }
    persistAll()
  }

  function requeue(messageId, now) {
    const m = messages.get(String(messageId))
    if (!m || ![STATUS.LEASED, STATUS.FAILED, STATUS.EXPIRED].includes(m.status)) return false
    m.status = STATUS.QUEUED
    m.lease_until = null
    m.attempts = 0
    m.notified_at = null
    m.last_error = m.last_error ?? 'requeued by operator'
    persistAll()
    return true
  }

  function cancel(messageId, now) {
    const m = messages.get(String(messageId))
    if (!m || ![STATUS.QUEUED, STATUS.LEASED, STATUS.FAILED, STATUS.EXPIRED].includes(m.status)) return false
    m.status = STATUS.COMPLETED
    m.lease_until = null
    m.completed_at = now
    m.last_error = m.last_error ?? 'cancelled by operator'
    persistAll()
    return true
  }

  function statusFor(agent, ids) {
    const out = []
    for (const raw of ids ?? []) {
      const m = messages.get(String(raw))
      if (!m) {
        out.push({ message_id: String(raw), status: 'not_found', attempts: 0 })
        continue
      }
      if (m.origin !== agent && m.target !== agent) {
        out.push({ message_id: String(raw), status: 'not_found', attempts: 0 })
        continue
      }
      out.push({
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
      })
    }
    return out
  }

  function recentFor(agent, now, limit = 20) {
    return [...messages.values()]
      .filter((m) => (m.origin === agent || m.target === agent) && m.created_at >= now - 7 * 86400)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, limit)
      .map(summarize)
  }

  function queryMessages(agent, filters) {
    const cutoff = filters.since ?? 0
    return [...messages.values()]
      .filter((m) => m.origin === agent || m.target === agent)
      .filter((m) => m.created_at >= cutoff)
      .filter((m) => (filters.message_id ? m.message_id === String(filters.message_id) : true))
      .filter((m) => (filters.root_id ? m.root_id === String(filters.root_id) : true))
      .filter((m) => (filters.origin ? m.origin === String(filters.origin).toLowerCase() : true))
      .filter((m) => (filters.target ? m.target === String(filters.target).toLowerCase() : true))
      .filter((m) => (filters.kind ? m.kind === String(filters.kind).toLowerCase() : true))
      .filter((m) => (filters.status ? m.status === String(filters.status).toLowerCase() : true))
      .filter((m) => (filters.topic ? m.topic.includes(String(filters.topic)) : true))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, Math.max(1, Math.min(Number(filters.limit) || 50, 100)))
      .map((m) => ({ ...summarize(m), body: m.body }))
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

  function close() {
    if (maintenanceTimer) { clearInterval(maintenanceTimer); maintenanceTimer = null }
    if (db) { try { db.close() } catch {} db = null }
  }

  // Periodic housekeeping (expiry + retention) even when nobody pulls.
  const MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000
  let maintenanceTimer = null
  if (persist) {
    maintenanceTimer = setInterval(() => { try { cleanup(Date.now() / 1000) } catch { /* best-effort */ } }, MAINTENANCE_INTERVAL_MS)
    maintenanceTimer.unref()
  }

  load()
  if (persist) cleanup(Date.now() / 1000)
  return {
    create, get, pull, ack, requeue, cancel, statusFor, recentFor, queryMessages, cleanup, close,
  }
}
