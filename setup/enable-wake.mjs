#!/usr/bin/env node
/**
 * enable-wake — turn a member into a reachable-without-a-daemon member.
 *
 * Adds a `wake_command` line to that member's block in the broker config, so the
 * broker starts a headless worker when a message lands for it while it is not
 * polling. Dry-run by default: this command **spends money when applied** (the
 * worker runs the real agent CLI), so it prints exactly what it would write and
 * requires --apply.
 *
 *   node setup/enable-wake.mjs --agent codex
 *   node setup/enable-wake.mjs --agent codex --apply
 *   node setup/enable-wake.mjs --all-clients --apply
 *
 * It never touches secrets: the broker injects AGENT_RELAY_SECRET into the
 * worker's environment at spawn time.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NODE = process.execPath
const DEFAULT_CONFIG = join(homedir(), '.dsh', 'relay-broker', 'config-19121.yaml')
const BACKENDS = ['codex', 'claude']

function parseArgs(argv) {
  const out = { apply: false }
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key === '--apply') out.apply = true
    else if (key === '--all-clients') out.allClients = true
    else if (key.startsWith('--')) { out[key.slice(2)] = argv[i + 1]; i++ }
  }
  return out
}

/** The worker command: claims what is queued, answers, exits when the queue is dry. */
export function wakeCommandFor(agent, { backend = agent, cwd = homedir(), repo = REPO, node = NODE } = {}) {
  const backendCmd = `${node} ${join(repo, 'adapters', 'backends', `${backend}-backend.mjs`)}`
  return `${node} ${join(repo, 'adapters', 'relay-agent.mjs')} --once --max-tasks 4 `
    + `--backend-cmd "${backendCmd}" --cwd ${cwd}`
}

/** Insert (or report) `wake_command:` lines under each requested agent block. */
export function planWakeConfig(text, agents, commands) {
  const lines = text.split(/\r?\n/)
  const plan = []
  const out = [...lines]
  for (const agent of agents) {
    const start = out.findIndex((l) => l === `  ${agent}:`)
    if (start === -1) {
      plan.push({ agent, status: 'unknown_agent' })
      continue
    }
    let end = start + 1
    while (end < out.length && /^ {4}\S/.test(out[end])) end++
    const existing = out.slice(start + 1, end).find((l) => /^\s+wake_command:/.test(l))
    if (existing) {
      plan.push({ agent, status: 'already', line: existing.trim() })
      continue
    }
    const line = `    wake_command: "${commands[agent]}"`
    out.splice(end, 0, line)
    plan.push({ agent, status: 'add', line })
  }
  return { text: out.join('\n'), plan }
}

/** CLI entry. Exported so the module is safely importable (tests import the
 *  pure helpers above; a top-level side effect here would set process.exitCode
 *  in whoever imports it). */
export async function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv)
  const configPath = flags.config ?? DEFAULT_CONFIG
  if (!existsSync(configPath)) {
    console.error(`找不到 broker 配置：${configPath}（用 --config 指定）`)
    return 1
  }
  const raw = readFileSync(configPath, 'utf8')
  const configured = [...raw.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1])
  const wanted = flags.allClients
    ? configured.filter((name) => BACKENDS.includes(name))
    : [flags.agent].filter(Boolean)
  if (!wanted.length) {
    console.error('用法：node setup/enable-wake.mjs --agent <name> | --all-clients [--apply]')
    console.error(`当前成员：${configured.join(', ')}`)
    return 2
  }
  const commands = Object.fromEntries(wanted.map((a) => [a, wakeCommandFor(a, { cwd: flags.cwd })]))
  const { text, plan } = planWakeConfig(raw, wanted, commands)
  for (const item of plan) {
    if (item.status === 'add') console.log(`+ ${item.agent}\n  ${item.line.trim()}`)
    else console.log(`= ${item.agent} · ${item.status}${item.line ? ' → ' + item.line : ''}`)
  }
  const adds = plan.filter((p) => p.status === 'add')
  if (!adds.length) {
    console.log('\n无需改动。')
    return 0
  }
  if (!flags.apply) {
    console.log('\n预演模式：未写入。加 --apply 生效（写前自动备份，之后需重启 broker）。')
    console.log('注意：被唤醒的成员会真的跑一次自己的 Agent CLI，产生 API 费用。')
    return 0
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
  copyFileSync(configPath, `${configPath}.bak-${stamp}`)
  writeFileSync(configPath, text, 'utf8')
  console.log(`\n已写入 ${configPath}\n备份：${configPath}.bak-${stamp}`)
  console.log('下一步：重启 broker（taskkill /F /PID <pid> 后 schtasks /Run /TN Hermes_RelayBroker），再跑 node setup/doctor.mjs')
  return 0
}

// Only run the CLI when executed directly, never when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main()
}
