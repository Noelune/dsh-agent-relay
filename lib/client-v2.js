/**
 * RelayClientV2 — v2/v3 wire protocol client (docs/PROTOCOL-V2.md).
 *
 * Speaks both signature schemes against a bilingual broker: pass `keyId` to
 * sign with the v3 keyring scheme (X-Agent-Relay-Key-Id header), or leave it
 * empty for the v2 legacy scheme. Pull responses carry `lease_token` /
 * `lease_until`; pass the token to `ack()` for the strict single-use guard and
 * use `renewLease()` while a long-running turn is in flight.
 */
import { canonicalBody, makeSignature, SIGNATURE_HEADERS, DEFAULT_REQUEST_TTL_SECONDS, RelayMessage } from './protocol.js'

export class RelayClientV2 {
  /**
   * @param {object} opts
   * @param {string} opts.endpoint - e.g. http://127.0.0.1:19121
   * @param {string} opts.agent - this agent's name (lowercase)
   * @param {string} opts.secret - the agent's HMAC secret
   * @param {string} [opts.keyId] - key id for v3 signatures (empty = v2 scheme)
   * @param {number} [opts.timeoutMs=15000]
   */
  constructor({ endpoint, agent, secret, keyId = '', timeoutMs = 15000 }) {
    this.endpoint = String(endpoint).replace(/\/$/, '')
    this.agent = String(agent).trim().toLowerCase()
    this.secret = secret
    this.keyId = String(keyId || '').trim()
    this.timeoutMs = timeoutMs
  }

  async #request(method, path, payload) {
    const hasBody = !['GET', 'HEAD'].includes(method.toUpperCase())
    const body = canonicalBody(payload ?? {})
    // The broker only reads a request body for POST/PUT/PATCH and verifies the
    // signature against the raw bytes it received — for GET it sees an empty
    // body, so the client signs over empty bytes and sends none.
    const wireBody = hasBody ? body : Buffer.alloc(0)
    const timestamp = String(Math.floor(Date.now() / 1000))
    const headers = {
      'content-type': 'application/json',
      [SIGNATURE_HEADERS.agent]: this.agent,
      [SIGNATURE_HEADERS.timestamp]: timestamp,
      [SIGNATURE_HEADERS.signature]: makeSignature(this.agent, this.secret, method, path, timestamp, wireBody, this.keyId),
    }
    if (this.keyId) headers[SIGNATURE_HEADERS.keyId] = this.keyId
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(this.endpoint + path, {
        method,
        headers,
        body: hasBody ? wireBody : undefined,
        signal: controller.signal,
      })
      const text = await res.text()
      let data = null
      try { data = text ? JSON.parse(text) : null } catch { data = null }
      if (res.status >= 400) {
        throw new Error(String(data?.error?.message || `relay request failed (${res.status})`).slice(0, 500))
      }
      return data
    } finally {
      clearTimeout(timer)
    }
  }

  /** GET /healthz — liveness + protocol metadata + agent/queue info. */
  async health() {
    return this.#request('GET', '/healthz', {})
  }

  /** Send a request. Returns the new message_id. */
  async sendRequest({
    target, body, sessionRef, idempotencyKey, ttlSeconds = DEFAULT_REQUEST_TTL_SECONDS,
    executionMode = 'read', context, topic,
  }) {
    const payload = {
      origin: this.agent,
      target: String(target).trim().toLowerCase(),
      kind: 'request',
      body,
      session_ref: sessionRef,
      idempotency_key: idempotencyKey,
      ttl_seconds: ttlSeconds,
      execution_mode: executionMode,
    }
    if (context) payload.context = context
    if (topic) payload.topic = topic
    const data = await this.#request('POST', '/v1/messages', payload)
    return data.message_id
  }

  /** Reply to an incoming message. Returns the new reply message_id. */
  async sendReply(incoming, body, idempotencyKey) {
    const now = Date.now() / 1000
    const ttl = Math.max(60, Math.floor((Number(incoming.expires_at) || 0) - now))
    const payload = {
      origin: this.agent,
      target: incoming.origin,
      kind: 'reply',
      body,
      session_ref: incoming.session_ref,
      parent_id: incoming.message_id,
      idempotency_key: idempotencyKey,
      ttl_seconds: ttl,
    }
    const data = await this.#request('POST', '/v1/messages', payload)
    return data.message_id
  }

  /** Lease up to `limit` queued messages addressed to this agent. */
  async pull({ limit, leaseSeconds } = {}) {
    const payload = { agent: this.agent }
    if (limit !== undefined) payload.limit = limit
    if (leaseSeconds !== undefined) payload.lease_seconds = leaseSeconds
    const data = await this.#request('POST', '/v1/pull', payload)
    return (data.messages || []).map((m) => RelayMessage.fromDict(m))
  }

  /** Acknowledge a leased message: outcome 'completed' | 'retry'.
   * With a `leaseToken` (v3) the ack is guarded on the active lease. */
  async ack(messageId, outcome, error, leaseToken = '') {
    const payload = { agent: this.agent, message_id: messageId, outcome }
    if (error) payload.error = error
    if (leaseToken) payload.lease_token = leaseToken
    return this.#request('POST', '/v1/ack', payload)
  }

  /** Extend the delivery lease of a leased message (v3). Returns the new lease_until. */
  async renewLease(messageId, leaseToken, leaseSeconds) {
    const payload = { agent: this.agent, message_id: messageId, lease_token: leaseToken }
    if (leaseSeconds !== undefined) payload.lease_seconds = leaseSeconds
    const data = await this.#request('POST', '/v1/lease/renew', payload)
    return data.lease_until
  }

  /** Batch status lookup for message ids this agent is party to. */
  async status(messageIds) {
    const data = await this.#request('POST', '/v1/status', { agent: this.agent, message_ids: messageIds })
    return data.messages || []
  }

  /** Most recent messages this agent was involved in. */
  async recent(limit = 20) {
    const data = await this.#request('POST', '/v1/recent', { agent: this.agent, limit })
    return data.messages || []
  }

  /** Read-only search of this agent's messages. */
  async query(filters = {}) {
    const data = await this.#request('POST', '/v1/messages/query', { agent: this.agent, ...filters })
    return data.messages || []
  }

  /** Admin: requeue a failed/expired/leased message. */
  async requeue(messageId) {
    return this.#request('POST', '/v1/admin/requeue', { agent: this.agent, message_id: messageId })
  }

  /** Admin: cancel a non-terminal message. */
  async cancel(messageId) {
    return this.#request('POST', '/v1/admin/cancel', { agent: this.agent, message_id: messageId })
  }

  /** Admin: list stuck (non-terminal) messages targeting this agent. */
  async adminStatus(limit = 50) {
    const data = await this.#request('POST', '/v1/admin/status', { agent: this.agent, limit })
    return data.messages || []
  }
}
