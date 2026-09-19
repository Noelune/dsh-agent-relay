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
import { resolveSecret } from '../lib/credentials.mjs'
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
    if (!key.startsWith('--')) continue
    const name = key.slice(2)
    const next = argv[i + 1]
    // A trailing flag, or one followed by another flag, is boolean (`--once`).
    if (next === undefined || next.startsWith('--')) out[name] = true
    else {
      out[name] = next
      i++
    }
  }
  return out
}

/** A flag given without a value is boolean; only real strings may be settings. */
function str(value) {
  return typeof value === 'string' ? value : undefined
}

function resolveConfig(flags) {
  let file = {}
  try { if (existsSync(CONFIG_FILE)) file = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) } catch { /* ignore */ }
  const env = process.env
  return {
    agent: (str(flags.agent) ?? env.AGENT_RELAY_AGENT ?? file.agent ?? '').toLowerCase(),
    broker: str(flags.broker) ?? env.AGENT_RELAY_BROKER_URL ?? file.endpoint ?? 'http://127.0.0.1:19121',
    secret: str(flags.secret) ?? env.AGENT_RELAY_SECRET ?? file.secret ?? '',
    // Same precedence as the DSH plugin, so a member never has to keep a secret
    // in a file: env var, then a vault entry resolved through secret_ref.
    secretEnv: str(flags['secret-env']) ?? env.AGENT_RELAY_SECRET_ENV ?? file.secret_env ?? '',
    secretEnvFile: str(flags['secret-env-file']) ?? env.AGENT_RELAY_SECRET_ENV_FILE ?? file.secret_env_file ?? '',
    secretRef: str(flags['secret-ref']) ?? env.AGENT_RELAY_SECRET_REF ?? file.secret_ref ?? '',
    vaultModule: str(flags['vault-module']) ?? env.AGENT_RELAY_VAULT_MODULE ?? file.vault_module ?? '',
    backendCmd: str(flags['backend-cmd']) ?? env.AGENT_RELAY_BACKEND_CMD ?? file.backend_cmd ?? '',
    cwd: str(flags.cwd) ?? env.AGENT_RELAY_CWD ?? file.cwd ?? process.cwd(),
    worktreeParent: str(flags['worktree-parent']) ?? env.AGENT_RELAY_WORKTREE_PARENT ?? file.worktree_parent ?? WORKTREE_PARENT,
    lockRoot: str(flags['lock-root']) ?? env.AGENT_RELAY_LOCK_ROOT ?? file.lock_root ?? LOCK_ROOT,
    pollSeconds: Number(flags['poll-seconds'] ?? env.AGENT_RELAY_POLL_SECONDS ?? file.poll_seconds ?? 2),
    // Long-poll hold: the broker parks the request and answers the moment
    // something arrives, so this is a latency bound, not a polling period.
    waitSeconds: Number(flags['wait-seconds'] ?? env.AGENT_RELAY_WAIT_SECONDS ?? file.wait_seconds ?? 30),
    once: flags.once !== undefined || String(env.AGENT_RELAY_ONCE ?? '') === '1' || file.once === true,
    maxTasks: Number(flags['max-tasks'] ?? env.AGENT_RELAY_MAX_TASKS ?? file.max_tasks ?? 8),
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
  // Keep the broker delivery lease alive while the backend runs (v3 brokers):
  // without renewal a turn longer than the lease window is re-queued and
  // re-delivered while the original is still in flight.
  const renewTimer = msg.lease_token
    ? setInterval(() => {
        client.renewLease(msg.message_id, msg.lease_token, 600)
          .catch((e) => console.error(`[relay-agent] lease renewal ended for ${msg.message_id}: ${e.message}`))
      }, 240_000)
    : null
  if (renewTimer) renewTimer.unref?.()
  try {
    const prompt = buildInboundPrompt(msg) + (plan.isolated ? `\n[isolated workspace: ${plan.workspace}]\n` : '')
    const output = await runBackend(cfg, prompt, plan.workspace)
    const replyText = output + relayWorkspaceNote(plan)
    await client.sendReply(msg, replyText, `reply:${msg.message_id}`)
    await client.ack(msg.message_id, 'completed', undefined, msg.lease_token)
    console.error(`[relay-agent] ${msg.message_id} completed (${plan.isolated ? 'worktree' : plan.requiresWriteLease ? 'lease' : 'in-place'})`)
  } catch (e) {
    console.error(`[relay-agent] ${msg.message_id} failed: ${e.message}`)
    try { await client.ack(msg.message_id, 'retry', String(e?.message || 'error').slice(0, 300), msg.lease_token) } catch { /* best-effort */ }
  } finally {
    if (renewTimer) clearInterval(renewTimer)
    if (lease) lease.release()
  }
}

/**
 * Claim-and-work loop.
 *
 * Default: stay resident and long-poll — one held request, answered the instant
 * a message lands, so there is no 2 s "did anything arrive?" chatter.
 *
 * `--once`: drain the inbox (up to `--max-tasks`) and exit. This is the shape
 * the broker's `agents.<name>.wake_command` starts on demand, which is what lets
 * a member be *reachable without running anything*.
 */
async function main() {
  const cfg = resolveConfig(parseArgs(process.argv.slice(2)))
  if (!cfg.agent) throw new Error('missing --agent (or AGENT_RELAY_AGENT)')
  if (!cfg.secret) cfg.secret = await resolveSecret(cfg)
  if (!cfg.secret) throw new Error('missing credential: pass --secret, set AGENT_RELAY_SECRET, or point secret_ref + vault_module at a DPAPI vault entry')
  if (!cfg.backendCmd) throw new Error('missing --backend-cmd (or AGENT_RELAY_BACKEND_CMD)')
  const client = new RelayClientV2({ endpoint: cfg.broker, agent: cfg.agent, secret: cfg.secret })
  const health = await client.health()
  console.error(`[relay-agent] ${cfg.agent} joined circle (protocol v${health.protocol_version}); backend: ${cfg.backendCmd}${cfg.once ? ' [once]' : ''}`)

  let backoffSeconds = 1
  let handled = 0
  for (;;) {
    try {
      const messages = await client.pull({ limit: cfg.once ? 4 : 1, waitSeconds: cfg.once ? 5 : cfg.waitSeconds })
      backoffSeconds = 1
      for (const m of messages) {
        await processMessage(client, normalizeMessage(m), cfg)
        handled += 1
      }
      if (cfg.once) {
        // A wake-up worker exits as soon as the queue is dry; the broker starts
        // another one when the next message arrives.
        if (!messages.length || handled >= cfg.maxTasks) {
          console.error(`[relay-agent] ${cfg.agent} drained after ${handled} task(s)`)
          return
        }
        continue
      }
      continue
    } catch (e) {
      console.error(`[relay-agent] broker unreachable, retry in ${backoffSeconds}s: ${e.message}`)
      if (cfg.once) throw e
      backoffSeconds = Math.min(backoffSeconds * 2, 30)
    }
    await new Promise((r) => setTimeout(r, backoffSeconds * 1000))
  }
}

main().catch((e) => { console.error(`[relay-agent] fatal: ${e.message}`); process.exit(1) })
