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
import { resolveCli } from './resolve-cli.mjs'

const RESOLVED = resolveCli(process.env.CODEX_CMD || (process.platform === 'win32' ? 'codex.cmd' : 'codex'))

// The codex `exec --json` output is a JSON object on stdout. Build the args to
// match the reference codex CLI layout: approval/sandbox flags come BEFORE the
// `exec` subcommand, and `-` reads the prompt from stdin. Read/continue turns
// never bypass the sandbox; write-mode turns run inside the relay worktree.
function buildArgs(cwd) {
  const args = []
  const sandbox = process.env.CODEX_SANDBOX
  if (sandbox) args.push('--sandbox', sandbox)
  else args.push('--ask-for-approval', 'never')
  const model = process.env.CODEX_MODEL
  if (model) args.push('-m', model)
  if (cwd) args.push('--cd', cwd)
  args.push('exec', '--json', '--skip-git-repo-check', '-')
  return args
}

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  const cwd = process.env.RELAY_WORKSPACE || process.cwd()
  const env = { ...process.env }
  if (process.env.CODEX_HOME) env.CODEX_HOME = process.env.CODEX_HOME
  const child = spawn(RESOLVED.file, [...RESOLVED.args, ...buildArgs(cwd)], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (c) => { stdout += c })
  child.stderr.setEncoding('utf8').on('data', (c) => { stderr += c })
  child.on('error', (err) => {
    console.error(`codex-backend failed to start: ${err.message}`)
    process.exit(2)
  })
  child.on('close', (code) => {
    if (code !== 0) {
      console.error(`codex-backend exited ${code}: ${stderr.slice(0, 400)}`)
      process.exit(code || 1)
    }
    // codex exec --json prints the final result JSON (with the assistant reply).
    try {
      const parsed = JSON.parse(stdout)
      const text = parsed?.reply || parsed?.text || parsed?.result
      console.log(String(text ?? '').trim())
    } catch {
      // Fallback: emit the raw output trimmed (best effort).
      console.log(stdout.trim())
    }
    process.exit(0)
  })
  child.stdin.end(input)
})
