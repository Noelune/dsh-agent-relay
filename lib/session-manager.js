/**
 * Session lifecycle for relay turns: create/resume DSH agents per relay
 * session, recycle idle handles, and run a single relay turn to completion.
 *
 * Extracted from lib/index.js (2026-08-29 stabilization split). Pure state +
 * policy; no wiring. The composition root passes ctx/cfg/diag plus an
 * isStopping() accessor.
 */
import { homedir } from 'node:os'
import { relaySessionId, buildInboundPrompt, extractReplyText } from './relay-plugin-core.js'

export function createSessionManager({ ctx, cfg, diag, isStopping }) {
  const sessionHandles = new Map()
  const sessionLastUsed = new Map()
  const sessionPromises = new Map()

  function defaultCwd() {
    try {
      const sp = ctx.get('sandboxPolicy')
      if (sp && sp.workspaceRoot) return sp.workspaceRoot
    } catch { /* ignore */ }
    return cfg.cwd || homedir()
  }

  function defaultAgentOptions() {
    try {
      const adm = ctx.get('agentDefaultModel')
      if (adm) {
        const sel = adm.currentSelection()
        if (sel && sel.provider && sel.model) return { provider: String(sel.provider), model: String(sel.model) }
      }
    } catch { /* ignore */ }
    return {}
  }

  async function archiveRelaySession(sessionId) {
    try {
      const wr = ctx.get('workspaceRegistry')
      if (wr) await wr.archiveSession(sessionId)
    } catch (e) { diag('archive ' + sessionId + ' failed: ' + e.message) }
  }

  async function getOrCreateAgent(sessionId) {
    const live = ctx.agents.get(sessionId)
    if (live) {
      sessionLastUsed.set(sessionId, Date.now())
      return { agent: live, owned: false }
    }
    const existing = sessionPromises.get(sessionId)
    if (existing) return existing
    const promise = (async () => {
      const agentOptions = defaultAgentOptions()
      let handle = null
      if (ctx.get('sessionPersistence')) {
        try {
          handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions })
        } catch (e) {
          diag('resume failed for ' + sessionId + ': ' + e.message + '; creating fresh')
          handle = null
        }
      }
      if (!handle) {
        handle = await ctx.agents.create({
          sessionId,
          meta: { cwd: defaultCwd() },
          agentOptions,
        })
      }
      sessionHandles.set(sessionId, handle)
      sessionLastUsed.set(sessionId, Date.now())
      await archiveRelaySession(sessionId)
      return { agent: handle.agent, owned: true }
    })()
    sessionPromises.set(sessionId, promise)
    try {
      return await promise
    } finally {
      sessionPromises.delete(sessionId)
    }
  }

  function sweepIdleSessions() {
    if (isStopping() || !cfg) return
    const idleMs = cfg.sessionIdleSeconds * 1000
    const now = Date.now()
    for (const [sessionId, handle] of Array.from(sessionHandles.entries())) {
      const lastUsed = sessionLastUsed.get(sessionId) || 0
      if (now - lastUsed <= idleMs) continue
      try {
        if (handle.agent && handle.agent.status === 'idle') {
          sessionHandles.delete(sessionId)
          sessionLastUsed.delete(sessionId)
          Promise.resolve().then(() => handle.dispose().catch((e) => diag('dispose ' + sessionId + ' failed: ' + e.message)))
          diag('recycled idle relay session ' + sessionId)
        }
      } catch (e) { diag('sweep ' + sessionId + ' failed: ' + e.message) }
    }
  }

  function disposeSessionHandles() {
    for (const [id, handle] of Array.from(sessionHandles.entries())) {
      sessionHandles.delete(id)
      sessionLastUsed.delete(id)
      Promise.resolve().then(() => handle.dispose().catch((e) => diag('dispose ' + id + ' failed: ' + e.message)))
    }
  }

  /** Drive one relay turn on the session's agent and wait for its reply text. */
  async function runRelayTurn(msg) {
    const sessionId = relaySessionId(msg.root_id || msg.message_id)
    const { agent } = await getOrCreateAgent(sessionId)
    sessionLastUsed.set(sessionId, Date.now())
    const presets = ctx.get('permissionPresets')
    const approval = ctx.get('approval')
    const modeName = msg.execution_mode === 'write' ? 'workspace-write' : 'read-only'
    try {
      if (presets) presets.set(agent.session, modeName)
      if (approval) approval.setPolicy(agent, 'never')
    } catch (e) { diag('permission setup failed: ' + e.message) }
    try {
      const titleSvc = ctx.get('sessionTitle')
      // 统一会话标题规范 v2（~/.agents/specs/session-title-convention.md §7）：
      // 协作 │ <来源官方名> │ <请求主题前14全角当量>
      if (titleSvc) {
        const officialNames = { dsh: 'DSH', hermes: 'Hermes', codex: 'Codex', claude: 'Claude', zcode: 'ZCode' }
        const source = String(msg.origin || 'peer').toLowerCase()
        const who = officialNames[source] || source.charAt(0).toUpperCase() + source.slice(1, 12)
        titleSvc.rename(agent.session, '协作 │ ' + who + ' │ ' + String(msg.body || '').replace(/\s+/g, ' ').trim().slice(0, 14))
      }
    } catch { /* ignore */ }
    const boundary = agent.session.seq
    agent.followup({ id: `relay-${Date.now()}`, role: 'user', content: [{ type: 'text', text: buildInboundPrompt(msg) }], source: { kind: 'plugin', plugin: 'dsh-agent-relay' } })
    const timeoutMs = cfg.timeoutSeconds * 1000
    const startedAt = Date.now()
    const deadline = startedAt + timeoutMs
    let sawRunning = false
    while (true) {
      const text = extractReplyText(agent.session, boundary)
      const status = agent.status
      if (status === 'running') sawRunning = true
      if (status === 'idle') {
        if (text) return text
        if (sawRunning) throw new Error('agent produced no reply text')
        if (Date.now() - startedAt > 15000) throw new Error('relay turn never started')
      }
      if (Date.now() > deadline) {
        try { agent.cancel({ kind: 'hook', reason: 'agent-relay turn timeout' }) } catch { /* ignore */ }
        try { await agent.whenIdle() } catch { /* ignore */ }
        throw new Error('relay turn timed out after ' + timeoutMs + 'ms')
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  return { sessionLastUsed, getOrCreateAgent, sweepIdleSessions, disposeSessionHandles, runRelayTurn }
}
