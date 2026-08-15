#!/usr/bin/env node
/**
 * Standalone relay agent (mirrors the self-use relay/agent.py).
 *
 * Polls the broker inbox for one identity and answers relay requests WITHOUT a
 * dsh host — the "backend" is any CLI that reads a prompt on stdin and writes
 * its reply to stdout (e.g. `codex exec --json`, `claude -p`, or a custom
 * script). Write-mode requests are isolated into a git worktree when possible,
 * otherwise serialized via a cross-agent workspace write lease.
 *
 * Usage:
 *   node adapters/relay-agent.mjs \
 *     --agent codex \
 *     --broker http://127.0.0.1:19121 \
 *     --secret <hex> \
 *     --backend-cmd "codex exec --json" \
 *     --cwd D:/workspace/proj
 *
 * Config sources (lowest → highest): ~/.dsh/agent-relay.json, env, flags.
 */
import { homedir } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { RelayClientV2 } from '../lib/client-v2.js'
import { normalizeMessage, buildInboundPrompt } from '../lib/relay-plugin-core.js'
import { prepareRelayWorkspace, relayWorkspaceNote } from '../lib/workspace.js'
import { WorkspaceLease } from '../lib/lease.js'

const CONFIG_FILE = join(homedir(), '.dsh', 'agent-relay.json')
const LOCK_ROOT = join(homedir(), '.dsh', 'workspace-locks')
const WORKTREE_PARENT = join(homedir(), '.dsh', 'relay-worktrees')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key.startsWith('--')) out[key.slice(2)] = argv[i + 1]
  }
  return out
}

function resolveConfig(flags) {
  let file = {}
  try { if (existsSync(CONFIG_FILE)) file = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) } catch { /* ignore */ }
  const env = process.env
  return {
    agent: (flags.agent ?? env.AGENT_RELAY_AGENT ?? file.agent ?? '').toLowerCase(),
    broker: flags.broker ?? env.AGENT_RELAY_BROKER_URL ?? file.endpoint ?? 'http://127.0.0.1:19121',
    secret: flags.secret ?? env.AGENT_RELAY_SECRET ?? file.secret ?? '',
    backendCmd: flags['backend-cmd'] ?? env.AGENT_RELAY_BACKEND_CMD ?? file.backend_cmd ?? '',
    cwd: flags.cwd ?? env.AGENT_RELAY_CWD ?? file.cwd ?? process.cwd(),
    worktreeParent: flags['worktree-parent'] ?? env.AGENT_RELAY_WORKTREE_PARENT ?? file.worktree_parent ?? WORKTREE_PARENT,
    lockRoot: flags['lock-root'] ?? env.AGENT_RELAY_LOCK_ROOT ?? file.lock_root ?? LOCK_ROOT,
    pollSeconds: Number(flags['poll-seconds'] ?? env.AGENT_RELAY_POLL_SECONDS ?? file.poll_seconds ?? 2),
  }
}

function runBackend(cfg, prompt, cwd) {
  return new Promise((resolve, reject) => {
    const tokens = cfg.backendCmd.trim().split(/\s+/)
    const [prog, ...args] = tokens
    const env = { ...process.env, RELAY_WORKSPACE: cwd }
    const child = execFile(prog, args, { cwd, env, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).slice(0, 500)))
      else resolve(String(stdout || '').trim())
    })
    child.stdin.end(prompt)
  })
}

async function processMessage(client, msg, cfg) {
  if (msg.kind !== 'request') {
    await client.ack(msg.message_id, 'completed')
    return
  }
  const plan = prepareRelayWorkspace({
    baseWorkspace: cfg.cwd, worktreeParent: cfg.worktreeParent,
    agentName: cfg.agent, messageId: msg.message_id, executionMode: msg.execution_mode,
  })
  let lease = null
  if (plan.requiresWriteLease) {
    lease = WorkspaceLease.tryAcquire(cfg.lockRoot, cfg.cwd, `relay-write:${cfg.agent}:${msg.message_id}`).lease
    if (!lease) {
      await client.ack(msg.message_id, 'retry', 'workspace locked by another writer')
      return
    }
  }
  try {
    const prompt = buildInboundPrompt(msg) + (plan.isolated ? `\n[isolated workspace: ${plan.workspace}]\n` : '')
    const output = await runBackend(cfg, prompt, plan.workspace)
    const replyText = output + relayWorkspaceNote(plan)
    await client.sendReply(msg, replyText, `reply:${msg.message_id}`)
    await client.ack(msg.message_id, 'completed')
    console.error(`[relay-agent] ${msg.message_id} completed (${plan.isolated ? 'worktree' : plan.requiresWriteLease ? 'lease' : 'in-place'})`)
  } catch (e) {
    console.error(`[relay-agent] ${msg.message_id} failed: ${e.message}`)
    try { await client.ack(msg.message_id, 'retry', String(e?.message || 'error').slice(0, 300)) } catch { /* best-effort */ }
  } finally {
    if (lease) lease.release()
  }
}

async function main() {
  const cfg = resolveConfig(parseArgs(process.argv.slice(2)))
  if (!cfg.agent) throw new Error('missing --agent (or AGENT_RELAY_AGENT)')
  if (!cfg.secret) throw new Error('missing --secret (or AGENT_RELAY_SECRET)')
  if (!cfg.backendCmd) throw new Error('missing --backend-cmd (or AGENT_RELAY_BACKEND_CMD)')
  const client = new RelayClientV2({ endpoint: cfg.broker, agent: cfg.agent, secret: cfg.secret })
  const health = await client.health()
  console.error(`[relay-agent] ${cfg.agent} joined circle (protocol v${health.protocol_version}); backend: ${cfg.backendCmd}`)

  let backoff = cfg.pollSeconds
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const messages = await client.pull({ limit: 1 })
      backoff = cfg.pollSeconds
      for (const m of messages) {
        await processMessage(client, normalizeMessage(m), cfg)
      }
    } catch (e) {
      console.error(`[relay-agent] broker unreachable, retry in ${backoff}s: ${e.message}`)
      backoff = Math.min(backoff * 2, 30)
    }
    await new Promise((r) => setTimeout(r, backoff * 1000))
  }
}

main().catch((e) => { console.error(`[relay-agent] fatal: ${e.message}`); process.exit(1) })
