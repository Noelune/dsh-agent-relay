#!/usr/bin/env node
/**
 * Claude CLI backend for the standalone relay agent (adapters/relay-agent.mjs).
 *
 * Reads a relay prompt on stdin and produces the Claude reply on stdout. A
 * GENERIC wrapper around the `claude` CLI — no Feishu/Hermes dependency:
 *
 *   node adapters/relay-agent.mjs \
 *     --agent claude --broker http://127.0.0.1:19121 --secret <hex> \
 *     --backend-cmd "node adapters/backends/claude-backend.mjs" \
 *     --cwd D:/workspace/proj
 *
 * Environment:
 *   CLAUDE_CMD      claude executable (default "claude" on POSIX, "claude.cmd"
 *                   on Windows — the relay agent passes the platform's shim)
 *   CLAUDE_MODEL    optional model override
 *
 * The CLI runs with `--output-format stream-json`; we parse the JSON event
 * stream and emit the accumulated assistant text as the final reply.
 */
import { spawn } from 'node:child_process'
import { resolveCli } from './resolve-cli.mjs'

const cmd = process.env.CLAUDE_CMD || (process.platform === 'win32' ? 'claude.cmd' : 'claude')
const RESOLVED = resolveCli(cmd)

function buildArgs(cwd) {
  const args = [
    '--verbose',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--permission-mode', 'plan', // read/plan only: the relay worker grants write via a worktree
  ]
  const model = process.env.CLAUDE_MODEL
  if (model) args.push('--model', model)
  return args
}

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  const cwd = process.env.RELAY_WORKSPACE || process.cwd()
  const child = spawn(RESOLVED.file, [...RESOLVED.args, ...buildArgs(cwd)], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  const textParts = []
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    // stream-json emits one JSON object per line.
    for (const line of chunk.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const evt = JSON.parse(line)
        if (evt.type === 'assistant' && evt.message?.content) {
          const t = evt.message.content
            .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join('')
          if (t) textParts.push(t)
        }
      } catch { /* partial line — skip */ }
    }
  })
  child.stderr.setEncoding('utf8').on('data', (c) => { stderr += c })
  child.on('error', (err) => {
    console.error(`claude-backend failed to start: ${err.message}`)
    process.exit(2)
  })
  child.on('close', (code) => {
    if (code !== 0 && !textParts.length) {
      console.error(`claude-backend exited ${code}: ${stderr.slice(0, 400)}`)
      process.exit(code || 1)
    }
    // Take the last assistant text block as the reply.
    const reply = textParts.length ? textParts[textParts.length - 1].trim() : stdoutFallback()
    console.log(reply)
    process.exit(0)
  })
  child.stdin.end(input)

  let rawOut = ''
  function stdoutFallback() {
    return rawOut.trim()
  }
  child.stdout.on('data', (c) => { rawOut += c }) // in case no structured events matched
})
