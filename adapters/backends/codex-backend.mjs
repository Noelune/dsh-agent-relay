#!/usr/bin/env node
/**
 * Codex CLI backend for the standalone relay agent (adapters/relay-agent.mjs).
 *
 * Reads a relay prompt on stdin and produces the Codex reply on stdout. This is
 * a GENERIC wrapper around the `codex` CLI — no Feishu/Hermes dependency. Any
 * machine with the `codex` CLI installed can answer relay requests with it:
 *
 *   node adapters/relay-agent.mjs \
 *     --agent codex --broker http://127.0.0.1:19121 --secret <hex> \
 *     --backend-cmd "node adapters/backends/codex-backend.mjs" \
 *     --cwd D:/workspace/proj
 *
 * Environment:
 *   CODEX_CMD   codex executable (default "codex")
 *   CODEX_HOME  codex home dir (optional)
 *   CODEX_SANDBOX  sandbox dir (optional; the relay worker already isolates
 *                  write-mode requests into a git worktree)
 */
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolveCli } from './resolve-cli.mjs'

/**
 * Extract the assistant answer from `codex exec --json` output.
 *
 * That CLI prints an **event stream** — one JSON object per line
 * (`thread.started`, `turn.started`, `item.completed`, `turn.completed`) — not a
 * single result object. The previous whole-payload `JSON.parse(stdout)` therefore
 * always threw and the relay forwarded the raw event dump as the "reply", which
 * is unusable for an automated handoff (observed live 2026-09-19).
 *
 * @param {string} stdout raw stdout from the codex CLI
 * @returns {{text: string, kind: 'answer'|'error'|'raw'}}
 */
export function extractCodexReply(stdout) {
  const text = String(stdout ?? '')
  const answers = []
  const errors = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let event
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue // partial or non-JSON line
    }
    // Older single-result shape, plus the newer itemised events.
    const legacy = event.reply ?? event.result ?? event.text
    if (typeof legacy === 'string' && legacy.trim()) answers.push(legacy.trim())
    const item = event.item
    if (item?.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) {
      answers.push(item.text.trim())
    } else if (item?.type === 'error' && typeof item.message === 'string' && item.message.trim()) {
      errors.push(item.message.trim())
    } else if (event.type === 'error' && typeof event.message === 'string' && event.message.trim()) {
      errors.push(event.message.trim())
    }
  }
  if (answers.length) return { text: answers.join('\n\n'), kind: 'answer' }
  if (errors.length) return { text: errors.join('\n'), kind: 'error' }
  const whole = text.trim()
  // A CLI that ignored --json and printed prose is still a usable answer.
  return whole && !whole.startsWith('{') ? { text: whole, kind: 'raw' } : { text: '', kind: 'raw' }
}

/** Args for the reference codex layout: flags before `exec`, `-` reads stdin. */
export function buildCodexArgs(cwd, env = process.env) {
  const args = []
  if (env.CODEX_SANDBOX) args.push('--sandbox', env.CODEX_SANDBOX)
  else args.push('--ask-for-approval', 'never')
  if (env.CODEX_MODEL) args.push('-m', env.CODEX_MODEL)
  if (cwd) args.push('--cd', cwd)
  args.push('exec', '--json', '--skip-git-repo-check', '-')
  return args
}

/** Run the CLI and write the extracted answer to stdout. */
export function run(prompt, { cwd = process.cwd(), resolved, env = process.env, write = (s) => process.stdout.write(s) } = {}) {
  const cli = resolved ?? resolveCli(env.CODEX_CMD || (process.platform === 'win32' ? 'codex.cmd' : 'codex'))
  return new Promise((resolvePromise) => {
    const child = spawn(cli.file, [...cli.args, ...buildCodexArgs(cwd, env)], {
      env, cwd: cwd || undefined, stdio: ['pipe', 'pipe', 'pipe'],
      // `resolveCli` may fall back to a raw .cmd shim, which needs a shell on
      // Windows — honour its `shell` flag instead of failing to spawn.
      ...(cli.shell ? { shell: true } : {}),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (c) => { stdout += c })
    child.stderr.setEncoding('utf8').on('data', (c) => { stderr += c })
    child.once('error', (err) => {
      write(`codex-backend failed to start: ${err.message}`)
      resolvePromise(2)
    })
    child.once('close', (code) => {
      // Prefer whatever the run actually produced, even on a non-zero exit: a
      // truncated turn still carries the part the peer can act on.
      const extracted = extractCodexReply(stdout)
      if (extracted.text) {
        write(extracted.text)
        if (code !== 0) write(`\n[codex-backend 退出码 ${code}：${stderr.slice(0, 200)}]`)
        resolvePromise(0)
        return
      }
      write(stderr.trim() || `codex-backend exited ${code} without output`)
      resolvePromise(code || 1)
    })
    child.stdin.end(prompt)
  })
}

// Script behaviour only when executed directly, so `extractCodexReply` stays
// importable (an import must not start consuming stdin).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => { input += chunk })
  process.stdin.on('end', async () => {
    process.exitCode = await run(input, { cwd: process.env.RELAY_WORKSPACE || process.cwd() })
  })
}
