/**
 * RelayClientV2 — v2/v3 wire protocol client (docs/PROTOCOL-V2.md).
 *
 * Speaks both signature schemes against a bilingual broker: pass `keyId` to
 * sign with the v3 keyring scheme (X-Agent-Relay-Key-Id header), or leave it
 * empty for the v2 legacy scheme. Pull responses carry `lease_token` /
 * `lease_until`; pass the token to `ack()` for the strict single-use guard and
 * use `renewLease()` while a long-running turn is in flight.
 */
import { randomUUID } from 'node:crypto'
import {
  canonicalBody, makeSignature, SIGNATURE_HEADERS,
  DEFAULT_REQUEST_TTL_SECONDS, MAX_WAIT_SECONDS, RelayMessage,
} from './protocol.js'

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

  async #request(method, path, payload, { timeoutMs } = {}) {
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
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs)
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

  /**
   * Send a request and return the broker's full answer, including presence:
   * `target_online` tells the caller right now whether anybody is listening,
   * instead of an hour later when the message silently expired.
   */
  async sendRequestDetailed({
    target, body, sessionRef, idempotencyKey, ttlSeconds = DEFAULT_REQUEST_TTL_SECONDS,
    executionMode = 'read', context, topic, rootId,
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
    // A caller that intends to wait for the answer supplies its own root id so
    // the reply can be claimed by conversation instead of by inbox scan.
    if (rootId) payload.root_id = String(rootId)
    if (context) payload.context = context
    if (topic) payload.topic = topic
    return this.#request('POST', '/v1/messages', payload)
  }

  /** Send a request. Returns the new message_id. */
  async sendRequest(args) {
    const data = await this.sendRequestDetailed(args)
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

  /**
   * Answer a message by id alone, for callers (CLI, MCP tool) that hold just the
   * id they pulled rather than the full envelope. One `status` lookup resolves
   * who asked, then this defers to `sendReply` so the wire payload — and the
   * broker's reply authority check against the parent's (target, origin) — is
   * shaped in exactly one place.
   */
  async replyTo(parentId, body, idempotencyKey = `${this.agent}:reply:${parentId}`) {
    const [parent] = await this.status([parentId])
    if (!parent || parent.status === 'not_found') {
      const err = new Error(`no such message (or you are not a party to it): ${parentId}`)
      err.code = 'no_such_message'
      throw err
    }
    if (parent.kind !== 'request') {
      const err = new Error(`message ${parentId} is a ${parent.kind}, not a request to answer`)
      err.code = 'bad_request'
      throw err
    }
    return this.sendReply(
      { message_id: parent.message_id, origin: parent.origin, target: parent.target, expires_at: parent.expires_at },
      body,
      idempotencyKey,
    )
  }

  /**
   * Lease queued messages addressed to this agent.
   *
   * `waitSeconds` turns the claim into a long-poll: the broker holds the
   * request until something arrives instead of the client asking every couple of
   * seconds. `matchRootId` restricts the claim to one conversation so a caller
   * can wait for a specific answer without stealing the rest of its inbox.
   */
  async pull({ limit, leaseSeconds, waitSeconds = 0, matchRootId } = {}) {
    const payload = { agent: this.agent }
    if (limit !== undefined) payload.limit = limit
    if (leaseSeconds !== undefined) payload.lease_seconds = leaseSeconds
    if (matchRootId) payload.match_root_id = String(matchRootId)
    if (waitSeconds > 0) payload.wait_seconds = Math.min(Math.floor(waitSeconds), MAX_WAIT_SECONDS)
    // The held request outlives the default 15 s socket timeout on purpose.
    const timeoutMs = waitSeconds > 0 ? waitSeconds * 1000 + 10_000 : undefined
    const data = await this.#request('POST', '/v1/pull', payload, { timeoutMs })
    return (data.messages || []).map((m) => RelayMessage.fromDict(m))
  }

  /**
   * Synchronous handoff: send a request and block until the peer answers (or the
   * deadline passes). This is the primitive that makes delegation feel like a
   * function call rather than a mailbox — it needs the broker's wake-up push, so
   * it stays cheap: one held connection, no polling loop.
   *
   * @returns {Promise<{ok: boolean, message_id: string, root_id: string,
   *   target_online: boolean, reply?: string, reason?: string, waited_seconds: number}>}
   */
  async ask({ target, body, context, sessionRef = '', idempotencyKey, timeoutSeconds = 240, executionMode = 'read', waitOffline = false }) {
    const rootId = randomUUID().replace(/-/g, '')
    const started = Date.now() / 1000
    const sent = await this.sendRequestDetailed({
      target, body, sessionRef: sessionRef || this.agent,
      idempotencyKey: idempotencyKey || `ask:${rootId}`,
      executionMode, context, rootId,
    })
    const result = {
      message_id: sent.message_id,
      root_id: sent.root_id ?? rootId,
      target_online: sent.target_online !== false,
      will_wake: sent.will_wake === true,
    }
    // Nobody is listening *and* nobody can be woken: don't burn the deadline.
    // The request is retained for days regardless, so the caller gets an honest
    // answer now. When the broker did start the recipient (`will_wake`), waiting
    // is worthwhile — that is the cold-start handoff. `waitOffline` forces it.
    if (!result.target_online && !result.will_wake && !waitOffline) {
      return {
        ok: false,
        ...result,
        reason: 'peer_offline',
        waited_seconds: 0,
        hint: sent.hint ?? `请求已留存，等 ${target} 上线后会自动投递`,
      }
    }
    const deadline = started + Math.max(1, timeoutSeconds)
    for (;;) {
      const remaining = deadline - Date.now() / 1000
      if (remaining <= 0) {
        return {
          ok: false,
          ...result,
          reason: sent.target_online === false
            ? 'peer_offline'
            : 'timeout',
          waited_seconds: Math.round(Date.now() / 1000 - started),
          hint: sent.hint ?? '请求已留存，稍后可用 relay_inbox 或 agent_relay_status 取回结果',
        }
      }
      const held = Math.min(remaining, MAX_WAIT_SECONDS)
      const messages = await this.pull({
        limit: 4, waitSeconds: held, matchRootId: result.root_id, leaseSeconds: 300,
      })
      const answer = messages.find((m) => m.kind === 'reply') ?? messages[0]
      if (answer) {
        await this.ack(answer.message_id, 'completed', undefined, answer.lease_token).catch(() => {})
        return {
          ok: true,
          ...result,
          reply: answer.body,
          reply_message_id: answer.message_id,
          waited_seconds: Math.round(Date.now() / 1000 - started),
        }
      }
    }
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
