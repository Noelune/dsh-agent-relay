/**
 * Minimal YAML-subset configuration loader.
 *
 * Supports the subset used by this project's config files: nested mappings,
 * `key: value` scalars, inline arrays, `#` comments and quoted strings.
 * Everything else is rejected loudly — a typo must never silently become a
 * different setting.
 */
import { readFileSync, existsSync } from 'node:fs'

export const MAX_LEASE_SECONDS = 86_400

/**
 * @param {string} path - path to a YAML-subset file.
 * @returns {Record<string, unknown>} parsed configuration.
 */
export function loadConfig(path) {
  if (!existsSync(path)) throw new Error(`config file not found: ${path}`)
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  const root = {}
  const stack = [{ indent: -1, value: root }]
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.replace(/#.*$/, '').trimEnd()
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const m = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line.trim())
    if (!m) throw new Error(`config parse error at line ${i + 1}: expected "key: value"`)
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop()
    if (indent > 0 && stack.length === 1) {
      throw new Error(`config parse error at line ${i + 1}: nested key without section`)
    }
    const parent = stack.at(-1).value
    const [, key, rawValue] = m
    if (rawValue.trim() === '') {
      const child = {}
      parent[key] = child
      stack.push({ indent, value: child })
    } else {
      parent[key] = parseScalar(rawValue)
    }
  }
  return root
}

function parseScalar(raw) {
  const value = raw.trim()
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+$/.test(value)) return Number(value)
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
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
    rateLimitLoopback: Number(b.rateLimitLoopback ?? 600),
    rateLimitRemote: Number(b.rateLimitRemote ?? 120),
    messageTtlDays: Number(b.messageTtlDays ?? 7),
    persist: booleanConfig(b.persist, true, 'broker.persist'),
    storage: String(b.storage ?? 'sqlite').toLowerCase(),
    dataDir: String(b.dataDir ?? './data'),
    lockAfterFailures: Number(s.lockAfterFailures ?? 5),
    lockMinutes: Number(s.lockMinutes ?? 5),
    leaseSeconds: Number(b.leaseSeconds ?? 600),
    maxAttempts: Number(b.maxAttempts ?? 3),
    notifyFailedToSender: booleanConfig(b.notifyFailedToSender, true, 'broker.notifyFailedToSender'),
    agents: normalizeAgents(loaded.agents),
  }
  if (b.tls !== undefined) {
    throw new Error('broker.tls is not supported — terminate TLS at a trusted reverse proxy')
  }
  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
    throw new Error(`invalid broker.port: ${config.port}`)
  }
  validateInteger(config.messageTtlDays, 0, 'broker.messageTtlDays')
  validateInteger(config.leaseSeconds, 1, 'broker.leaseSeconds', MAX_LEASE_SECONDS)
  validateInteger(config.maxAttempts, 0, 'broker.maxAttempts')
  validateInteger(config.rateLimitLoopback, 1, 'broker.rateLimitLoopback')
  validateInteger(config.rateLimitRemote, 1, 'broker.rateLimitRemote')
  validateInteger(config.lockAfterFailures, 1, 'security.lockAfterFailures')
  validateInteger(config.lockMinutes, 1, 'security.lockMinutes')
  if (!['sqlite', 'jsonl'].includes(config.storage)) throw new Error(`invalid broker.storage: ${config.storage}`)
  return config
}

function booleanConfig(value, fallback, name) {
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  throw new Error(`invalid ${name}: expected true or false`)
}

function validateInteger(value, minimum, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`invalid ${name}: ${value}`)
}

/**
 * Per-agent routing ACL. An agent with `allowed_targets` may only send to
 * those targets; an agent WITHOUT an entry (or with `allowed_targets: null`)
 * may send to anyone (v1.0 default, backward compatible).
 *
 * v2 per-mode ACL (self-use compatible):
 *   allowed_read_targets      — read  mode whitelist (defaults to allowed_targets)
 *   allowed_continue_targets  — continue mode whitelist (defaults to allowed_targets)
 *   allowed_write_targets     — write mode whitelist (default EMPTY = write closed)
 */
function normalizeAgents(loaded) {
  const out = {}
  for (const [name, cfg] of Object.entries(loaded ?? {})) {
    const targets = cfg?.allowed_targets
    if (targets !== undefined && targets !== null && !Array.isArray(targets)) {
      throw new Error(`invalid agents.${name}.allowed_targets: expected an inline array`)
    }
    const read = cfg?.allowed_read_targets
    const cont = cfg?.allowed_continue_targets
    const write = cfg?.allowed_write_targets
    for (const [field, value] of [['allowed_read_targets', read], ['allowed_continue_targets', cont], ['allowed_write_targets', write]]) {
      if (value !== undefined && value !== null && !Array.isArray(value)) {
        throw new Error(`invalid agents.${name}.${field}: expected an inline array`)
      }
    }
    const secret = cfg?.secret === undefined ? null : String(cfg.secret)
    if (secret !== null && !secret) throw new Error(`invalid agents.${name}.secret: must not be empty`)
    // Targets are normalized to lowercase — v2 lowercases agent names and
    // targets on the wire, so config lists must match (self-use _string_list
    // also lowercases).
    const lowerList = (items) => (Array.isArray(items) ? items.map((item) => String(item).trim().toLowerCase()) : null)
    const legacy = lowerList(targets)
    out[name] = {
      secret,
      allowedTargets: legacy,
      allowedReadTargets: Array.isArray(read) ? lowerList(read) : legacy,
      allowedContinueTargets: Array.isArray(cont) ? lowerList(cont) : legacy,
      allowedWriteTargets: Array.isArray(write) ? lowerList(write) : [],
    }
  }
  const isolated = Object.values(out).some((agent) => agent.secret !== null)
  if (isolated && Object.entries(out).some(([, agent]) => agent.secret === null)) {
    throw new Error('invalid agents: per-agent authentication requires a secret for every configured agent')
  }
  return out
}
