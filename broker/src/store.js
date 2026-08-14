/**
 * Message store: in-memory queue with optional JSONL persistence.
 *
 * Ordering: every message gets a monotonically increasing sequence number.
 * Polling is incremental via `since` (message id) -> sequence mapping.
 * TTL: unread messages older than messageTtlDays are dropped on a timer.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const TTL_SCAN_MS = 60_000

/**
 * @param {object} opts
 * @param {number} opts.ttlDays
 * @param {boolean} opts.persist
 * @param {string} opts.dataDir
 */
export function createStore(opts) {
  const messages = new Map() // seq -> envelope
  const idToSeq = new Map() // message id -> seq
  const agents = new Map() // agent name -> lastSeen epoch seconds
  let nextSeq = 1
  const persistPath = join(opts.dataDir, 'messages.jsonl')

  function load() {
    if (!opts.persist || !existsSync(persistPath)) return
    const raw = readFileSync(persistPath, 'utf8').split(/\r?\n/).filter(Boolean)
    for (const line of raw) {
      try {
        const rec = JSON.parse(line)
        messages.set(rec.seq, rec.message)
        idToSeq.set(rec.message.id, rec.seq)
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
   * `sinceId` (or all when sinceId is null/unknown).
   */
  function getSince(agent, sinceId, limit = 50) {
    const start = sinceId && idToSeq.has(sinceId) ? idToSeq.get(sinceId) + 1 : 1
    const out = []
    const seqs = [...messages.keys()].sort((a, b) => a - b)
    for (const seq of seqs) {
      if (seq < start) continue
      const msg = messages.get(seq)
      if (msg.to !== agent) continue
      out.push(msg)
      if (out.length >= limit) break
    }
    const cursor = out.length ? out[out.length - 1].id : (sinceId ?? null)
    return { messages: out, cursor }
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
  setInterval(sweepExpired, TTL_SCAN_MS).unref()

  return { add, getSince, findById, registerAgent, listPeers }
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
  const msg = {
    id: body.id ?? randomUUID(),
    from: body.from ?? from,
    to: body.to,
    ts: body.ts ?? nowIso,
    type: body.type ?? 'message',
    body: body.body ?? {},
    replyTo: body.replyTo ?? null,
    ack: Boolean(body.ack),
  }
  return msg
}
