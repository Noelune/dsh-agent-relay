/**
 * Shared credential resolution for the non-plugin entrypoints (relay-agent,
 * relay-mcp, CLI) — the same precedence the DSH plugin already uses, so joining
 * the circle never requires putting a secret in a file:
 *
 *   inline `secret`  →  `secret_env` named variable  →  `secret_ref` looked up
 *   in a vault module (`vault_module` python file exposing `reveal_entry(name)`).
 *
 * The vault path mirrors `lib/index.js` (VAULT_REVEAL_SCRIPT) deliberately: one
 * mechanism, not a second one to drift. Resolved values are never logged.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

const VAULT_REVEAL_SCRIPT = "import importlib.util,sys;p=sys.argv[1];s=importlib.util.spec_from_file_location('dsh_agent_relay_vault',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);_,v=m.reveal_entry(sys.argv[2]);sys.stdout.write(v)"

/**
 * @param {object} source merged config/env view; recognised keys:
 *   `secret`, `secretEnv`/`secret_env`, `secretRef`/`secret_ref`,
 *   `vaultModule`/`vault_module`, `python`
 * @param {{env?: object, timeoutMs?: number}} [opts]
 * @returns {Promise<string>} the secret, or '' when nothing resolved
 */
export async function resolveSecret(source = {}, { env = process.env, timeoutMs = 5000 } = {}) {
  const inline = source.secret ?? source.secret ?? ''
  if (typeof inline === 'string' && inline.trim()) return inline.trim()

  const envName = source.secretEnv || source.secret_env || ''
  if (envName && env[envName]) return String(env[envName]).trim()

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

/** Human-readable explanation of where the secret came from (no values). */
export function describeSecretSource(source = {}, env = process.env) {
  if (source.secret) return 'inline secret (consider secret_ref instead)'
  const envName = source.secretEnv || source.secret_env || ''
  if (envName && env[envName]) return `env ${envName}`
  const ref = source.secretRef || source.secret_ref || ''
  const vault = source.vaultModule || source.vault_module || ''
  if (ref && vault) return `vault entry ${ref}`
  return 'unresolved'
}
