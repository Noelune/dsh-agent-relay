/**
 * Message store: in-memory queue with optional JSONL persistence.
 *
 * v1.1 adds a lease-based delivery state machine on top of the v1.0 queue:
 *   queued -> leased -> done
 *            |          |
 *            +- retry -> queued (attempts+1; > maxAttempts -> failed)
 *   leased with an expired lease -> queued (re-delivered)
 *
 * Ordering: every message gets a monotonically increasing sequence number.
 * Polling is incremental via `since` (message id) -> sequence mapping.
 * TTL: messages older than messageTtlDays are dropped on a timer.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const TTL_SCAN_MS = 60_000

const STATUS = {
  QUEUED: 'queued',
  LEASED: 'leased',
  DONE: 'done',
  FAILED: 'failed',
}

/**
 * @param {object} opts
 * @param {number} opts.ttlDays
 * @param {boolean} opts.persist
 * @param {string} opts.dataDir
 * @param {number} [opts.maxAttempts=3]
 */
export function createStore(opts) {
  const messages = new Map() // seq -> envelope
  const idToSeq = new Map() // message id -> seq
  const agents = new Map() // agent name -> lastSeen epoch seconds
  const maxAttempts = opts.maxAttempts ?? 3
  let nextSeq = 1
  const persistPath = join(opts.dataDir, 'messages.jsonl')

  function load() {
    if (!opts.persist || !existsSync(persistPath)) return
    const raw = readFileSync(persistPath, 'utf8').split(/\r?\n/).filter(Boolean)
    for (const line of raw) {
      try {
        const rec = JSON.parse(line)
        // Old v1.0 lines lack the v1.1 fields — normalize on load.
        const msg = { status: STATUS.QUEUED, attempts: 0, leaseUntil: null, kind: 'message', rootId: null, parentId: null, ...rec.message }
        messages.set(rec.seq, msg)
        idToSeq.set(msg.id, rec.seq)
        if (rec.seq >= nextSeq) nextSeq = rec.seq + 1
      } catch {
        // skip a corrupt line; keep the rest
      }
    }
  }

  function persistAll() {
    if (!opts.persist) return
    mkdirSync(opts.dataDir, { recursive: true })
    const lines = [...messages.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([seq, message]) => JSON.stringify({ seq, message }))
    writeFileSync(persistPath, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8')
  }

  function appendOne(seq, message) {
    if (!opts.persist) return
    mkdirSync(opts.dataDir, { recursive: true })
    appendFileSync(persistPath, JSON.stringify({ seq, message }) + '\n', 'utf8')
  }

  function sweepExpired() {
    const cutoff = Date.now() - opts.ttlDays * 86_400_000
    let changed = false
    for (const [seq, msg] of messages) {
      if (new Date(msg.ts).getTime() < cutoff) {
        messages.delete(seq)
        idToSeq.delete(msg.id)
        changed = true
      }
    }
    if (changed) persistAll()
  }

  /** Re-queue leased messages whose lease expired (reliable delivery). */
  function leaseSweep() {
    const now = Date.now()
    let changed = false
    for (const [seq, msg] of messages) {
      if (msg.status === STATUS.LEASED && msg.leaseUntil != null && msg.leaseUntil < now) {
        msg.status = STATUS.QUEUED
        msg.leaseUntil = null
        changed = true
      }
    }
    if (changed) persistAll()
  }

  /**
   * Add a message. Returns { added: true } or { added: false, duplicate: true }.
   */
  function add(msg) {
    if (idToSeq.has(msg.id)) return { added: false, duplicate: true }
    const seq = nextSeq++
    messages.set(seq, msg)
    idToSeq.set(msg.id, seq)
    appendOne(seq, msg)
    return { added: true }
  }

  /**
   * Poll: messages addressed to `agent` with seq strictly after the seq of
   * `sinceId` (or all when sinceId is null/unknown). Only `queued` messages are
   * returned, so leased/done ones are never double-delivered.
   */
  function getSince(agent, sinceId, limit = 50) {
    const start = sinceId && idToSeq.has(sinceId) ? idToSeq.get(sinceId) + 1 : 1
    const out = []
    const seqs = [...messages.keys()].sort((a, b) => a - b)
    for (const seq of seqs) {
      if (seq < start) continue
      const msg = messages.get(seq)
      if (msg.to !== agent || msg.status !== STATUS.QUEUED) continue
      out.push(msg)
      if (out.length >= limit) break
    }
    const cursor = out.length ? out[out.length - 1].id : (sinceId ?? null)
    return { messages: out, cursor }
  }

  /**
   * Lease-based pull (v1.1): mark up to `limit` queued messages addressed to
   * `agent` as leased and return them. Lease expiry re-queues via leaseSweep.
   */
  function pull(agent, limit = 50, leaseSeconds = 600) {
    const out = []
    const seqs = [...messages.keys()].sort((a, b) => a - b)
    const leaseUntil = Date.now() + leaseSeconds * 1000
    for (const seq of seqs) {
      const msg = messages.get(seq)
      if (msg.to !== agent || msg.status !== STATUS.QUEUED) continue
      msg.status = STATUS.LEASED
      msg.leaseUntil = leaseUntil
      out.push(msg)
      if (out.length >= limit) break
    }
    if (out.length) persistAll()
    return out
  }

  /**
   * Acknowledge a leased message. Returns { ok, status, attempts }.
   * outcome 'completed' -> done; 'retry' -> queued (attempts+1, over max -> failed).
   */
  function ack(messageId, outcome, error) {
    const seq = idToSeq.get(messageId)
    const msg = seq === undefined ? null : messages.get(seq)
    if (!msg) return { ok: false, code: 'no_such_message' }
    if (outcome === 'completed') {
      msg.status = STATUS.DONE
      msg.leaseUntil = null
      msg.error = error ?? null
      persistAll()
      return { ok: true, status: msg.status, attempts: msg.attempts }
    }
    if (outcome === 'retry') {
      msg.attempts += 1
      if (msg.attempts > maxAttempts) {
        msg.status = STATUS.FAILED
        msg.leaseUntil = null
      } else {
        msg.status = STATUS.QUEUED
        msg.leaseUntil = null
      }
      msg.error = error ?? null
      persistAll()
      return { ok: true, status: msg.status, attempts: msg.attempts }
    }
    return { ok: false, code: 'bad_request' }
  }

  /** Batch status lookup (v1.1). */
  function getStatus(ids) {
    const out = []
    for (const id of ids ?? []) {
      const seq = idToSeq.get(id)
      if (seq === undefined) {
        out.push({ id, status: 'not_found', attempts: 0 })
        continue
      }
      const msg = messages.get(seq)
      out.push({ id, status: msg.status, attempts: msg.attempts, ts: msg.ts, from: msg.from, to: msg.to, kind: msg.kind ?? 'message' })
    }
    return out
  }

  /** Most recent messages addressed to `agent` (read-only, any status). */
  function getRecent(agent, limit = 50) {
    const out = []
    const seqs = [...messages.keys()].sort((a, b) => b - a) // newest first
    for (const seq of seqs) {
      const msg = messages.get(seq)
      if (msg.to !== agent) continue
      out.push(msg)
      if (out.length >= limit) break
    }
    return out
  }

  /** Read-only filtered search (v1.1). */
  function query(filters) {
    const { agent, limit = 50, kind, status, from, to } = filters ?? {}
    const out = []
    const seqs = [...messages.keys()].sort((a, b) => b - a)
    for (const seq of seqs) {
      const msg = messages.get(seq)
      if (agent && msg.to !== agent) continue
      if (kind && msg.kind !== kind) continue
      if (status && msg.status !== status) continue
      if (from && msg.from !== from) continue
      if (to && msg.to !== to) continue
      out.push(msg)
      if (out.length >= limit) break
    }
    return out
  }

  function findById(id) {
    const seq = idToSeq.get(id)
    return seq === undefined ? null : messages.get(seq)
  }

  function registerAgent(agent, nowEpoch) {
    agents.set(agent, nowEpoch)
  }

  function listPeers(nowEpoch, ttlSeconds = 90) {
    const out = []
    for (const [name, lastSeen] of agents) {
      out.push({ agent: name, online: nowEpoch - lastSeen < ttlSeconds, lastSeen })
    }
    return out.sort((a, b) => a.agent.localeCompare(b.agent))
  }

  load()
  if (opts.persist) sweepExpired()
  setInterval(() => { leaseSweep(); sweepExpired() }, TTL_SCAN_MS).unref()

  return { add, getSince, findById, registerAgent, listPeers, pull, ack, getStatus, getRecent, query, leaseSweep }
}

/** Build a well-formed envelope from a shorthand or full body. */
export function normalizeEnvelope(body, from, nowIso) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const err = new Error('body must be a JSON object')
    err.code = 'bad_request'
    throw err
  }
  if (body.id !== undefined && typeof body.id !== 'string') {
    const err = new Error('id must be a string')
    err.code = 'bad_request'
    throw err
  }
  if (typeof body.to !== 'string' || !body.to) {
    const err = new Error('to is required')
    err.code = 'bad_request'
    throw err
  }
  if (body.type !== undefined && body.type !== 'message' && body.type !== 'ack') {
    const err = new Error('type must be "message" or "ack"')
    err.code = 'bad_request'
    throw err
  }
  const kind = body.kind ?? 'message'
  if (!['message', 'request', 'reply'].includes(kind)) {
    const err = new Error('kind must be "message", "request" or "reply"')
    err.code = 'bad_request'
    throw err
  }
  return {
    id: body.id ?? randomUUID(),
    from: body.from ?? from,
    to: body.to,
    ts: body.ts ?? nowIso,
    type: body.type ?? 'message',
    body: body.body ?? {},
    replyTo: body.replyTo ?? null,
    ack: Boolean(body.ack),
    kind,
    rootId: body.rootId ?? null,
    parentId: body.parentId ?? null,
    status: STATUS.QUEUED,
    attempts: 0,
    leaseUntil: null,
  }
}
