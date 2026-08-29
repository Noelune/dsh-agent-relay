/**
 * Small HTTP helpers shared by the broker routes (2026-08-29 split out of
 * server.js). No protocol policy lives here.
 */
import { randomBytes } from 'node:crypto'

export const MAX_BODY_BYTES = 1024 * 1024

/** 32-hex-char id (matches the self-use broker's uuid.uuid4().hex). */
export function cryptoRandomHex(bytes = 16) {
  return randomBytes(bytes).toString('hex')
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

export function errorBody(code, message) {
  return { error: { code, message } }
}

export function parseJson(raw) {
  try { return JSON.parse(raw) } catch { return null }
}

export function parseJsonObject(raw) {
  const parsed = parseJson(raw)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
}

export function clampLimit(value, fallback = 50) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(Math.max(1, Math.floor(n)), 200) : fallback
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    let tooLarge = false
    const chunks = []
    req.on('data', (chunk) => {
      if (tooLarge) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        tooLarge = true
        reject(Object.assign(new Error('body too large'), { code: 'bad_request' }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
