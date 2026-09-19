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
    messageTtlDays: Number(b.messageTtlDays ?? 7),
    persist: booleanConfig(b.persist, true, 'broker.persist'),
    // Only one storage engine since 2026-09-19; `storage` is accepted so an old
    // config keeps loading, and anything but sqlite is a loud error rather than a
    // silent fallback to a second persistence code path.
    storage: String(b.storage ?? 'sqlite').toLowerCase(),
    dataDir: String(b.dataDir ?? './data'),
    leaseSeconds: Number(b.leaseSeconds ?? 600),
    maxAttempts: Number(b.maxAttempts ?? 3),
    notifyFailedToSender: booleanConfig(b.notifyFailedToSender, true, 'broker.notifyFailedToSender'),
    adminAgents: new Set(s.admin_agents === undefined ? [] : (Array.isArray(s.admin_agents) ? s.admin_agents : []).map((item) => String(item).trim().toLowerCase()).filter(Boolean)),
    agents: normalizeAgents(loaded.agents, secret),
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
  // `broker.rateLimit*` and `security.lock*` are deliberately not implemented:
  // they were v1 (`auth.js`) features, and the v1 generation is gone. An old
  // config file keeps loading with those keys ignored — the alternative was a
  // SECURITY.md that credits a lockout which never ran.
  if (config.storage !== 'sqlite') {
    throw new Error(`invalid broker.storage: ${config.storage} — only sqlite is supported since 0.7.0 (the jsonl fallback was removed)`)
  }
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
 * Per-agent signing keys (v3 protocol). Each agent has a keyring:
 * `{ keyId: { secret, notAfter } }`. The default ring maps the id `legacy` to
 * the agent's single secret (or the shared broker secret), which is exactly
 * what v2 clients sign with — so one config serves both protocol generations.
 */
function normalizeAgents(loaded, sharedSecret) {
  const out = {}
  const ownAuth = new Map() // name -> carries its own signing credential
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
    let keys = null
    let hasOwnKeys = false
    if (cfg?.keys !== undefined && cfg?.keys !== null) {
      hasOwnKeys = true
      if (typeof cfg.keys !== 'object' || Array.isArray(cfg.keys)) {
        throw new Error(`invalid agents.${name}.keys: expected a mapping of key id to {secret, not_after?}`)
      }
      keys = {}
      for (const [keyId, keyCfg] of Object.entries(cfg.keys)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(keyId)) throw new Error(`invalid agents.${name}.keys.${keyId}.key_id`)
        const keySecret = String(keyCfg?.secret ?? '')
        if (!keySecret) throw new Error(`invalid agents.${name}.keys.${keyId}.secret: must not be empty`)
        let notAfter = null
        if (keyCfg?.not_after !== undefined && keyCfg?.not_after !== null) {
          notAfter = Number(keyCfg.not_after)
          if (!Number.isFinite(notAfter) || notAfter <= 0) throw new Error(`invalid agents.${name}.keys.${keyId}.not_after: must be a unix timestamp`)
        }
        keys[keyId] = { secret: keySecret, notAfter }
      }
      if (!Object.keys(keys).length) throw new Error(`invalid agents.${name}.keys: must not be empty`)
    }
    // Targeted push delivery: when a message lands for an agent that nobody is
    // polling, the broker runs this command once (headless worker shape). This
    // is what removes the "the recipient must be running a poller" precondition.
    let wakeCommand = null
    if (cfg?.wake_command !== undefined && cfg?.wake_command !== null) {
      wakeCommand = String(cfg.wake_command).trim()
      if (!wakeCommand) throw new Error(`invalid agents.${name}.wake_command: must not be empty`)
      if (wakeCommand.length > 2000) throw new Error(`invalid agents.${name}.wake_command: too long`)
    }
    // Targets are normalized to lowercase — v2 lowercases agent names and
    // targets on the wire, so config lists must match (self-use _string_list
    // also lowercases).
    const lowerList = (items) => (Array.isArray(items) ? items.map((item) => String(item).trim().toLowerCase()) : null)
    const legacy = lowerList(targets)
    out[name] = {
      secret,
      keys: keys ?? { legacy: { secret: secret ?? sharedSecret, notAfter: null } },
      allowedTargets: legacy,
      allowedReadTargets: Array.isArray(read) ? lowerList(read) : legacy,
      allowedContinueTargets: Array.isArray(cont) ? lowerList(cont) : legacy,
      allowedWriteTargets: Array.isArray(write) ? lowerList(write) : [],
      wakeCommand,
    }
    ownAuth.set(name, secret !== null || hasOwnKeys)
  }
  const isolated = [...ownAuth.values()].some(Boolean)
  if (isolated && [...ownAuth.values()].some((has) => !has)) {
    throw new Error('invalid agents: per-agent authentication requires a secret for every configured agent')
  }
  return out
}
