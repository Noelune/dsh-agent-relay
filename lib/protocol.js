/**
 * v2 wire protocol primitives (byte-for-byte compatible with the self-use
 * Python `relay/protocol.py`).
 *
 * Canonical body:   JSON with sorted keys, compact separators, non-ASCII kept
 *                   raw UTF-8 (Python ensure_ascii=False).
 * Signature string: HMAC-SHA256(secret, agent\n ts\n METHOD\n path\n sha256hex(body))
 * Headers:          X-Agent-Relay-Agent / -Timestamp / -Signature
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export const PROTOCOL_VERSION = 2
export const SIGNATURE_HEADERS = {
  agent: 'x-agent-relay-agent',
  timestamp: 'x-agent-relay-timestamp',
  signature: 'x-agent-relay-signature',
}
export const MAX_CLOCK_SKEW_SECONDS = 300
export const MAX_BODY_CHARS = 48000
export const EXECUTION_MODES = ['read', 'continue', 'write']
export const DEFAULT_REQUEST_TTL_SECONDS = 3600
export const TTL_MIN_SECONDS = 60
export const TTL_MAX_SECONDS = 3600

/** Serialize a string the way Python json.dumps(ensure_ascii=False) does. */
function quoteString(str) {
  let out = '"'
  for (const ch of str) {
    const code = ch.codePointAt(0)
    if (code === 0x22) out += '\\"'
    else if (code === 0x5c) out += '\\\\'
    else if (code === 0x08) out += '\\b'
    else if (code === 0x09) out += '\\t'
    else if (code === 0x0a) out += '\\n'
    else if (code === 0x0c) out += '\\f'
    else if (code === 0x0d) out += '\\r'
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`
    else out += ch // non-ASCII preserved raw; surrogate pairs handled by for...of
  }
  return out + '"'
}

/**
 * Serialize a number the way Python json.dumps does. Note: JS cannot represent
 * `1.0` as distinct from `1` (Number.isInteger(1.0) is true), so an integral
 * float would serialize as `1` here, not Python's `1.0`. The v2 wire payloads
 * clients sign never contain floats (created_at/expires_at are broker-assigned
 * and not signed), so this is a documented non-issue; non-integral floats get
 * the Python-style `.0`/shortest-repr treatment.
 */
function quoteNumber(value) {
  if (Number.isInteger(value)) return String(value)
  if (!Number.isFinite(value)) return value === Infinity ? 'Infinity' : value === -Infinity ? '-Infinity' : 'NaN'
  const text = String(value)
  return /[.eE]/.test(text) ? text : `${text}.0`
}

/**
 * Number of Unicode code points in a string — Python's `len()` semantics.
 * JS `.length` counts UTF-16 code units, so an emoji (a surrogate pair) would
 * otherwise count as 2 and a CJK-heavy limit would diverge from the self-use
 * broker.
 */
export function codePointLength(str) {
  return Array.from(String(str ?? '')).length
}

/** Truncate a string to at most `max` code points without splitting a surrogate pair. */
export function truncateCodePoints(str, max) {
  const text = String(str ?? '')
  const chars = Array.from(text)
  return chars.length <= max ? text : chars.slice(0, max).join('')
}

/** Recursive JSON serializer: sorted keys, compact separators, raw UTF-8. */
export function stringifyCanonical(value) {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return quoteNumber(value)
  if (typeof value === 'string') return quoteString(value)
  if (Array.isArray(value)) return `[${value.map(stringifyCanonical).join(',')}]`
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${quoteString(key)}:${stringifyCanonical(value[key])}`).join(',')}}`
  }
  return 'null' // undefined / functions serialize as null, like Python cannot happen on the wire
}

/** Return the exact bytes signed over the wire (matches self-use canonical_body). */
export function canonicalBody(payload) {
  return Buffer.from(stringifyCanonical(payload), 'utf8')
}

/** Build the v2 signature (matches self-use make_signature). */
export function makeSignature(agent, secret, method, path, timestamp, body) {
  const digest = createHash('sha256').update(body).digest('hex')
  const signed = [agent, timestamp, method.toUpperCase(), path, digest].join('\n')
  return createHmac('sha256', secret).update(signed).digest('hex')
}

/** Constant-time v2 signature check (matches self-use verify_signature). */
export function verifySignature(agent, secret, method, path, timestamp, body, signature) {
  if (typeof signature !== 'string' || signature.length === 0) return false
  const expected = makeSignature(agent, secret, method, path, timestamp, body)
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** One v2 message on the wire (request or reply). Mirrors self-use RelayMessage. */
export class RelayMessage {
  constructor({
    message_id, root_id, parent_id, origin, target, kind, body, session_ref,
    created_at, expires_at, execution_mode = 'read', context = '', topic = '',
  }) {
    this.message_id = String(message_id)
    this.root_id = String(root_id)
    this.parent_id = parent_id ? String(parent_id) : null
    this.origin = String(origin)
    this.target = String(target)
    this.kind = String(kind)
    this.body = String(body)
    this.session_ref = String(session_ref || '')
    this.created_at = Number(created_at)
    this.expires_at = Number(expires_at)
    this.execution_mode = String(execution_mode || 'read').toLowerCase()
    this.context = String(context || '')
    this.topic = String(topic || '')
  }

  static fromDict(payload) {
    return new RelayMessage({
      message_id: payload.message_id,
      root_id: payload.root_id,
      parent_id: payload.parent_id || null,
      origin: payload.origin,
      target: payload.target,
      kind: payload.kind,
      body: payload.body,
      session_ref: payload.session_ref || '',
      created_at: payload.created_at,
      expires_at: payload.expires_at,
      execution_mode: payload.execution_mode || 'read',
      context: payload.context || '',
      topic: payload.topic || '',
    })
  }

  toDict() {
    const result = {
      message_id: this.message_id,
      root_id: this.root_id,
      parent_id: this.parent_id,
      origin: this.origin,
      target: this.target,
      kind: this.kind,
      body: this.body,
      session_ref: this.session_ref,
      created_at: this.created_at,
      expires_at: this.expires_at,
      execution_mode: this.execution_mode,
    }
    if (this.context) result.context = this.context
    if (this.topic) result.topic = this.topic
    return result
  }
}
