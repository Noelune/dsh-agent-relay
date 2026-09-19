/**
 * One config resolution for every command-line entrypoint (CLI, MCP server,
 * inbox worker).
 *
 * Each of them used to carry its own copy of the same three rules — which file
 * to read, whether the key is spelled `secret_ref` or `secretRef`, and in what
 * order flags/env/file win. Copies drift, and these ones had already drifted:
 * the CLI ignored the deployment config that every other member reads, so a
 * script had to repeat `--broker/--agent/--secret-env-file` on every call.
 *
 * Layers, lowest first: the deployment's own runtime config
 * (`~/.dsh/agent-relay.json`, which names a vault entry rather than holding a
 * credential), a personal override (`~/.dsh-relay.json`), environment
 * (`AGENT_RELAY_*` and the older `DSH_RELAY_*`), then flags. Values are never
 * logged; see `describeSecretSource()` in credentials.mjs for a safe summary.
 *
 * The DSH plugin (`lib/index.js`) keeps its own resolver on purpose: its inputs
 * are a host-supplied settings object, not argv flags, and bending one shape
 * into the other would cost more than the duplication does.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEPLOYMENT_CONFIG = join(homedir(), '.dsh', 'agent-relay.json')
export const PERSONAL_CONFIG = join(homedir(), '.dsh-relay.json')
export const DEFAULT_ENDPOINT = 'http://127.0.0.1:19121'

/** Read and merge the config files; a malformed file is treated as absent. */
export function loadFileConfig(files = [DEPLOYMENT_CONFIG, PERSONAL_CONFIG]) {
  let merged = {}
  for (const file of files) {
    try {
      if (existsSync(file)) merged = { ...merged, ...JSON.parse(readFileSync(file, 'utf8')) }
    } catch { /* ignore malformed file */ }
  }
  return merged
}

/**
 * @param {object} [input]
 * @param {object} [input.flags] - parsed argv flags, names without `--`
 * @param {object} [input.env]
 * @param {object} [input.file] - merged config-file view
 * @returns {object} the shared identity + credential settings
 */
export function relaySettings({ flags = {}, env = process.env, file = loadFileConfig() } = {}) {
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const pick = (flagName, envSuffix, ...fileKeys) => {
    const fromFlag = text(flags[flagName])
    if (fromFlag) return fromFlag
    for (const prefix of ['AGENT_RELAY_', 'DSH_RELAY_']) {
      const fromEnv = text(env[prefix + envSuffix])
      if (fromEnv) return fromEnv
    }
    for (const key of fileKeys) {
      const fromFile = text(file[key])
      if (fromFile) return fromFile
    }
    return ''
  }
  return {
    agent: pick('agent', 'AGENT', 'agent').toLowerCase(),
    endpoint: pick('broker', 'BROKER_URL', 'endpoint', 'brokerUrl') || DEFAULT_ENDPOINT,
    secret: pick('secret', 'SECRET', 'secret'),
    secretEnv: pick('secret-env', 'SECRET_ENV', 'secret_env', 'secretEnv'),
    secretEnvFile: pick('secret-env-file', 'SECRET_ENV_FILE', 'secret_env_file', 'secretEnvFile'),
    secretRef: pick('secret-ref', 'SECRET_REF', 'secret_ref', 'secretRef'),
    vaultModule: pick('vault-module', 'VAULT_MODULE', 'vault_module', 'vaultModule'),
    keyId: pick('key-id', 'KEY_ID', 'key_id', 'keyId'),
    python: pick('python', 'PYTHON', 'python'),
  }
}
