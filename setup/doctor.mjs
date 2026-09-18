#!/usr/bin/env node
/**
 * relay doctor — one command that answers "is the circle actually working?".
 *
 * Read-only. It exists because answering that question by hand on 2026-09-19
 * took six separate probes (healthz, the sqlite queue, two config files, the
 * process list); the answer should be one line per check, and every agent should
 * be able to run it unaided.
 *
 *   node setup/doctor.mjs [--json] [--quiet]
 *   --broker <url>        default http://127.0.0.1:19121
 *   --config <yaml>       default ~/.dsh/relay-broker/config-19121.yaml
 *   --env-file <path>     default the Feishu bot .env (AGENT_RELAY_*_SECRET)
 *   --data-dir <path>     default ~/.dsh/relay-broker/data
 *
 * Exit code: 0 all good, 1 something is broken, 2 warnings only.
 * Secrets are never printed — membership and drift are reported by name only.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseYamlAgents, parseEnvSecrets, compareSecrets } from './secret-io.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BOT_ENV_DEFAULT = 'D:/AI机器人/飞书CodexClaude机器人/.env'

export function defaultPaths() {
  return {
    broker: 'http://127.0.0.1:19121',
    config: join(homedir(), '.dsh', 'relay-broker', 'config-19121.yaml'),
    envFile: BOT_ENV_DEFAULT,
    dataDir: join(homedir(), '.dsh', 'relay-broker', 'data'),
    agentConfig: join(homedir(), '.dsh', 'agent-relay.json'),
    deployedAdapter: join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'hermes', 'plugins', 'agent-relay', 'adapter.py'),
    repoAdapter: join(REPO_ROOT, 'adapters', 'hermes', 'deployed-adapter.py'),
  }
}

export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    const name = key.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[name] = true
    else {
      out[name] = next
      i++
    }
  }
  return out
}

function readIf(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  } catch {
    return null
  }
}

function bytes(path) {
  try {
    return statSync(path).size
  } catch {
    return -1
  }
}

const ago = (epoch) => (epoch == null ? 'never' : `${Math.max(0, Math.round(Date.now() / 1000 - epoch))}s ago`)

/** @returns {Promise<{status: 'ok'|'warn'|'fail', checks: Array<{name, status, detail}>}>} */
export async function runDoctor(options = {}) {
  // Only explicit values override; an absent flag must not blank a default.
  const overrides = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined && value !== true))
  const paths = { ...defaultPaths(), ...overrides }
  const checks = []
  const add = (name, status, detail) => checks.push({ name, status, detail })

  // 1. broker liveness + shape
  let health = null
  try {
    const res = await fetch(`${paths.broker}/healthz`, { signal: AbortSignal.timeout(4000) })
    health = await res.json()
    add('broker', 'ok', `${paths.broker} · ${health.broker} v${health.version} · 协议 v${health.protocol_version} · ${health.storage}`)
  } catch (err) {
    add('broker', 'fail', `${paths.broker} 不可达：${err.message}`)
  }

  // 2. members: who is actually able to receive
  if (health) {
    // `presence` needs a 0.6-era broker; older ones only expose last_pull_at.
    const rawPresence = health.presence ?? {}
    const legacyPulls = health.last_pull_at ?? {}
    const now = Math.floor(Date.now() / 1000)
    const presence = {}
    for (const name of new Set([...Object.keys(rawPresence), ...Object.keys(legacyPulls)])) {
      const seen = rawPresence[name]?.last_pull_at ?? legacyPulls[name] ?? null
      presence[name] = { last_pull_at: seen, online: seen != null && now - seen <= 90 }
    }
    const awake = []
    const deaf = []
    for (const name of health.agents ?? []) {
      (presence[name]?.online ? awake : deaf).push(`${name}(${ago(presence[name]?.last_pull_at)})`)
    }
    const held = health.long_poll?.held ?? 0
    if (!deaf.length) add('members', 'ok', `在线 ${awake.join(', ') || '无'}｜挂起长轮询 ${held}`)
    else add('members', awake.length ? 'warn' : 'fail', `在线：${awake.join(', ') || '无'}｜听不到：${deaf.join(', ')}`)

    // 3. queue backlog and failures
    const queues = health.queues ?? {}
    const pending = Object.entries(queues).filter(([, q]) => q.queued > 0 || q.leased > 0)
    const broken = Object.entries(queues).filter(([, q]) => q.failed > 0 || q.expired > 0)
    if (pending.length) add('queues', 'warn', pending.map(([n, q]) => `${n} 待投${q.queued}/处理中${q.leased}`).join('｜'))
    else add('queues', 'ok', '无积压')
    if (broken.length) add('history', 'warn', broken.map(([n, q]) => `${n} 失败${q.failed}/过期${q.expired}`).join('｜'))

    // 4. can a deaf member still be reached?
    const yamlText = readIf(paths.config)
    let yamlAgents = null
    if (yamlText == null) {
      add('config', 'fail', `broker 配置不存在：${paths.config}`)
    } else {
      yamlAgents = parseYamlAgents(yamlText)
      // Which members can be started on demand? Scan each agent block for a
      // `wake_command:` line — text-level because that is how the config lives.
      const withWake = []
      let current = null
      for (const line of yamlText.split(/\r?\n/)) {
        const entry = line.match(/^  ([A-Za-z0-9_-]+):\s*$/)
        if (entry) {
          current = entry[1]
          continue
        }
        if (/^[A-Za-z_][\w-]*:/.test(line)) current = null
        if (current && /^\s+wake_command:\s*\S/.test(line) && !withWake.includes(current)) withWake.push(current)
      }
      const unreachable = (health.agents ?? []).filter((name) => !presence[name]?.online && !withWake.includes(name))
      if (!withWake.length) {
        add('on-demand', 'warn', `没有成员配置 wake_command：不在线的成员收不到消息（见 docs/AGENT-DEPLOY.md）`)
      } else if (unreachable.length) {
        add('on-demand', 'warn', `可被唤醒：${withWake.join(', ')}｜仍无法投递：${unreachable.join(', ')}`)
      } else {
        add('on-demand', 'ok', `不在线成员均可按需唤醒：${withWake.join(', ')}`)
      }

      // 5. the two-file secret duplication must not have drifted
      const envText = readIf(paths.envFile)
      if (envText == null) {
        add('secrets', 'warn', `找不到成员凭据文件 ${paths.envFile}，无法校验漂移`)
      } else {
        const { ok, drift, onlyYaml, onlyEnv } = compareSecrets(yamlAgents.agents, parseEnvSecrets(envText))
        if (!drift.length && !onlyYaml.length && !onlyEnv.length) add('secrets', 'ok', `${ok} 个成员两处一致`)
        else add('secrets', 'fail', `漂移 ${drift.join(',') || '无'}｜仅在 broker ${onlyYaml.join(',') || '无'}｜仅在 .env ${onlyEnv.join(',') || '无'}（修：node setup/sync-secrets.mjs --apply）`)
      }
    }

    // 6. plaintext credentials outside the DPAPI vault (this machine's red line)
    const agentConfig = readIf(paths.agentConfig)
    if (agentConfig && /":\s*"[0-9a-fA-F]{32,}"/.test(agentConfig)) {
      add('plaintext', 'fail', `${paths.agentConfig} 内含疑似明文密钥，应改为 secret_ref（本机红线）`)
    } else if (agentConfig) {
      add('plaintext', 'ok', `${paths.agentConfig} 不含疑似明文密钥`)
    }
  }

  // 7. storage shape (WAL bloat was a real incident)
  const db = bytes(join(paths.dataDir, 'relay-v2.db'))
  const wal = bytes(join(paths.dataDir, 'relay-v2.db-wal'))
  if (db < 0) {
    add('storage', 'warn', `找不到 ${join(paths.dataDir, 'relay-v2.db')}`)
  } else if (wal > Math.max(1024 * 1024, db * 4)) {
    add('storage', 'warn', `relay-v2.db ${(db / 1024).toFixed(0)}KB 但 WAL ${(wal / 1024).toFixed(0)}KB 未合并`)
  } else {
    add('storage', 'ok', `relay-v2.db ${(db / 1024).toFixed(0)}KB · WAL ${(Math.max(0, wal) / 1024).toFixed(0)}KB`)
  }

  // 8. the deployed Hermes adapter must match its tracked copy
  const deployed = readIf(paths.deployedAdapter)
  const tracked = readIf(paths.repoAdapter)
  if (deployed == null) add('adapter', 'warn', `部署副本不存在：${paths.deployedAdapter}`)
  else if (tracked == null) add('adapter', 'warn', '仓库内没有 adapters/hermes/deployed-adapter.py 基线，无法比对')
  else add('adapter', deployed === tracked ? 'ok' : 'fail', deployed === tracked ? 'Hermes adapter 与仓库基线一致' : `Hermes adapter 与仓库基线不一致（线上 ${deployed.split(/\r?\n/).length} 行 / 基线 ${tracked.split(/\r?\n/).length} 行）`)

  const worst = checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok'
  return { status: worst, checks }
}

export function formatReport({ checks }, { quiet = false } = {}) {
  const glyph = { ok: '✓', warn: '!', fail: '✗' }
  const lines = checks.filter((c) => !quiet || c.status !== 'ok').map((c) => `${glyph[c.status]} ${c.name.padEnd(10)} ${c.detail}`)
  return lines.join('\n')
}

if (process.argv[1] && import.meta.url === `file:///${resolve(process.argv[1]).replace(/\\/g, '/')}`) {
  const flags = parseArgs(process.argv.slice(2))
  const report = await runDoctor({
    broker: flags.broker,
    config: flags.config,
    envFile: flags['env-file'],
    dataDir: flags['data-dir'],
  })
  if (flags.json) console.log(JSON.stringify(report, null, 2))
  else console.log(formatReport(report, { quiet: Boolean(flags.quiet) }))
  process.exitCode = report.status === 'fail' ? 1 : report.status === 'warn' ? 2 : 0
}
