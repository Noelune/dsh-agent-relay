/**
 * Managed broker lifecycle: spawn the bundled broker when it is unreachable
 * and stop it again with the plugin (no orphan process, no OS-level service).
 *
 * Extracted from lib/index.js (2026-08-29 stabilization split).
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export function createBrokerLifecycle({ cfg, diag, getClient }) {
  let managedBroker = null // spawned child process (only when the plugin started it)

  function brokerIndexPath() {
    return join(HERE, '..', 'broker', 'src', 'index.js')
  }

  /** Spawn the bundled broker process (only called when it is not reachable). */
  function spawnBroker() {
    try {
      if (!existsSync(brokerIndexPath())) {
        diag('broker not bundled (no broker/src/index.js) — skipping manage-broker')
        return null
      }
      if (!existsSync(cfg.brokerConfigPath)) {
        diag('broker config not found: ' + cfg.brokerConfigPath + ' — skipping manage-broker')
        return null
      }
      const child = spawn(process.execPath, [brokerIndexPath(), '--config', cfg.brokerConfigPath], {
        stdio: 'ignore',
        windowsHide: true,
      })
      managedBroker = child
      child.on('exit', (code) => {
        if (managedBroker === child) managedBroker = null
        diag('managed broker exited (' + code + ')')
      })
      diag('spawned managed broker: ' + brokerIndexPath() + ' --config ' + cfg.brokerConfigPath)
      return child
    } catch (e) {
      diag('spawnBroker failed: ' + e.message)
      return null
    }
  }

  /** Ensure the broker is reachable; spawn it (managed) when it is not. */
  async function ensureBroker() {
    const client = getClient()
    if (!client || !cfg.manageBroker) return
    // Already reachable? Nothing to do.
    try {
      await client.health()
      return
    } catch { /* not reachable — spawn below */ }
    spawnBroker()
    // Wait for it to become healthy (up to ~15 s) so the inbox worker starts clean.
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      try {
        await client.health()
        diag('managed broker became reachable')
        return
      } catch { /* keep waiting */ }
      await new Promise((r) => setTimeout(r, 500))
    }
    diag('managed broker did not become reachable within 15s — inbox worker will retry')
  }

  function dispose() {
    // If this plugin spawned the broker, stop it with dsh (no orphan process).
    if (managedBroker) {
      try { managedBroker.kill() } catch { /* ignore */ }
      managedBroker = null
    }
  }

  return { ensureBroker, dispose }
}
