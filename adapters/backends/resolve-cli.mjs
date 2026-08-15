/**
 * Resolve a CLI command to something Node can spawn directly (no shell).
 *
 * Handles three shapes:
 *   1. A plain executable on PATH → spawn it directly.
 *   2. An npm `.cmd` shim that runs `node "<dp0>\node_modules\...\bin\script.js"`
 *      → spawn `node <script>` (no shell, no quoting issues).
 *   3. A PowerShell wrapper `.cmd` that runs `pwsh -File "<dp0>\wrapper.ps1"`
 *      → spawn `pwsh -NoLogo -ExecutionPolicy Bypass -File <wrapper.ps1>`.
 *
 * Returns `{ file, args }`; call `spawn(file, [...args, ...userArgs], opts)`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function resolveCli(cmdName) {
  if (process.platform !== 'win32') return { file: cmdName, args: [] }
  const base = cmdName.endsWith('.cmd') ? cmdName : `${cmdName}.cmd`
  for (const dir of (process.env.PATH || '').split(';')) {
    if (!dir) continue
    const full = join(dir, base)
    if (!existsSync(full)) continue
    // `%dp0%` / `%~dp0` expand to the .cmd's directory WITH a trailing backslash.
    const dp0 = /[\\/]$/.test(dir) ? dir : `${dir}\\`
    const expand = (s) => s.replace(/%dp0%/gi, dp0).replace(/%~dp0/gi, dp0).replace(/\\\\/g, '\\')
    let content = ''
    try { content = readFileSync(full, 'utf8') } catch { /* fall through */ }
    // npm shim: node "%dp0%\node_modules\...\bin\script.js"
    const nodeScript = content.match(/"([^"]*node_modules[^"]*\.js)"/)
    if (nodeScript) {
      return { file: process.execPath, args: [expand(nodeScript[1])] }
    }
    // PowerShell wrapper: pwsh -NoLogo ... -File "%dp0%\wrapper.ps1" / "%~dp0..."
    const psWrapper = content.match(/"([^"]*\.ps1)"/i)
    if (psWrapper) {
      return { file: 'pwsh.exe', args: ['-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', expand(psWrapper[1])] }
    }
    // Last resort: the .cmd itself (needs a shell; used only when nothing else matched).
    return { file: full, args: [], shell: true }
  }
  return { file: cmdName, args: [] }
}
