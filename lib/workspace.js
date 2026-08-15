/**
 * Workspace policy for concurrent relay requests (mirrors the self-use
 * relay/workspace.py).
 *
 * For a write-mode request, isolate the recipient into a git worktree so the
 * primary workspace is never modified. When the base is not a clean git repo,
 * fall back to a cross-agent workspace write lease (the request still runs in
 * the primary workspace, serialized against other writers).
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'

function git(root, ...args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

/**
 * @param {object} opts
 * @param {string} opts.baseWorkspace - the agent's normal working directory
 * @param {string} opts.worktreeParent - parent dir for relay worktrees
 * @param {string} opts.agentName
 * @param {string} opts.messageId - the relay message id (used in the branch name)
 * @param {string} opts.executionMode - read | continue | write
 * @returns {{ workspace: string, isolated: boolean, readOnly: boolean, requiresWriteLease: boolean, branch: string, worktreeRoot: string }}
 */
export function prepareRelayWorkspace({ baseWorkspace, worktreeParent, agentName, messageId, executionMode }) {
  const base = resolve(baseWorkspace)
  const mode = String(executionMode || 'read').toLowerCase()
  const normalized = mode === 'continue' ? 'read' : mode
  if (!['read', 'write'].includes(normalized)) throw new Error('relay execution mode must be read or write')

  const repoRoot = git(base, 'rev-parse', '--show-toplevel')
  if (!repoRoot) {
    // Not a git repo: serialize write via the lease, read stays in place.
    return { workspace: base, isolated: false, readOnly: normalized === 'read', requiresWriteLease: normalized === 'write', branch: '', worktreeRoot: '' }
  }
  if (git(repoRoot, 'status', '--porcelain')) {
    // Dirty tree: cannot create a clean worktree — fall back to the lease.
    return { workspace: base, isolated: false, readOnly: normalized === 'read', requiresWriteLease: normalized === 'write', branch: '', worktreeRoot: '' }
  }

  const safeAgent = (agentName || 'agent').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'agent'
  const shortId = (messageId || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)
  if (!shortId) throw new Error('relay message id is invalid')
  const branch = `relay/${safeAgent}/${shortId}`
  const root = resolve(worktreeParent, safeAgent, shortId)

  const isWorktree = existsSync(root) && git(root, 'rev-parse', '--is-inside-work-tree') === 'true'
  if (!isWorktree) {
    if (existsSync(root)) throw new Error('relay worktree path already exists but is invalid')
    const branchExists = Boolean(git(repoRoot, 'branch', '--list', branch))
    const args = ['worktree', 'add']
    if (!branchExists) args.push('-b', branch)
    args.push(root, branchExists ? branch : 'HEAD')
    const created = git(repoRoot, ...args)
    if (!created && !existsSync(root)) throw new Error('could not create isolated relay worktree')
  }

  let rel = ''
  try { rel = relative(repoRoot, base) } catch { rel = '' }
  const workspace = rel ? join(root, rel) : root
  if (!existsSync(workspace)) throw new Error('isolated relay workspace is unavailable')
  return { workspace, isolated: true, readOnly: normalized === 'read', requiresWriteLease: false, branch, worktreeRoot: root }
}

/** Append an [Isolated relay workspace] note (branch + workspace + diff stat). */
export function relayWorkspaceNote(plan) {
  if (!plan.isolated || !plan.worktreeRoot) return ''
  const diff = git(plan.worktreeRoot, 'diff', '--stat')
  const lines = ['[Isolated relay workspace]', `branch: ${plan.branch}`, `workspace: ${plan.workspace}`]
  lines.push(diff ? `diff:\n${diff}` : 'diff: no uncommitted changes')
  return `\n\n${lines.join('\n')}`
}
