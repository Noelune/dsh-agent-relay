/**
 * Inbound message dispatch: request → local relay turn → reply to peer;
 * reply → steer the originating session. Deduplicates redelivery while a
 * turn is in flight and replays completed receipts.
 *
 * Extracted from lib/index.js (2026-08-29 stabilization split). Accessors are
 * used for client/receipts/routes because they are created asynchronously
 * after the plugin mounts.
 */
import { normalizeMessage, MAX_BODY_CHARS } from './relay-plugin-core.js'

export function createMessageHandlers({ ctx, diag, getClient, getReceipts, getRoutes, sessionManager }) {
  const inFlight = new Set()
  const { runRelayTurn } = sessionManager

  async function handleRequest(msg) {
    const client = getClient()
    const messageId = msg.message_id
    if (!client) return
    const receipts = getReceipts()
    const receipt = receipts?.get(messageId)
    if (receipt && receipt.status === 'completed' && receipt.response_text) {
      diag('replay reply from receipt for ' + messageId)
      await client.sendReply(msg, receipt.response_text, `reply:${messageId}`)
      await client.ack(messageId, 'completed')
      return
    }
    if (inFlight.has(messageId)) {
      diag('re-delivered while in flight: ' + messageId + ' (original turn continues)')
      await client.ack(messageId, 'completed')
      return
    }
    inFlight.add(messageId)
    try {
      const replyText = await runRelayTurn(msg)
      receipts?.set(messageId, { id: messageId, status: 'completed', response_text: replyText.slice(0, MAX_BODY_CHARS) })
      await client.sendReply(msg, replyText, `reply:${messageId}`)
      await client.ack(messageId, 'completed')
      diag('request ' + messageId + ' completed')
    } catch (e) {
      diag('request ' + messageId + ' failed: ' + e.message)
      try { await client.ack(messageId, 'retry', String(e?.message || 'error').slice(0, 300)) } catch { /* best-effort */ }
    } finally {
      inFlight.delete(messageId)
    }
  }

  async function handleReply(msg) {
    const client = getClient()
    if (!client) return
    const routes = getRoutes()
    const route = msg.parent_id ? routes?.get(msg.parent_id) : null
    let delivered = false
    if (route) {
      const agent = ctx.agents.get(String(route.session_id || ''))
      if (agent) {
        try {
          agent.steer({
            id: `relay-reply-${Date.now()}`,
            role: 'user',
            content: [{ type: 'text', text: `[来自 ${msg.origin} 的 agent-relay 回复]\n\n${msg.body}` }],
            source: { kind: 'plugin', plugin: 'dsh-agent-relay' },
          })
          delivered = true
        } catch (e) { diag('steer failed: ' + e.message) }
      }
    }
    if (!delivered) diag('reply for ' + msg.parent_id + ' from ' + msg.origin + ' has no live route; dropped')
    await client.ack(msg.message_id, 'completed')
  }

  async function handleMessage(msg) {
    const m = normalizeMessage(msg)
    if (m.kind === 'reply') { await handleReply(m); return }
    if (m.kind === 'request') { await handleRequest(m); return }
    const client = getClient()
    if (client) await client.ack(m.message_id, 'completed')
  }

  return { handleMessage }
}
