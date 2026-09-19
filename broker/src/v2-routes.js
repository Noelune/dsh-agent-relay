/**
 * v2/v3 wire-protocol routes (docs/PROTOCOL-V2.md) — messages, pull, ack,
 * lease renew, status, recent, query and the admin helpers.
 *
 * Every handler responds; the caller only needs to know whether the request
 * was claimed. 2026-08-29 split out of server.js.
 */
import {
  PROTOCOL_VERSION as V2_VERSION,
  MAX_BODY_CHARS as V2_MAX_BODY,
  EXECUTION_MODES as V2_MODES,
  TTL_MIN_SECONDS as V2_TTL_MIN,
  TTL_MAX_SECONDS as V2_TTL_MAX,
  DEFAULT_REQUEST_TTL_SECONDS as V2_TTL_DEFAULT,
  PRESENCE_STALE_SECONDS,
  MAX_WAIT_SECONDS,
  RelayMessage,
  codePointLength,
  truncateCodePoints,
} from './protocol.js'
import { sendJson, errorBody, parseJsonObject, cryptoRandomHex } from './http-utils.js'
import { v2CanSend, v2PublicMessage } from './v2-auth.js'

/**
 * @param {object} deps
 * @param {(agent: string) => void} [deps.wakeAgent] - hand a waiting long-poll
 *   puller its freshly created message (see broker/src/server.js).
 * @param {(agent: string, opts: object) => Promise<object[]>} [deps.waitFor] -
 *   hold a pull request until a message arrives or `waitSeconds` elapses.
 */
export async function handleV2Routes({ config, storeV2, agent, req, res, path, rawBody, notifyFailedSenders, wakeAgent, waitFor }) {
  if (req.method === 'POST' && path === '/v1/messages') {
    const parsed = parseJsonObject(rawBody)
    if (!parsed) {
      sendJson(res, 400, errorBody('bad_request', 'body must be a JSON object'))
      return
    }
    const origin = String(parsed.origin || '').trim().toLowerCase()
    const target = String(parsed.target || '').trim().toLowerCase()
    const kind = String(parsed.kind || '').trim().toLowerCase()
    const body = String(parsed.body || '').trim()
    const sessionRef = truncateCodePoints(parsed.session_ref, 300)
    const idempotencyKey = String(parsed.idempotency_key || '').trim().slice(0, 120)
    const parentId = parsed.parent_id ? String(parsed.parent_id).trim() : null
    const executionMode = String(parsed.execution_mode || 'read').trim().toLowerCase()
    let allowSharedWrite = false
    if (parsed.allow_shared_write !== undefined) {
      if (typeof parsed.allow_shared_write !== 'boolean') {
        sendJson(res, 400, errorBody('bad_request', 'allow_shared_write must be a boolean'))
        return
      }
      allowSharedWrite = parsed.allow_shared_write
    }
    if (origin !== agent) {
      sendJson(res, 403, errorBody('forbidden', 'origin does not match authenticated agent'))
      return
    }
    if (kind !== 'request' && kind !== 'reply') {
      sendJson(res, 400, errorBody('bad_request', 'invalid message kind'))
      return
    }
    if (!body || codePointLength(body) > V2_MAX_BODY || !idempotencyKey) {
      sendJson(res, 400, errorBody('bad_request', 'message body or idempotency key is invalid'))
      return
    }
    const now = Date.now() / 1000
    const requestedTtl = Math.floor(Number(parsed.ttl_seconds) || V2_TTL_DEFAULT)
    const ttl = Math.max(V2_TTL_MIN, Math.min(requestedTtl, V2_TTL_MAX))
    const topic = truncateCodePoints(parsed.topic, 200)
    let rootId = parsed.root_id ? String(parsed.root_id) : null
    let sessionRefFinal = sessionRef
    let executionModeFinal = executionMode
    let topicFinal = topic
    if (kind === 'request') {
      if (!V2_MODES.includes(executionMode)) {
        sendJson(res, 400, errorBody('bad_request', 'execution_mode must be read, continue, or write'))
        return
      }
      if (!v2CanSend(config, origin, target, executionMode)) {
        sendJson(res, 403, errorBody('forbidden', `target is not allowed for ${executionMode} mode`))
        return
      }
      rootId = rootId ?? cryptoRandomHex()
    } else {
      if (!parentId) {
        sendJson(res, 400, errorBody('bad_request', 'reply requires parent_id'))
        return
      }
      const parent = storeV2.get(parentId)
      if (!parent) {
        sendJson(res, 404, errorBody('no_such_message', 'parent relay message was not found'))
        return
      }
      if (parent.target !== origin || parent.origin !== target) {
        sendJson(res, 403, errorBody('forbidden', 'reply is not authorized for this message'))
        return
      }
      rootId = parent.root_id
      sessionRefFinal = parent.session_ref
      executionModeFinal = parent.execution_mode
      topicFinal = parent.topic
      allowSharedWrite = false // replies never carry write privileges
    }
    const message = new RelayMessage({
      message_id: cryptoRandomHex(),
      root_id: rootId,
      parent_id: parentId,
      origin,
      target,
      kind,
      body,
      session_ref: sessionRefFinal,
      created_at: now,
      expires_at: now + ttl,
      execution_mode: executionModeFinal,
      context: truncateCodePoints(parsed.context, V2_MAX_BODY),
      topic: topicFinal,
      allow_shared_write: kind === 'request' ? allowSharedWrite : false,
    })
    const { message_id, created } = storeV2.create(message, idempotencyKey)
    const willWake = created && typeof wakeAgent === 'function'
      ? wakeAgent(target, { messageId: message_id, rootId: message.root_id }) === true
      : false
    // Presence is reported on every accepted send so the caller learns *now*
    // that nobody is listening, instead of discovering it an hour later after
    // the message silently expired. The 2026-09-19 audit showed 4 of 6 circle
    // members had never pulled since the broker restart, so this is the normal
    // case, not the error case. Deliberately additive: the send still succeeds
    // (the message is durably queued) and `message_id` / `created` are unchanged.
    const lastSeenAt = storeV2.lastPullAt?.[target] ?? null
    const targetOnline = lastSeenAt != null && now - lastSeenAt <= PRESENCE_STALE_SECONDS
    sendJson(res, 200, {
      message_id,
      created,
      root_id: message.root_id,
      protocol_version: V2_VERSION,
      target_online: targetOnline,
      last_seen_at: lastSeenAt,
      // `will_wake` tells the caller the broker has just started the recipient,
      // so waiting for an answer is worthwhile even though it is not polling.
      will_wake: willWake,
      ...(targetOnline || !created ? {} : {
        hint: willWake
          ? `目标 ${target} 未在线，已按需唤醒其工作进程，回答会自动送达`
          : `目标 ${target} 自 ${lastSeenAt ? new Date(lastSeenAt * 1000).toISOString() : '未连接过'} 未取件，消息已留存 ${Math.round(ttl / 3600)} 小时等待投递；无人处理时发起方会收到未送达通知`,
      }),
    })
    return
  }

  if (req.method === 'POST' && path === '/v1/pull') {
    const parsed = parseJsonObject(rawBody)
    if (!parsed) {
      sendJson(res, 400, errorBody('bad_request', 'body must be a JSON object'))
      return
    }
    if (parsed.agent !== undefined && String(parsed.agent).trim().toLowerCase() !== agent) {
      sendJson(res, 403, errorBody('forbidden', 'agent does not match authenticated identity'))
      return
    }
    let limit = 8
    if (parsed.limit !== undefined) {
      const rawLimit = Number(parsed.limit)
      if (!Number.isFinite(rawLimit)) {
        sendJson(res, 400, errorBody('bad_request', 'limit must be an integer'))
        return
      }
      limit = Math.max(1, Math.min(Math.floor(rawLimit), 8))
    }
    let leaseSeconds
    if (parsed.lease_seconds !== undefined) {
      const raw = Number(parsed.lease_seconds)
      if (!Number.isFinite(raw)) {
        sendJson(res, 400, errorBody('bad_request', 'lease_seconds must be an integer'))
        return
      }
      leaseSeconds = Math.max(15, Math.min(Math.floor(raw), 3600))
    }
    // Optional long-poll: hold the request until a message lands or `wait_seconds`
    // elapses, so delivery latency stops being tied to the client's poll period.
    let waitSeconds = 0
    if (parsed.wait_seconds !== undefined) {
      const raw = Number(parsed.wait_seconds)
      if (!Number.isFinite(raw) || raw < 0) {
        sendJson(res, 400, errorBody('bad_request', 'wait_seconds must be a non-negative number'))
        return
      }
      waitSeconds = Math.min(raw, MAX_WAIT_SECONDS)
    }
    // Optional targeted claim: only messages belonging to one conversation.
    const matchRootId = truncateCodePoints(parsed.match_root_id, 64).trim()
    const claim = { limit, leaseSeconds, matchRootId }
    notifyFailedSenders() // surface expired/failed requests to their senders
    let messages = storeV2.pull(agent, Date.now() / 1000, claim)
    if (!messages.length && waitSeconds > 0 && typeof waitFor === 'function') {
      messages = await waitFor(agent, { ...claim, waitSeconds, res })
    }
    if (res.writableEnded || res.destroyed) return
    sendJson(res, 200, { messages: messages.map(v2PublicMessage) })
    return
  }

  if (req.method === 'POST' && path === '/v1/ack') {
    const parsed = parseJsonObject(rawBody)
    if (!parsed) {
      sendJson(res, 400, errorBody('bad_request', 'body must be a JSON object'))
      return
    }
    if (parsed.agent !== undefined && String(parsed.agent).trim().toLowerCase() !== agent) {
      sendJson(res, 403, errorBody('forbidden', 'agent does not match authenticated identity'))
      return
    }
    const messageId = String(parsed.message_id || '').trim()
    const outcome = String(parsed.outcome || '').trim().toLowerCase()
    const error = String(parsed.error || '').slice(0, 300)
    const leaseToken = String(parsed.lease_token || '').trim()
    if (!messageId) {
      sendJson(res, 400, errorBody('bad_request', 'message_id is required'))
      return
    }
    try {
      storeV2.ack(messageId, agent, outcome, error, Date.now() / 1000, leaseToken)
    } catch (err) {
      const status = err.code === 'forbidden' ? 403 : err.code === 'lease_mismatch' ? 409 : 400
      sendJson(res, status, errorBody(err.code ?? 'bad_request', err.message))
      return
    }
    if (outcome === 'retry') notifyFailedSenders() // a retry may have just exhausted the attempts
    sendJson(res, 200, { ok: true })
    return
  }

  if (req.method === 'POST' && path === '/v1/lease/renew') {
    const parsed = parseJsonObject(rawBody)
    if (!parsed) {
      sendJson(res, 400, errorBody('bad_request', 'body must be a JSON object'))
      return
    }
    if (parsed.agent !== undefined && String(parsed.agent).trim().toLowerCase() !== agent) {
      sendJson(res, 403, errorBody('forbidden', 'agent does not match authenticated identity'))
      return
    }
    const messageId = String(parsed.message_id || '').trim()
    const leaseToken = String(parsed.lease_token || '').trim()
    if (!messageId || !leaseToken) {
      sendJson(res, 400, errorBody('bad_request', 'message_id and lease_token are required'))
      return
    }
    try {
      const leaseUntil = storeV2.renewLease(messageId, agent, leaseToken, Date.now() / 1000, parsed.lease_seconds)
      sendJson(res, 200, { ok: true, lease_until: leaseUntil })
    } catch (err) {
      sendJson(res, err.code === 'lease_mismatch' ? 409 : 400, errorBody(err.code ?? 'bad_request', err.message))
    }
    return
  }

  if (req.method === 'POST' && path === '/v1/status') {
    const parsed = parseJsonObject(rawBody)
    if (!parsed || !Array.isArray(parsed.message_ids)) {
      sendJson(res, 400, errorBody('bad_request', 'message_ids array is required'))
      return
    }
    if (parsed.agent !== undefined && String(parsed.agent).trim().toLowerCase() !== agent) {
      sendJson(res, 403, errorBody('forbidden', 'agent does not match authenticated identity'))
      return
    }
    const ids = parsed.message_ids.map(String).filter(Boolean).slice(0, 100)
    sendJson(res, 200, { messages: storeV2.statusFor(agent, ids) })
    return
  }

  if (req.method === 'POST' && path === '/v1/recent') {
    const parsed = parseJsonObject(rawBody)
    if (!parsed) {
      sendJson(res, 400, errorBody('bad_request', 'body must be a JSON object'))
      return
    }
    if (parsed.agent !== undefined && String(parsed.agent).trim().toLowerCase() !== agent) {
      sendJson(res, 403, errorBody('forbidden', 'agent does not match authenticated identity'))
      return
    }
    const limit = Number.isFinite(Number(parsed.limit)) ? Math.max(1, Math.min(Math.floor(Number(parsed.limit)) || 20, 50)) : 20
    sendJson(res, 200, { messages: storeV2.recentFor(agent, Date.now() / 1000, limit) })
    return
  }

  if (req.method === 'POST' && path === '/v1/messages/query') {
    const parsed = parseJsonObject(rawBody)
    if (!parsed) {
      sendJson(res, 400, errorBody('bad_request', 'body must be a JSON object'))
      return
    }
    if (parsed.agent !== undefined && String(parsed.agent).trim().toLowerCase() !== agent) {
      sendJson(res, 403, errorBody('forbidden', 'agent does not match authenticated identity'))
      return
    }
    let since
    if (parsed.since !== undefined) {
      since = Number(parsed.since)
      if (!Number.isFinite(since)) {
        sendJson(res, 400, errorBody('bad_request', 'since must be a number'))
        return
      }
    }
    const messages = storeV2.queryMessages(agent, {
      limit: parsed.limit,
      message_id: parsed.message_id,
      root_id: parsed.root_id,
      origin: parsed.origin,
      target: parsed.target,
      kind: parsed.kind,
      status: parsed.status,
      topic: parsed.topic,
      since,
    })
    sendJson(res, 200, { agent, messages })
    return
  }

  if (req.method === 'POST' && path === '/v1/admin/status') {
    const parsed = parseJsonObject(rawBody)
    if (!parsed) {
      sendJson(res, 400, errorBody('bad_request', 'body must be a JSON object'))
      return
    }
    if (parsed.agent !== undefined && String(parsed.agent).trim().toLowerCase() !== agent) {
      sendJson(res, 403, errorBody('forbidden', 'agent does not match authenticated identity'))
      return
    }
    const limit = Number.isFinite(Number(parsed.limit)) ? Math.max(1, Math.min(Math.floor(Number(parsed.limit)), 100)) : 50
    const messages = storeV2.stuckFor(agent, Date.now() / 1000, limit)
    sendJson(res, 200, { agent, messages })
    return
  }

  // Admin helpers mirror the self-use broker's authorization: operators
  // listed in `security.admin_agents` may act on anything, everyone else
  // only on their own side of an unfinished request.
  if (req.method === 'POST' && path === '/v1/admin/requeue') {
    const parsed = parseJsonObject(rawBody)
    const messageId = String(parsed?.message_id || '').trim()
    if (!messageId) {
      sendJson(res, 400, errorBody('bad_request', 'message_id is required'))
      return
    }
    const existing = storeV2.get(messageId)
    if (!existing) {
      sendJson(res, 404, errorBody('no_such_message', 'message was not found'))
      return
    }
    const isAdmin = config.adminAgents?.has(agent) === true
    if (!isAdmin && (existing.target !== agent || existing.kind !== 'request' || existing.status === 'completed')) {
      sendJson(res, 403, errorBody('forbidden', 'only the receiving agent may requeue an unfinished request'))
      return
    }
    if (!storeV2.requeue(messageId, Date.now() / 1000)) {
      sendJson(res, 404, errorBody('no_such_message', 'message is not in a requeue-able state'))
      return
    }
    console.warn(`[relay-broker] admin requeue ${messageId} by ${agent}`) // ids only, never content
    if (typeof wakeAgent === 'function') wakeAgent(existing.target, { messageId, rootId: existing.root_id }) // a requeued message must not wait for the next poll period
    sendJson(res, 200, { ok: true, message_id: messageId })
    return
  }

  if (req.method === 'POST' && path === '/v1/admin/cancel') {
    const parsed = parseJsonObject(rawBody)
    const messageId = String(parsed?.message_id || '').trim()
    if (!messageId) {
      sendJson(res, 400, errorBody('bad_request', 'message_id is required'))
      return
    }
    const existing = storeV2.get(messageId)
    if (!existing) {
      sendJson(res, 404, errorBody('no_such_message', 'message was not found'))
      return
    }
    const isAdmin = config.adminAgents?.has(agent) === true
    if (!isAdmin && (existing.origin !== agent || existing.kind !== 'request')) {
      sendJson(res, 403, errorBody('forbidden', 'only the requesting agent may cancel its request'))
      return
    }
    if (!storeV2.cancel(messageId, Date.now() / 1000)) {
      sendJson(res, 404, errorBody('no_such_message', 'message is not in a cancellable state'))
      return
    }
    console.warn(`[relay-broker] admin cancel ${messageId} by ${agent}`) // ids only, never content
    sendJson(res, 200, { ok: true, message_id: messageId })
    return
  }

  sendJson(res, 404, errorBody('not_found', `no v2 route ${req.method} ${path}`))
}
