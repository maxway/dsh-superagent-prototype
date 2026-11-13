import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/workspace-inventory.mjs', import.meta.url))

function command(directory, ...args) {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function scan(...args) {
  const processResult = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, GIT_DIR: 'incorrect', GIT_WORK_TREE: 'incorrect', GIT_INDEX_FILE: 'incorrect' } })
  return { status: processResult.status, output: JSON.parse(processResult.stdout) }
}

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'inventory test '))
  try {
    command(root, 'init', '-q')
    command(root, 'config', 'user.email', 'test@example.invalid')
    command(root, 'config', 'user.name', 'Test')
    command(root, 'commit', '--allow-empty', '-qm', 'test')
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function database(file, rows) {
  const db = new DatabaseSync(file)
  try {
    db.exec('CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const insert = db.prepare('INSERT INTO ticket VALUES (?, ?)')
    for (const [id, value] of rows) insert.run(id, typeof value === 'string' ? value : JSON.stringify(value))
  } finally { db.close() }
}

test('associates exact ticket ids, branch names, paths and preserves all resources', () => fixture(root => {
  const location = join(root, 'work tree')
  command(root, 'worktree', 'add', '-qb', 'agent/fix-one', location)
  command(root, 'branch', 'agent/fix-one-extra')
  const head = command(root, 'rev-parse', 'HEAD')
  command(root, 'update-ref', 'refs/dsh-superagent/ticket-1', head)
  command(root, 'update-ref', 'refs/dsh-superagent/ticket-1-extra', head)
  const dbPath = join(root, 'state.db')
  database(dbPath, [['ticket-1', { id: 'ticket-1', execution: { name: 'fix-one', directory: location } }]])
  const before = readFileSync(dbPath)
  const beforeRefs = command(root, 'show-ref')
  const { status, output } = scan('--repo', root, '--db', dbPath)
  assert.equal(status, 0)
  assert.equal(output.database.state, 'available')
  assert.equal(output.worktrees.find(item => resolve(item.path) === location).association.state, 'associated')
  assert.deepEqual(output.branches.find(item => item.ref === 'refs/heads/agent/fix-one').association.ticketIds, ['ticket-1'])
  assert.equal(output.branches.find(item => item.ref.endsWith('fix-one-extra')).association.state, 'missing-ticket')
  assert.equal(output.refs.find(item => item.ref.endsWith('/ticket-1')).association.state, 'associated')
  assert.equal(output.refs.find(item => item.ref.endsWith('/ticket-1-extra')).association.state, 'missing-ticket')
  assert.deepEqual(readFileSync(dbPath), before)
  assert.equal(command(root, 'show-ref'), beforeRefs)
  assert.equal(command(root, 'worktree', 'list', '--porcelain').includes('work tree'), true)
}))

test('reports gone upstreams from local tracking data without claiming remote state', () => fixture(root => {
  command(root, 'remote', 'add', 'origin', 'https://example.invalid/repository.git')
  command(root, 'branch', 'agent/gone')
  command(root, 'branch', 'agent/present')
  command(root, 'branch', 'agent/unconfigured')
  command(root, 'config', 'branch.agent/gone.remote', 'origin')
  command(root, 'config', 'branch.agent/gone.merge', 'refs/heads/agent/gone')
  command(root, 'config', 'branch.agent/present.remote', 'origin')
  command(root, 'config', 'branch.agent/present.merge', 'refs/heads/agent/present')
  command(root, 'update-ref', 'refs/remotes/origin/agent/present', command(root, 'rev-parse', 'HEAD'))
  const beforeRefs = command(root, 'show-ref')
  const result = scan('--repo', root)
  assert.equal(result.status, 0)
  const branch = name => result.output.branches.find(item => item.ref === `refs/heads/agent/${name}`)
  assert.equal(branch('gone').upstream, 'refs/remotes/origin/agent/gone')
  assert.equal(branch('gone').upstreamTracking, '[gone]')
  assert.equal(branch('present').upstreamTracking, 'local-ref-present')
  assert.equal(branch('unconfigured').upstreamTracking, null)
  assert.equal(command(root, 'show-ref'), beforeRefs)
}))

test('reports ticket directories even when they have no Git registration', () => fixture(root => {
  const location = join(root, 'unregistered'), missing = join(root, 'missing')
  mkdirSync(location)
  writeFileSync(join(location, 'keep.txt'), 'keep')
  const dbPath = join(root, 'state.db')
  database(dbPath, [
    ['ticket-1', { id: 'ticket-1', execution: { name: 'first', directory: location }, ended: { at: '2026-01-01', outcome: 'merged' } }],
    ['ticket-2', { id: 'ticket-2', execution: { name: 'second', directory: missing } }],
  ])
  const { status, output } = scan('--repo', root, '--db', dbPath)
  assert.equal(status, 0)
  assert.deepEqual(output.tickets[0].ended, { at: '2026-01-01', outcome: 'merged' })
  assert.equal(output.tickets[0].workspace.state, 'unknown')
  assert.equal(output.tickets[0].workspace.registered, false)
  assert.equal(output.tickets[1].workspace.state, 'missing')
  assert.equal(readFileSync(join(location, 'keep.txt'), 'utf8'), 'keep')
}))

test('reports missing directory and unknown association without a database', () => fixture(root => {
  const location = join(root, 'gone')
  command(root, 'worktree', 'add', '-qb', 'agent/gone', location)
  rmSync(location, { recursive: true, force: true })
  const { status, output } = scan('--repo', root)
  assert.equal(status, 0)
  const tree = output.worktrees.find(item => resolve(item.path) === location)
  assert.equal(tree.metadata.state, 'missing')
  assert.equal(tree.association.state, 'unknown')
  assert.equal(output.branches.find(item => item.ref.endsWith('/gone')).association.state, 'unknown')
}))

test('malformed records prevent orphan conclusions; inaccessible databases fail', () => fixture(root => {
  command(root, 'update-ref', 'refs/dsh-superagent/orphan', command(root, 'rev-parse', 'HEAD'))
  const dbPath = join(root, 'state.db')
  database(dbPath, [['bad', '{'], ['wrong', { id: 'different' }]])
  const result = scan('--repo', root, '--db', dbPath)
  assert.equal(result.status, 0)
  assert.equal(result.output.database.state, 'incomplete')
  assert.equal(result.output.database.issues.length, 2)
  assert.equal(result.output.refs[0].association.state, 'unknown')
  const bad = join(root, 'bad.db')
  writeFileSync(bad, 'not sqlite')
  assert.equal(scan('--repo', root, '--db', bad).status, 1)
  assert.equal(scan('--repo', root, '--db', join(root, 'absent.db')).status, 1)
  writeFileSync(`${dbPath}-wal`, '')
  assert.match(scan('--repo', root, '--db', dbPath).output.error, /WAL/)
}))

test('reports broken checkout metadata without declaring it removable', () => fixture(root => {
  const location = join(root, 'broken')
  command(root, 'worktree', 'add', '-qb', 'agent/broken', location)
  rmSync(location, { recursive: true, force: true })
  mkdirSync(location)
  const result = scan('--repo', root)
  assert.equal(result.status, 0)
  assert.equal(result.output.worktrees.find(item => resolve(item.path) === location).metadata.state, 'unknown')
}))

test('supports newlines in worktree paths', { skip: process.platform === 'win32' }, () => fixture(root => {
  const location = join(root, 'line\nbreak')
  command(root, 'worktree', 'add', '-qb', 'agent/newline', location)
  const result = scan('--repo', root)
  assert.equal(result.status, 0)
  assert.equal(result.output.worktrees.find(item => item.path === location).metadata.state, 'present')
}))

test('requires explicit repository and reports JSON usage', () => {
  assert.equal(scan().status, 1)
  assert.match(scan('--help').output.usage, /--repo/)
  assert.equal(scan('--repo', '.','--repo', '.').status, 1)
})
