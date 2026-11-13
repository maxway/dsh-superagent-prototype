#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const usage = 'node scripts/workspace-inventory.mjs --repo <local-git-repository> [--db <sqlite-state-file>]'

function argumentsFor(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true }
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    if (!['--repo', '--db'].includes(key) || options[key] !== undefined || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`Invalid arguments. Usage: ${usage}`)
    options[key] = argv[index + 1]
  }
  if (!options['--repo']) throw new Error(`Repository path is required. Usage: ${usage}`)
  return { repo: resolve(options['--repo']), db: options['--db'] ? resolve(options['--db']) : undefined }
}

const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
environment.GIT_OPTIONAL_LOCKS = '0'
environment.GIT_TERMINAL_PROMPT = '0'
environment.GIT_NO_LAZY_FETCH = '1'
environment.GIT_CONFIG_NOSYSTEM = '1'
environment.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
environment.LC_ALL = 'C'

function git(directory, ...args) {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', '-C', directory, ...args], { env: environment, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  if (result.error || result.status !== 0) throw new Error(`Git ${args[0]} failed: ${result.error?.message ?? result.stderr?.trim() ?? 'unknown error'}`)
  return result.stdout
}

function gitLine(directory, ...args) {
  const output = git(directory, ...args)
  if (!output.endsWith('\n')) throw new Error('Unexpected Git output')
  return output.slice(0, -1).replace(/\r$/, '')
}

function pathKey(path) {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function readTickets(file) {
  if (!file) return { state: 'unavailable', tickets: [], issues: [] }
  try {
    lstatSync(`${file}-wal`)
    throw new Error('SQLite WAL exists; inventory requires a quiescent database without a WAL file')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const tickets = [], issues = []
    for (const row of db.prepare('SELECT id, value FROM ticket').all()) {
      try {
        const ticket = JSON.parse(row.value)
        if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket) || typeof row.id !== 'string' || ticket.id !== row.id || !row.id) throw new Error('invalid or mismatched id')
        if (ticket.execution !== undefined && (!ticket.execution || typeof ticket.execution !== 'object' || Array.isArray(ticket.execution) || typeof ticket.execution.name !== 'string' || !ticket.execution.name || typeof ticket.execution.directory !== 'string' || !isAbsolute(ticket.execution.directory))) throw new Error('invalid execution')
        tickets.push({ id: ticket.id, execution: ticket.execution ? { name: ticket.execution.name, directory: ticket.execution.directory } : null,
          ended: ticket.ended && typeof ticket.ended === 'object' ? { at: ticket.ended.at ?? null, outcome: ticket.ended.outcome ?? null } : null,
          handoffTo: typeof ticket.handoffTo === 'string' ? ticket.handoffTo : null })
      } catch (error) {
        issues.push({ rowId: typeof row.id === 'string' ? row.id : null, error: error.message })
      }
    }
    return { state: issues.length ? 'incomplete' : 'available', tickets, issues }
  } finally {
    db.close()
  }
}

function association(matches, database) {
  return { state: matches.length ? 'associated' : database.state === 'available' ? 'missing-ticket' : 'unknown', ticketIds: matches.map(ticket => ticket.id) }
}

function worktrees(output) {
  const records = [], fields = output.split('\0')
  let record = null
  for (const field of fields) {
    if (!field) {
      if (record) { records.push(record); record = null }
      continue
    }
    const space = field.indexOf(' ')
    const key = space < 0 ? field : field.slice(0, space)
    const value = space < 0 ? true : field.slice(space + 1)
    if (key === 'worktree') {
      if (record) throw new Error('Malformed Git worktree output')
      record = { path: value }
    } else {
      if (!record || Object.hasOwn(record, key)) throw new Error('Malformed Git worktree output')
      record[key] = value
    }
  }
  if (record) throw new Error('Incomplete Git worktree output')
  return records
}

function refs(output, withUpstream = false) {
  if (!output) return []
  return output.split('\n').filter(Boolean).map(line => {
    const parts = line.split('\0')
    if (parts.length !== (withUpstream ? 3 : 2) || !parts[0] || !/^[a-f0-9]+$/.test(parts[1])) throw new Error('Malformed Git reference output')
    return { ref: parts[0], oid: parts[1], ...(withUpstream ? { upstream: parts[2] || null } : {}) }
  })
}

function metadata(worktree, commonDir) {
  try {
    const stat = lstatSync(worktree.path)
    if (!stat.isDirectory()) return { state: 'unknown', reason: 'Path is not a directory or is a symbolic link' }
    lstatSync(join(worktree.path, '.git'))
    const common = gitLine(worktree.path, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    const gitDir = gitLine(worktree.path, 'rev-parse', '--path-format=absolute', '--git-dir')
    if (pathKey(common) !== pathKey(commonDir)) return { state: 'unknown', reason: 'Git common directory does not match' }
    return { state: 'present', gitDir }
  } catch (error) {
    if (error.code === 'ENOENT') {
      try { lstatSync(worktree.path) } catch (pathError) {
        if (pathError.code === 'ENOENT') return { state: 'missing', reason: 'Worktree directory is missing' }
      }
    }
    return { state: 'unknown', reason: `Metadata inaccessible or invalid: ${error.message}` }
  }
}

function inventory(options) {
  const database = readTickets(options.db)
  const commonDir = gitLine(options.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  const trees = worktrees(git(options.repo, 'worktree', 'list', '--porcelain', '-z'))
  const localRefs = refs(git(options.repo, 'for-each-ref', '--format=%(refname)%00%(objectname)%00%(upstream)', 'refs/heads/'), true)
  const allRefs = new Set(refs(git(options.repo, 'for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/')).map(ref => ref.ref))
  const ticketRefs = refs(git(options.repo, 'for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/dsh-superagent/'))
  const worktreeItems = trees.map(tree => {
    const matches = database.tickets.filter(ticket => ticket.execution && pathKey(ticket.execution.directory) === pathKey(tree.path))
    return { ...tree, metadata: metadata(tree, commonDir), association: association(matches, database) }
  })
  const branchItems = localRefs.filter(ref => ref.ref.startsWith('refs/heads/agent/')).map(ref => {
    const matches = database.tickets.filter(ticket => ticket.execution && `refs/heads/agent/${ticket.execution.name}` === ref.ref)
    return { ...ref, upstreamTracking: ref.upstream ? allRefs.has(ref.upstream) ? 'local-ref-present' : '[gone]' : null,
      worktrees: trees.filter(tree => tree.branch === ref.ref).map(tree => tree.path), association: association(matches, database) }
  })
  const refItems = ticketRefs.map(ref => {
    const matches = database.tickets.filter(ticket => `refs/dsh-superagent/${ticket.id}` === ref.ref)
    return { ...ref, association: association(matches, database) }
  })
  const tickets = database.tickets.map(ticket => {
    const execution = ticket.execution
    if (!execution) return { ...ticket, workspace: { state: 'unknown', reason: 'Ticket has no recorded execution directory' } }
    const registered = trees.find(tree => pathKey(tree.path) === pathKey(execution.directory))
    const localBranch = localRefs.find(ref => ref.ref === `refs/heads/agent/${execution.name}`)
    const ticketRef = ticketRefs.find(ref => ref.ref === `refs/dsh-superagent/${ticket.id}`)
    return { ...ticket, workspace: { ...metadata({ path: execution.directory }, commonDir), registered: !!registered },
      localBranch: localBranch ?? null, ticketRef: ticketRef ?? null }
  })
  return { repository: options.repo, commonDir, database: { path: options.db ?? null, state: database.state, issues: database.issues }, notice: 'Observations are not ownership evidence or permission to delete any resource. Keep the database quiescent; the WAL check cannot prevent concurrent changes.', tickets, worktrees: worktreeItems, branches: branchItems, refs: refItems }
}

try {
  const options = argumentsFor(process.argv.slice(2))
  const result = options.help ? { usage, description: 'Read-only local inventory; requires Node.js >=24. No resources are deleted. Supply only a quiescent database; existing WAL files are refused and concurrent writers can race the check.' } : inventory(options)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} catch (error) {
  process.stdout.write(`${JSON.stringify({ error: error.message, usage })}\n`)
  process.exitCode = 1
}
