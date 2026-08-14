/**
 * HMAC-SHA256 request signing — wire protocol v1.0 (§3 of docs/PROTOCOL.md).
 *
 * Signature input:  method + "\n" + path(with query) + "\n" + timestamp + "\n" + rawBody
 * Shared by the dsh plugin, the CLI client, and the test suite.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** Sign one request. @returns the hex signature. */
export function signRequest(secret, method, path, timestampSeconds, rawBody = '') {
  return createHmac('sha256', String(secret))
    .update(`${method}\n${path}\n${timestampSeconds}\n${rawBody}`)
    .digest('hex')
}

/** Build the three auth headers for one request. */
export function authHeaders(secret, agent, method, path, rawBody = '') {
  const ts = Math.floor(Date.now() / 1000)
  return {
    'x-relay-agent': agent,
    'x-relay-timestamp': String(ts),
    'x-relay-signature': signRequest(secret, method, path, ts, rawBody),
  }
}

/** Constant-time comparison of two hex strings. */
export function signaturesEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}
