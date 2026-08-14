/**
 * HMAC-SHA256 request authentication + brute-force protection + rate limiting.
 *
 * Signature format (see docs/PROTOCOL.md §3):
 *   hex( HMAC-SHA256( secret, method + "\n" + path + "\n" + timestamp + "\n" + rawBody ) )
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

const MAX_TIMESTAMP_SKEW_SECONDS = 300

/**
 * @param {object} opts
 * @param {string} opts.secret
 * @param {number} opts.lockAfterFailures
 * @param {number} opts.lockMinutes
 * @param {number} opts.rateLimitLoopback
 * @param {number} opts.rateLimitRemote
 */
export function createAuthenticator(opts) {
  const locks = new Map() // agent -> { until, count }
  const windows = new Map() // ip -> number[] (timestamps of requests)

  function isLoopback(ip) {
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
  }

  function computeSignature(method, path, timestamp, rawBody) {
    return createHmac('sha256', opts.secret)
      .update(`${method}\n${path}\n${timestamp}\n${rawBody}`)
      .digest('hex')
  }

  function constantTimeEqual(a, b) {
    const ba = Buffer.from(String(a))
    const bb = Buffer.from(String(b))
    if (ba.length !== bb.length) return false
    return timingSafeEqual(ba, bb)
  }

  function recordFailure(agent) {
    const now = Date.now()
    const entry = locks.get(agent) ?? { until: 0, count: 0 }
    if (entry.until > now) return // already locked
    entry.count += 1
    if (entry.count >= opts.lockAfterFailures) {
      entry.until = now + opts.lockMinutes * 60_000
      entry.count = 0
    }
    locks.set(agent, entry)
  }

  function checkRateLimit(ip) {
    const now = Date.now()
    const limit = isLoopback(ip) ? opts.rateLimitLoopback : opts.rateLimitRemote
    const arr = (windows.get(ip) ?? []).filter((t) => now - t < 60_000)
    if (arr.length >= limit) {
      windows.set(ip, arr)
      return false
    }
    arr.push(now)
    windows.set(ip, arr)
    return true
  }

  /**
   * Validate a request. Returns { ok: true, agent } or { ok: false, status, code, message }.
   */
  function check(req, rawBody) {
    const ip = req.socket?.remoteAddress ?? ''
    if (!checkRateLimit(ip)) {
      return { ok: false, status: 429, code: 'rate_limited', message: 'too many requests' }
    }
    const agent = req.headers['x-relay-agent']
    const timestamp = req.headers['x-relay-timestamp']
    const signature = req.headers['x-relay-signature']
    if (!agent || !timestamp || !signature) {
      return { ok: false, status: 401, code: 'unauthenticated', message: 'missing authentication headers' }
    }
    const lock = locks.get(agent)
    if (lock && lock.until > Date.now()) {
      return { ok: false, status: 403, code: 'locked', message: 'agent temporarily locked after repeated auth failures' }
    }
    const ts = Number(timestamp)
    if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > MAX_TIMESTAMP_SKEW_SECONDS) {
      recordFailure(agent)
      return { ok: false, status: 401, code: 'unauthenticated', message: 'timestamp skew' }
    }
    const path = req.url ?? '/'
    const expected = computeSignature(req.method ?? 'GET', path, timestamp, rawBody)
    if (!constantTimeEqual(signature, expected)) {
      recordFailure(agent)
      return { ok: false, status: 401, code: 'unauthenticated', message: 'invalid signature' }
    }
    return { ok: true, agent: String(agent) }
  }

  return { check, computeSignature }
}
