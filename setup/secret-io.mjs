/**
 * Shared parsers for the member-secret tooling (sync-secrets, add-member).
 * Understands the self-use broker YAML layout: top-level sections, two-space
 * agent entries under `agents:`, four-space properties with flow-style
 * `[a, b]` lists. Deliberately text-level: edits preserve formatting and
 * comments, and secret values never pass through a full YAML rewrite.
 */

function splitList(body) {
  const t = body.trim()
  return t ? t.split(',').map((s) => s.trim()).filter(Boolean) : []
}

/**
 * Parse the `agents:` section of the broker YAML.
 * Returns { lines, agents, sectionEnd } where `agents` maps name → record of
 * line indexes/prefixes (for in-place edits) and `sectionEnd` is the index at
 * which a new agent block should be inserted.
 */
export function parseYamlAgents(text) {
  const lines = text.split(/\r?\n/)
  const agents = new Map()
  let inAgents = false
  let current = null
  let sectionEnd = lines.length
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^agents:\s*$/.test(line)) {
      inAgents = true
      current = null
      sectionEnd = lines.length
      continue
    }
    if (!inAgents) continue
    if (/^[A-Za-z_][\w-]*:/.test(line)) {
      // next top-level section ends the agents block
      inAgents = false
      sectionEnd = i
      continue
    }
    const entry = line.match(/^  ([A-Za-z0-9_-]+):\s*$/)
    if (entry) {
      current = entry[1]
      agents.set(current, {
        secretLineIndex: -1, secretPrefix: '', secret: null,
        readLineIndex: -1, readPrefix: '', readTargets: [],
        writeLineIndex: -1, writePrefix: '', writeTargets: [],
      })
      sectionEnd = i + 1
      continue
    }
    if (!current) continue
    const rec = agents.get(current)
    const ms = line.match(/^(\s+secret:\s*)(\S.*?)\s*$/)
    if (ms) {
      rec.secretLineIndex = i; rec.secretPrefix = ms[1]; rec.secret = ms[2]
      sectionEnd = i + 1
      continue
    }
    const mr = line.match(/^(\s+allowed_read_targets:\s*)\[([^\]]*)\]\s*$/)
    if (mr) {
      rec.readLineIndex = i; rec.readPrefix = mr[1]; rec.readTargets = splitList(mr[2])
      sectionEnd = i + 1
      continue
    }
    const mw = line.match(/^(\s+allowed_write_targets:\s*)\[([^\]]*)\]\s*$/)
    if (mw) {
      rec.writeLineIndex = i; rec.writePrefix = mw[1]; rec.writeTargets = splitList(mw[2])
      sectionEnd = i + 1
      continue
    }
  }
  return { lines, agents, sectionEnd }
}

/** Parse AGENT_RELAY_<NAME>_SECRET entries from a dotenv file (name lowercased). */
export function parseEnvSecrets(text) {
  const out = new Map()
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*AGENT_RELAY_([A-Za-z0-9_]+)_SECRET\s*=\s*(.*?)\s*$/)
    if (!m) continue
    let value = m[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out.set(m[1].toLowerCase(), value)
  }
  return out
}

/** Env var name for a member (dashes become underscores, like `my-agent`). */
export function envVarName(agent) {
  return `AGENT_RELAY_${agent.toUpperCase().replace(/-/g, '_')}_SECRET`
}

/** Env map key for a member: exact name first, dash→underscore fallback. */
export function envKeyFor(name, envSecrets) {
  if (envSecrets.has(name)) return name
  const flat = name.replace(/-/g, '_')
  return envSecrets.has(flat) ? flat : name
}

/**
 * Compare YAML agent secrets against .env secrets.
 * Returns { ok, drift, onlyYaml, onlyEnv } — member names only, no values.
 */
export function compareSecrets(yamlAgents, envSecrets) {
  const names = [...new Set([...yamlAgents.keys(), ...envSecrets.keys()])].sort()
  const drift = []
  const onlyYaml = []
  const onlyEnv = []
  let ok = 0
  for (const name of names) {
    const inYaml = yamlAgents.get(name)
    const inEnv = envSecrets.get(envKeyFor(name, envSecrets))
    if (inYaml?.secret != null && inEnv !== undefined) {
      if (inYaml.secret === inEnv) ok++
      else drift.push(name)
    } else if (inYaml?.secret != null) {
      onlyYaml.push(name)
    } else if (inEnv !== undefined) {
      onlyEnv.push(name)
    }
  }
  return { ok, drift, onlyYaml, onlyEnv }
}
