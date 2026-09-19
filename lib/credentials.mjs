/**
 * Shared credential resolution for the non-plugin entrypoints (relay-agent,
 * relay-mcp, CLI) — the same precedence the DSH plugin already uses, so joining
 * the circle never requires writing a secret into a new plaintext location:
 *
 *   inline `secret`  →  `secret_env` named variable  →  `secret_env_file` (an
 *   existing dotenv file, read at runtime)  →  `secret_ref` looked up in a vault
 *   module (`vault_module` python file exposing `reveal_entry(name)`).
 *
 * The vault path mirrors `lib/index.js` (VAULT_REVEAL_SCRIPT) deliberately: one
 * mechanism, not a second one to drift. Resolved values are never logged.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const VAULT_REVEAL_SCRIPT = "import importlib.util,sys;p=sys.argv[1];s=importlib.util.spec_from_file_location('dsh_agent_relay_vault',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);_,v=m.reveal_entry(sys.argv[2]);sys.stdout.write(v)"

/**
 * Pull one `AGENT_RELAY_<NAME>_SECRET` out of a dotenv file the deployment
 * already has (e.g. the Feishu bot's `.env`).
 *
 * The point is to avoid a second copy: a host config can name the file instead
 * of embedding the credential, so the single source stays single. Mirrors
 * `setup/secret-io.mjs`'s `parseEnvSecrets`; kept local because `lib/` is the
 * dependency-free publishable half and must not import from `setup/`.
 */
export function readEnvFileSecret(path, agent) {
  if (!path || !agent) return ''
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return ''
  }
  const flat = String(agent).trim().toUpperCase().replace(/-/g, '_')
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*AGENT_RELAY_([A-Za-z0-9_]+)_SECRET\s*=\s*(.*?)\s*$/)
    if (!m || m[1].toUpperCase() !== flat) continue
    let value = m[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    return value.trim()
  }
  return ''
}

/**
 * @param {object} source merged config/env view; recognised keys:
 *   `secret`, `secretEnv`/`secret_env`, `secretEnvFile`/`secret_env_file`,
 *   `secretRef`/`secret_ref`, `vaultModule`/`vault_module`, `python`, `agent`
 * @param {{env?: object, timeoutMs?: number}} [opts]
 * @returns {Promise<string>} the secret, or '' when nothing resolved
 */
export async function resolveSecret(source = {}, { env = process.env, timeoutMs = 5000 } = {}) {
  const inline = source.secret ?? ''
  if (typeof inline === 'string' && inline.trim()) return inline.trim()

  const envName = source.secretEnv || source.secret_env || ''
  if (envName && env[envName]) return String(env[envName]).trim()

  const envFile = source.secretEnvFile || source.secret_env_file || ''
  if (envFile) {
    const fromFile = readEnvFileSecret(envFile, source.agent)
    if (fromFile) return fromFile
  }

  const ref = source.secretRef || source.secret_ref || ''
  const vault = source.vaultModule || source.vault_module || ''
  if (!ref || !vault || !existsSync(vault)) return ''

  const python = source.python || env.AGENT_RELAY_PYTHON || 'python'
  return new Promise((resolvePromise) => {
    execFile(python, ['-c', VAULT_REVEAL_SCRIPT, vault, ref], { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 8192 }, (err, stdout) => {
      // Surface *that* it failed, never what the value was.
      if (err) {
        resolvePromise('')
        return
      }
      resolvePromise(String(stdout ?? '').trim())
    })
  })
}

/** Human-readable explanation of where the secret came from (never a value). */
export function describeSecretSource(source = {}, env = process.env) {
  if (source.secret) return 'inline secret (prefer secret_env_file or secret_ref)'
  const envName = source.secretEnv || source.secret_env || ''
  if (envName && env[envName]) return `env ${envName}`
  const envFile = source.secretEnvFile || source.secret_env_file || ''
  if (envFile && readEnvFileSecret(envFile, source.agent)) return `dotenv ${envFile}`
  const ref = source.secretRef || source.secret_ref || ''
  const vault = source.vaultModule || source.vault_module || ''
  if (ref && vault) return `vault entry ${ref}`
  return 'unresolved'
}
