/**
 * Minimal YAML-subset configuration loader.
 *
 * Supports the subset used by this project's config files:
 * top-level keys, one level of nesting, `key: value` scalars, `#` comments,
 * quoted strings. Everything else is rejected loudly — a typo must never
 * silently become a different setting.
 */
import { readFileSync, existsSync } from 'node:fs'

/**
 * @param {string} path - path to a YAML-subset file.
 * @returns {Record<string, unknown>} parsed configuration.
 */
export function loadConfig(path) {
  if (!existsSync(path)) throw new Error(`config file not found: ${path}`)
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  const root = {}
  let section = null
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.replace(/#.*$/, '').trimEnd()
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (indent === 0) {
      const m = /^([A-Za-z0-9_-]+):\s*$/.exec(line.trim())
      if (!m) throw new Error(`config parse error at line ${i + 1}: expected section header, got "${line.trim()}"`)
      section = m[1]
      root[section] = root[section] ?? {}
    } else {
      if (!section) throw new Error(`config parse error at line ${i + 1}: nested key without section`)
      const m = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line.trim())
      if (!m) throw new Error(`config parse error at line ${i + 1}: expected "key: value"`)
      root[section][m[1]] = parseScalar(m[2])
    }
  }
  return root
}

function parseScalar(raw) {
  const value = raw.trim()
  if (value === '') return null
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+$/.test(value)) return Number(value)
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Merge loaded config over defaults; validates required fields.
 */
export function normalizeConfig(loaded) {
  const b = loaded.broker ?? {}
  const s = loaded.security ?? {}
  const secret = String(b.secret ?? '')
  if (!secret || secret === 'CHANGE_ME_RUN_SETUP_INIT') {
    throw new Error('broker.secret is not set — run "node setup/setup.js init" to generate a config.yaml')
  }
  const config = {
    host: String(b.host ?? '127.0.0.1'),
    port: Number(b.port ?? 19121),
    secret,
    tls: Boolean(b.tls ?? false),
    rateLimitLoopback: Number(b.rateLimitLoopback ?? 600),
    rateLimitRemote: Number(b.rateLimitRemote ?? 120),
    messageTtlDays: Number(b.messageTtlDays ?? 7),
    persist: Boolean(b.persist ?? true),
    dataDir: String(b.dataDir ?? './data'),
    lockAfterFailures: Number(s.lockAfterFailures ?? 5),
    lockMinutes: Number(s.lockMinutes ?? 5),
    leaseSeconds: Number(b.leaseSeconds ?? 600),
    maxAttempts: Number(b.maxAttempts ?? 3),
    agents: normalizeAgents(loaded.agents),
  }
  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
    throw new Error(`invalid broker.port: ${config.port}`)
  }
  return config
}

/**
 * Per-agent routing ACL. An agent with `allowed_targets` may only send to
 * those targets; an agent WITHOUT an entry (or with `allowed_targets: null`)
 * may send to anyone (v1.0 default, backward compatible).
 */
function normalizeAgents(loaded) {
  const out = {}
  for (const [name, cfg] of Object.entries(loaded ?? {})) {
    const targets = cfg?.allowed_targets
    out[name] = { allowedTargets: Array.isArray(targets) ? targets.map(String) : null }
  }
  return out
}
