import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareRelayWorkspace, relayWorkspaceNote } from '../lib/workspace.js'

function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), 'relay-ws-'))
  const repo = join(root, 'repo')
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t'])
  execFileSync('git', ['-C', repo, 'config', 'user.name', 't'])
  writeFileSync(join(repo, 'file.txt'), 'hello\n', 'utf8')
  execFileSync('git', ['-C', repo, 'add', '.'])
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'init'])
  return { root, repo }
}

test('non-git dir: read stays in place, write falls back to a lease', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-ws-nogit-'))
  try {
    const read = prepareRelayWorkspace({ baseWorkspace: root, worktreeParent: join(root, 'wt'), agentName: 'a', messageId: 'x'.repeat(32), executionMode: 'read' })
    assert.equal(read.isolated, false)
    assert.equal(read.readOnly, true)
    assert.equal(read.requiresWriteLease, false)
    const write = prepareRelayWorkspace({ baseWorkspace: root, worktreeParent: join(root, 'wt'), agentName: 'a', messageId: 'x'.repeat(32), executionMode: 'write' })
    assert.equal(write.isolated, false)
    assert.equal(write.requiresWriteLease, true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('clean git repo: write mode gets an isolated worktree', () => {
  const { root, repo } = gitRepo()
  const worktreeParent = join(root, 'wt')
  try {
    const plan = prepareRelayWorkspace({ baseWorkspace: repo, worktreeParent, agentName: 'codex', messageId: 'ab12cd34ef56', executionMode: 'write' })
    assert.equal(plan.isolated, true)
    assert.equal(plan.requiresWriteLease, false)
    assert.equal(plan.readOnly, false)
    assert.match(plan.branch, /^relay\/codex\/ab12cd34ef56$/)
    assert.ok(plan.worktreeRoot.startsWith(worktreeParent))
    // The worktree actually exists and is a git worktree.
    const inTree = execFileSync('git', ['-C', plan.worktreeRoot, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).trim()
    assert.equal(inTree, 'true')
    const note = relayWorkspaceNote(plan)
    assert.ok(note.includes('branch: relay/codex'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('dirty git repo: write mode falls back to a lease, read stays in place', () => {
  const { root, repo } = gitRepo()
  writeFileSync(join(repo, 'dirty.txt'), 'uncommitted\n', 'utf8') // dirty the tree
  try {
    const write = prepareRelayWorkspace({ baseWorkspace: repo, worktreeParent: join(root, 'wt'), agentName: 'a', messageId: 'f'.repeat(32), executionMode: 'write' })
    assert.equal(write.isolated, false)
    assert.equal(write.requiresWriteLease, true)
    const read = prepareRelayWorkspace({ baseWorkspace: repo, worktreeParent: join(root, 'wt'), agentName: 'a', messageId: 'f'.repeat(32), executionMode: 'read' })
    assert.equal(read.isolated, false)
    assert.equal(read.readOnly, true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
