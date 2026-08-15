/**
 * Cross-agent workspace write lease (mirrors the self-use relay/lease.py).
 *
 * Prevents two agents (e.g. Codex and Claude) from writing to the same
 * directory at the same time. A single file lock per canonical workspace path,
 * with PID-liveness recovery so a crashed owner's lock is broken.
 *
 * Windows note: deleting a file another process has open is not allowed, so the
 * owner writes only its metadata once and only unlinks while it still owns the
 * lock. `heartbeat()` updates the mtime; a stale lock from a dead process is
 * broken by the PID check.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  openSync, closeSync, writeSync, unlinkSync, readFileSync, mkdirSync,
  utimesSync, statSync,
} from 'node:fs'
import { resolve, join } from 'node:path'

const DEFAULT_STALE_SECONDS = 15 * 60

/** Canonical absolute path of a workspace. */
export function canonicalWorkspace(path) {
  return resolve(String(path))
}

/** Stable 24-hex key for a workspace path (case-insensitive, /-normalized). */
export function workspaceKey(workspace) {
  const normalized = canonicalWorkspace(workspace).replace(/\\/g, '/').toLowerCase()
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 24)
}

/** True if a PID is alive. On Windows EPERM means the process exists. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

export class WorkspaceLease {
  constructor(path, ownerId, workspace, taskId) {
    this.path = path
    this.ownerId = ownerId
    this.workspace = workspace
    this.taskId = taskId
  }

  /**
   * Try to acquire the lease for `workspace`.
   * @returns {{ lease: WorkspaceLease|null, owner: object|null }}
   */
  static tryAcquire(lockRoot, workspace, taskId, { staleSeconds = DEFAULT_STALE_SECONDS } = {}) {
    const root = resolve(lockRoot)
    mkdirSync(root, { recursive: true })
    const resolved = canonicalWorkspace(workspace)
    const path = join(root, `${workspaceKey(resolved)}.lock`)
    const ownerId = randomUUID().replace(/-/g, '')
    const payload = JSON.stringify({
      owner_id: ownerId,
      pid: process.pid,
      task_id: taskId,
      workspace: resolved,
      acquired_at: Date.now() / 1000,
    })
    try {
      const fd = openSync(path, 'wx')
      try { writeSync(fd, payload) } finally { closeSync(fd) }
      return { lease: new WorkspaceLease(path, ownerId, resolved, taskId), owner: null }
    } catch (err) {
      if (err.code !== 'EEXIST') return { lease: null, owner: null }
      const existing = readPayload(path)
      const ownerPid = Number(existing.pid) || 0
      let age = 0
      try { age = Date.now() / 1000 - statSync(path).mtimeMs / 1000 } catch { /* ignore */ }
      if (ownerPid && !pidAlive(ownerPid)) {
        try { unlinkSync(path) } catch { return { lease: null, owner: existing } }
        return WorkspaceLease.tryAcquire(root, resolved, taskId, { staleSeconds })
      }
      if (!ownerPid && age > staleSeconds) {
        try { unlinkSync(path) } catch { return { lease: null, owner: existing } }
        return WorkspaceLease.tryAcquire(root, resolved, taskId, { staleSeconds })
      }
      return { lease: null, owner: existing }
    }
  }

  /** Refresh the lock mtime (keeps a long task from being seen as stale). */
  heartbeat() {
    try {
      const payload = readPayload(this.path)
      if (payload.owner_id !== this.ownerId) return
      const now = new Date()
      utimesSync(this.path, now, now)
    } catch { /* ignore */ }
  }

  /** Release the lease (only if we still own it). */
  release() {
    try {
      const payload = readPayload(this.path)
      if (payload.owner_id !== this.ownerId) return
      unlinkSync(this.path)
    } catch { /* ignore */ }
  }
}

function readPayload(path) {
  try {
    const payload = JSON.parse(readFileSync(path, 'utf8'))
    return payload && typeof payload === 'object' ? payload : {}
  } catch {
    return {}
  }
}
