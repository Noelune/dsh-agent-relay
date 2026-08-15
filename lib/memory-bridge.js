/**
 * Optional bridge to the unified-agent-memory CLI (github.com/Noelune/
 * unified-agent-memory). Lets agent_relay_send attach relevant shared-memory
 * excerpts to a request's `context` field. Fully optional: if no command is
 * configured, memorySearch returns { ok: false } and the caller attaches a
 * "not configured" note instead of failing.
 *
 * The command is invoked as `<cmd> search <query> --limit <n>` and its output
 * (wrapped in <memory-data> markers by the memory CLI) is returned verbatim.
 */
import { execFile } from 'node:child_process'

/**
 * @param {object} opts
 * @param {string} opts.cmd - e.g. "python -m unified_memory.memory"
 * @param {string} opts.query - search keywords
 * @param {number} [opts.limit=8]
 * @param {number} [opts.timeoutMs=15000]
 * @returns {Promise<{ok: boolean, output?: string, error?: string}>}
 */
export function memorySearch({ cmd, query, limit = 8, timeoutMs = 15000 }) {
  return new Promise((resolve) => {
    if (!cmd) { resolve({ ok: false, error: 'memory command not configured' }); return }
    const tokens = cmd.trim().split(/\s+/)
    const [prog, ...args] = tokens
    const child = execFile(
      prog,
      [...args, 'search', String(query), '--limit', String(Math.max(1, Math.min(limit, 20)))],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) resolve({ ok: false, error: String(stderr || err.message).slice(0, 300) })
        else resolve({ ok: true, output: String(stdout || '').trim() })
      },
    )
    if (child.stdin) { try { child.stdin.end() } catch { /* ignore */ } }
  })
}

/** Wrap a memory search result (or an error) into a context block. */
export function formatMemoryContext(result, maxChars = 8000) {
  if (result.ok && result.output) {
    return `\n[共享记忆摘录（unified-agent-memory）]\n${result.output.slice(0, maxChars)}`
  }
  return `\n[memory bridge unavailable: ${result.error || 'no result'} — set UNIFIED_MEMORY_CMD]`
}
