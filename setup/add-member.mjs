#!/usr/bin/env node
/**
 * Onboard a new relay member in one step: generate a secret, add the agent
 * block to the broker YAML (default ACL: read to every existing member,
 * write to nobody), append AGENT_RELAY_<NAME>_SECRET to the agent-side .env,
 * verify both sides agree after the write, and print broker restart
 * instructions. Secret values are never printed unless --show is passed.
 *
 * Usage:
 *   node setup/add-member.mjs <name> [--show] [--no-inbound]
 *        [--read-targets a,b] [--write-targets a,b]
 *        [--config <yaml>] [--env <file>] [--restart]
 *
 * <name>: lowercase [a-z0-9-], 2-16 chars. Refuses existing members (rotate
 * secrets with sync-secrets instead of re-adding). Default ACLs follow the
 * self-use security posture: everyone can read-mode the new member, the new
 * member can read-mode everyone, nobody gets write.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { envVarName, parseEnvSecrets, parseYamlAgents } from './secret-io.mjs'

const DEFAULT_CONFIG = join(homedir(), '.dsh', 'relay-broker', 'config-19121.yaml')
const DEFAULT_ENV = 'D:\\AI机器人\\飞书CodexClaude机器人\\.env'
const BROKER_TASK = 'Hermes_RelayBroker'

const args = process.argv.slice(2)
const name = args.find((a) => !a.startsWith('--'))
const flag = (f) => args.includes(f)
const flagValue = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined)
const show = flag('--show')
const noInbound = flag('--no-inbound')
const doRestart = flag('--restart')
const configPath = flagValue('--config') ?? DEFAULT_CONFIG
const envPath = flagValue('--env') ?? DEFAULT_ENV

function die(msg) {
  console.error(`error: ${msg}`)
  process.exit(1)
}

if (!name) {
  die('usage: node setup/add-member.mjs <name> [--show] [--no-inbound] [--read-targets a,b] [--write-targets a,b] [--config <yaml>] [--env <file>] [--restart]')
}
if (!/^[a-z][a-z0-9_-]{1,15}$/.test(name)) die(`member name "${name}" must match ^[a-z][a-z0-9_-]{1,15}$`)
if (!existsSync(configPath)) die(`config not found: ${configPath}`)
if (!existsSync(envPath)) die(`.env not found: ${envPath}`)

const configText = readFileSync(configPath, 'utf8')
const { lines, agents, sectionEnd } = parseYamlAgents(configText)
if (agents.size === 0) die(`no agents: section found in ${configPath}`)
if (agents.has(name)) die(`member "${name}" already exists in the broker config; rotate secrets with sync-secrets.mjs instead`)

const envText = readFileSync(envPath, 'utf8')
const envSecrets = parseEnvSecrets(envText)
const envKey = name.replace(/-/g, '_')
if (envSecrets.has(name) || envSecrets.has(envKey)) die(`env key for "${name}" already exists in ${envPath}`)

const parseList = (raw, flagName) => {
  if (raw === undefined) return null
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
  for (const target of list) {
    if (target === name) die(`--${flagName}: "${target}" is the new member itself`)
    if (!agents.has(target)) die(`--${flagName}: unknown member "${target}" (existing: ${[...agents.keys()].join(', ')})`)
  }
  return list
}
const readTargets = parseList(flagValue('--read-targets'), 'read-targets') ?? [...agents.keys()]
const writeTargets = parseList(flagValue('--write-targets'), 'write-targets') ?? []

const secret = randomBytes(32).toString('hex')
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
const configBackup = `${configPath}.bak-addmember-${stamp}`
const envBackup = `${envPath}.bak-addmember-${stamp}`

// Outbound: the new member's own block. Inbound: append the name to every
// existing member's allowed_read_targets so they can send to it.
const next = [...lines]
next.splice(sectionEnd, 0,
  `  ${name}:`,
  `    secret: ${secret}`,
  `    allowed_read_targets: [${readTargets.join(', ')}]`,
  `    allowed_write_targets: [${writeTargets.join(', ')}]`,
)
if (!noInbound) {
  const reparsed = parseYamlAgents(next.join('\n'))
  for (const [member, rec] of reparsed.agents) {
    if (member === name) continue
    if (rec.readLineIndex === -1) {
      console.warn(`warn: ${member} has no allowed_read_targets line; add "${name}" to it manually`)
      continue
    }
    if (!rec.readTargets.includes(name)) {
      next[rec.readLineIndex] = rec.readPrefix + `[${[...rec.readTargets, name].join(', ')}]`
    }
  }
}

const envLine = `${envVarName(name)}=${secret}`
const nextEnv = envText === '' || envText.endsWith('\n') ? envText + envLine + '\n' : envText + '\n' + envLine + '\n'

copyFileSync(configPath, configBackup)
copyFileSync(envPath, envBackup)
writeFileSync(configPath, next.join('\n'), 'utf8')
writeFileSync(envPath, nextEnv, 'utf8')

const verifyConfig = parseYamlAgents(readFileSync(configPath, 'utf8'))
const verifyEnv = parseEnvSecrets(readFileSync(envPath, 'utf8'))
const stored = verifyConfig.agents.get(name)
const envStored = verifyEnv.get(name) ?? verifyEnv.get(envKey)
if (!stored || stored.secret !== secret || envStored !== secret) {
  console.error(`verification failed; restore from backups:\n  ${configBackup}\n  ${envBackup}`)
  process.exit(1)
}

console.log(`member "${name}" onboarded: read→${readTargets.join(', ') || 'nobody'}; write→${writeTargets.join(', ') || 'nobody'}; inbound from everyone${noInbound ? ' DISABLED' : ''}`)
if (show) console.log(`secret (shown once; also stored in both files):\n${secret}`)
console.log(`backups:\n  ${configBackup}\n  ${envBackup}`)
console.log('takes effect after a broker restart:')
brokerRestartAdvice(doRestart)

function brokerPids() {
  const ps = `(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*broker*src*index.js*' }).ProcessId`
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
  return (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

function brokerRestartAdvice(perform) {
  const pids = brokerPids()
  const killLine = pids.length ? `  taskkill /F /PID ${pids.join(' /PID ')}` : '  taskkill /F /IM node.exe   # verify the PID first — no running broker detected'
  const runLine = `  schtasks /Run /TN ${BROKER_TASK}   # or: wscript //B "C:\\Users\\zhaowei\\.dsh\\relay-broker\\start-broker-hidden.vbs"`
  if (!perform) {
    console.log(`${killLine}\n${runLine}`)
    return
  }
  if (pids.length) {
    const kill = spawnSync('taskkill', ['/F', ...pids.flatMap((p) => ['/PID', p])], { encoding: 'utf8', shell: true })
    console.log((kill.stdout || kill.stderr || '').trim())
  } else {
    console.log('no running broker detected; starting via scheduled task')
  }
  setTimeout(() => {
    const run = spawnSync('schtasks', ['/Run', '/TN', BROKER_TASK], { encoding: 'utf8', shell: true })
    console.log((run.stdout || run.stderr || '').trim())
    if (run.status !== 0) console.log(`schtasks failed — start manually:\n${runLine}`)
  }, 1500)
}
