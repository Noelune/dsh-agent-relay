/**
 * RelayClient — wire protocol v1.0 client (shared by the dsh plugin host half).
 *
 * Loopback-first, HMAC-authenticated, with retry/backoff per PROTOCOL §5.
 * Message content is never logged.
 */
import { randomUUID } from 'node:crypto'
import { authHeaders } from './sign.js'

const PROTOCOL_VERSION = '1.0'
const RETRY_DELAYS_MS = [2000, 4000, 8000]

export class RelayError extends Error {
  constructor(status, code, message) {
    super(`relay ${code} (${status}): ${message}`)
    this.status = status
    this.code = code
  }
}

export class RelayClient {
  /**
   * @param {object} opts
   * @param {string} opts.brokerUrl - e.g. http://127.0.0.1:19121
   * @param {string} opts.agent - this agent's name
   * @param {string} opts.secret - shared HMAC secret
   * @param {number} [opts.timeoutMs=10000]
   */
  constructor({ brokerUrl, agent, secret, timeoutMs = 10000 }) {
    this.brokerUrl = String(brokerUrl).replace(/\/$/, '')
    this.agent = agent
    this.secret = secret
    this.timeoutMs = timeoutMs
    this.since = null // poll cursor
  }

  async #request(method, path, body, { retries = 0 } = {}) {
    const rawBody = body === undefined ? '' : JSON.stringify(body)
    const headers = {
      'content-type': 'application/json',
      ...authHeaders(this.secret, this.agent, method, path, rawBody),
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(this.brokerUrl + path, {
        method,
        headers,
        body: rawBody === '' ? undefined : rawBody,
        signal: controller.signal,
      })
      const text = await res.text()
      let parsed = null
      try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
      if (res.status >= 200 && res.status < 300) return parsed
      const code = parsed?.error?.code ?? 'unknown'
      const message = parsed?.error?.message ?? text.slice(0, 200)
      if ((res.status >= 500 || res.status === 408 || res.status === 429) && retries < RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[retries]))
        return this.#request(method, path, body, { retries: retries + 1 })
      }
      if (code === 'duplicate' || res.status === 409) return { accepted: true, id: body?.id, duplicate: true }
      throw new RelayError(res.status, code, message)
    } finally {
      clearTimeout(timer)
    }
  }

  /** Version negotiation (PROTOCOL §4). Throws on incompatible broker. */
  async handshake() {
    const info = await this.#request('GET', '/', undefined, { retries: 1 })
    if (!info || info.protocol !== PROTOCOL_VERSION) {
      throw new Error(`broker protocol mismatch: expected ${PROTOCOL_VERSION}, got ${info?.protocol ?? 'unknown'} — upgrade the broker or this adapter`)
    }
    return info
  }

  /** Register / heartbeat (PROTOCOL §4). */
  async register() {
    return this.#request('POST', '/register', { agent: this.agent })
  }

  /**
   * Send a message. Retries with 2/4/8s backoff, keeps the id stable.
   * @returns {Promise<{accepted: boolean, id: string, duplicate?: boolean}>}
   */
  async send({ to, body, type = 'message', replyTo = null, ack = false, id = randomUUID() }) {
    const payload = { id, to, body, type, replyTo, ack }
    return this.#request('POST', '/messages', payload)
  }

  /**
   * Poll the inbox (incremental, PROTOCOL §4).
   * @param {number} [limit=50]
   * @returns {Promise<{messages: object[], cursor: string|null}>}
   */
  async recv(limit = 50) {
    const path = `/messages?since=${this.since ?? ''}&limit=${limit}`
    const result = await this.#request('GET', path)
    if (Array.isArray(result?.messages) && result.messages.length) {
      this.since = result.cursor ?? this.since
    }
    return result
  }

  /** List registered agents with online status. */
  async peers() {
    const result = await this.#request('GET', '/peers')
    return result?.peers ?? []
  }

  /** Send an ack receipt for a message id (PROTOCOL §4). */
  async ack(id, status = 'ok', error) {
    const body = { status, ...(error ? { error } : {}) }
    return this.#request('POST', `/messages/${id}/ack`, body)
  }
}
