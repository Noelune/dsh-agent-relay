#!/usr/bin/env node
/**
 * Cross-check relay member secrets between the broker YAML and the agent-side
 * .env file. The broker authenticates with agents.<name>.secret from the YAML
 * while every client signs with AGENT_RELAY_<NAME>_SECRET from .env — when
 * the two drift, members start receiving 401s. This tool detects (and
 * optionally repairs) that drift. Secret values are never printed.
 *
 * Usage:
 *   node setup/sync-secrets.mjs                    # check: report drift, exit 1 on mismatch
 *   node setup/sync-secrets.mjs --apply            # copy .env values into the YAML (backs up first)
 *   node setup/sync-secrets.mjs --config <yaml> --env <file>
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { compareSecrets, envKeyFor, parseEnvSecrets, parseYamlAgents } from './secret-io.mjs'

const DEFAULT_CONFIG = join(homedir(), '.dsh', 'relay-broker', 'config-19121.yaml')
const DEFAULT_ENV = 'D:\\AI机器人\\飞书CodexClaude机器人\\.env'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const configPath = args.includes('--config') ? args[args.indexOf('--config') + 1] : DEFAULT_CONFIG
const envPath = args.includes('--env') ? args[args.indexOf('--env') + 1] : DEFAULT_ENV

if (!existsSync(configPath) || !existsSync(envPath)) {
  console.error(`config or .env not found:\n  config: ${configPath}\n  env:    ${envPath}`)
  console.error('usage: node setup/sync-secrets.mjs [--apply] [--config <yaml>] [--env <file>]')
  process.exit(2)
}

const { lines, agents } = parseYamlAgents(readFileSync(configPath, 'utf8'))
const envSecrets = parseEnvSecrets(readFileSync(envPath, 'utf8'))
const { ok, drift, onlyYaml, onlyEnv } = compareSecrets(agents, envSecrets)

console.log(`config: ${configPath}`)
console.log(`env:    ${envPath}`)
console.log(`ok=${ok} drift=${drift.length} only-in-yaml=${onlyYaml.length} only-in-env=${onlyEnv.length}`)
for (const name of drift) console.log(`  DRIFT: ${name} (values differ)`)
for (const name of onlyYaml) console.log(`  MISSING-IN-ENV: ${name}`)
for (const name of onlyEnv) console.log(`  MISSING-IN-YAML: ${name}`)

if (!apply) {
  process.exit(drift.length || onlyYaml.length || onlyEnv.length ? 1 : 0)
}

if (!drift.length) {
  console.log('nothing to apply; YAML already matches .env')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
const backupPath = `${configPath}.bak-syncsecrets-${stamp}`
copyFileSync(configPath, backupPath)
for (const name of drift) {
  const rec = agents.get(name)
  lines[rec.secretLineIndex] = rec.secretPrefix + envSecrets.get(envKeyFor(name, envSecrets))
}
writeFileSync(configPath, lines.join('\n'), 'utf8')

const verify = parseYamlAgents(readFileSync(configPath, 'utf8'))
const stillDrifting = drift.filter((name) => verify.agents.get(name)?.secret !== envSecrets.get(envKeyFor(name, envSecrets)))
if (stillDrifting.length) {
  console.error(`apply failed verification for: ${stillDrifting.join(', ')} (backup: ${backupPath})`)
  process.exit(1)
}
console.log(`applied .env values for: ${drift.join(', ')}`)
console.log(`backup: ${backupPath}`)
