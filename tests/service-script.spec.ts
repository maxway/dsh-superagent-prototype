/** Tests for scripts/dsh-superagent using a temporary checkout path with spaces and stubbed ps, tmux, and dsh binaries. */
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync }
  from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let root: string
let server: Server | undefined
let sleepers: ChildProcess[] = []
const control = (profile: string) => join(root, '.artifacts', 'control', 'profiles', profile)
const program = (name: string, body: string) => writeFileSync(join(root, 'bin', name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
/** Spawn a dummy process whose PID can be listed by the fake ps binary; ignoreInterrupt simulates a hung graceful stop. */
function sleeper(ignoreInterrupt = false): number {
  const [program, args] = ignoreInterrupt ? ['sh', ['-c', 'trap "" INT; exec sleep 60']] as const : ['sleep', ['60']] as const
  const child = spawn(program, [...args], { stdio: 'ignore' })
  sleepers.push(child)
  return child.pid!
}
const service = (pid: number, profile = 'superagent') => `${pid} node node /opt/my tools/dsh --profile ${profile} --no-open`
/** Write active process lines (`pid ucomm args`) for the fake ps binary. Entries prefixed with `after:<pid> ` appear only after that PID exits. */
const processes = (...lines: string[]) => writeFileSync(join(root, 'ps.txt'), lines.map(line => `${line}\n`).join(''))
const started = (...lines: string[]) => writeFileSync(join(root, 'ps-started.txt'), lines.map(line => `${line}\n`).join(''))
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'service script '))
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin'))
  // The copied script is an ES module; give its temporary checkout the same package type as the repository.
  writeFileSync(join(root, 'package.json'), '{ "type": "module" }\n')
  copyFileSync(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent'), join(root, 'scripts', 'dsh-superagent'))
  processes()
  program('ps', `list='${root}/ps.txt'; [ -f '${root}/launched' ] && [ -f '${root}/ps-started.txt' ] && list='${root}/ps-started.txt'
want=; while [ $# -gt 0 ]; do [ "$1" = -p ] && want=$2; shift; done
while IFS= read -r line; do
  case "$line" in after:*) dep=\${line#after:}; dep=\${dep%% *}; kill -0 "$dep" 2>/dev/null && continue; line=\${line#after:$dep };; esac
  pid=\${line%% *}; kill -0 "$pid" 2>/dev/null || continue
  if [ -z "$want" ] || [ "$pid" = "$want" ]; then printf '%s\\n' "$line"; fi
done < "$list"`)
  // Log tmux invocations and simulate session creation by outputting the pane PID.
  program('tmux', `for a in "$@"; do printf '%s\\n' "$a"; done >> '${root}/tmux.log'; echo --- >> '${root}/tmux.log'\n`
    + `case "$1" in -L) shift 2;; esac\ncase "$1" in has-session) exit 1;; new-*) touch '${root}/launched'; cat '${root}/pane';; esac`)
  program('dsh', 'exit 0')
})
afterEach(() => {
  server?.close(); server = undefined
  for (const child of sleepers) child.kill()
  sleepers = []
  rmSync(root, { recursive: true, force: true })
})
function runWithEnvironment(environment: NodeJS.ProcessEnv, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => execFile(process.execPath, [join(root, 'scripts', 'dsh-superagent'), ...args],
    { env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, DSH_SUPERAGENT_PROFILE: '', DSH_SUPERAGENT_URL: '', ...environment },
      timeout: 20_000 },
    (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })))
}
const run = (...args: string[]) => runWithEnvironment({}, ...args)
const READY = { health: { runtime: { state: 'ready', detail: '' } }, setup: { problem: null, feishuProblem: null } }
/** Start a mock HTTP server that returns 503 until tmux launches the service (unless always is true). */
async function answering(state: unknown = READY, always = false): Promise<string> {
  server = createServer((_request, response) => {
    if (!always && !existsSync(join(root, 'launched'))) { response.writeHead(503).end(); return }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}
const status = async (profile: string, url = 'http://127.0.0.1:9') =>
  JSON.parse((await run('status', '--profile', profile, '--url', url)).stdout) as { pids: number[]; manually_stopped: boolean }

// These cases drive the POSIX control path with stubbed `ps`, `tmux` and `dsh` shell scripts. The Windows start/stop
// path is covered by the platform-specific unit test below and by the real Windows smoke run in deployment stage 5.
describe.skipIf(process.platform === 'win32')('POSIX service lifecycle', () => {
it('refuses to stop when two processes serve the profile, before it writes the stop marker', async () => {
  processes(service(sleeper()), `${sleeper()} node node /opt/dsh --profile=superagent`)
  expect(await run('stop')).toMatchObject({ code: 1, stderr: expect.stringContaining('Multiple dsh-superagent processes found') })
  expect(existsSync(join(control('superagent'), 'manually-stopped'))).toBe(false)
})
it('keeps a stop per profile', async () => {
  expect(await run('stop', '--profile', 'one')).toMatchObject({ code: 0, stdout: expect.stringContaining('Automatic recovery is paused') })
  expect(await status('one')).toMatchObject({ manually_stopped: true })
  expect(await status('two')).toMatchObject({ manually_stopped: false })
  const skipped = await run('--respect-stop', 'start', '--profile', 'one')
  expect(skipped).toMatchObject({ code: 0, stdout: expect.stringContaining('Intentional stop is active') })
})
it('recognizes a Node service whose process name is MainThread', async () => {
  const service = sleeper()
  processes(`${service} MainThread node /opt/my tools/dsh --profile superagent --no-open`)
  expect(await status('superagent')).toMatchObject({ pids: [service] })
})
it('takes no `dsh plugin` command of the profile for its service', async () => {
  const service = sleeper()
  processes(`${sleeper()} node node /opt/my tools/dsh plugin --profile superagent add link:/x`,
    `${service} node node /opt/my tools/dsh --profile superagent --no-open`)
  expect(await status('superagent')).toMatchObject({ pids: [service] })
})
it('does not take another control invocation for its profile as the service', async () => {
  const script = join(root, 'scripts', 'dsh-superagent')
  processes(`${sleeper()} node node ${script} --profile superagent status`)
  expect(await status('superagent')).toMatchObject({ pids: [] })
})
it('starts the service when the scan only finds a control invocation for its profile', async () => {
  const url = await answering()
  const pid = sleeper()
  processes(`${sleeper()} node node ${join(root, 'scripts', 'dsh-superagent')} --profile superagent start`)
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  expect(await run('start', '--url', url, '--timeout', '10'))
    .toMatchObject({ code: 0, stdout: expect.stringContaining(`"pids": [\n    ${pid}\n  ]`) })
}, 20_000)
it('records the service PID at start, and still refuses a second instance the scan finds', async () => {
  const url = await answering()
  const pid = sleeper()
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  const start = await run('start', '--url', url, '--timeout', '10')
  expect(start).toMatchObject({ code: 0, stdout: expect.stringContaining(`"pids": [\n    ${pid}\n  ]`) })
  expect(readFileSync(join(control('superagent'), 'service.pid'), 'utf8')).toBe(`${pid}\n`)
  const tmux = readFileSync(join(root, 'tmux.log'), 'utf8').split('---\n').find(call => call.includes('\nnew-session\n'))!.split('\n')
  // The checkout's path, which has a space, is one argument, and the log path inside it is quoted for the shell.
  const checkout = realpathSync(root)
  expect(tmux).toEqual(expect.arrayContaining(['-L', '-P', '-F', '#{pane_pid}', '-c', checkout]))
  expect(tmux[1]).toMatch(/^dsh-superagent-[a-f0-9]{20}$/)
  const log = new RegExp(`>> '${checkout}/\\.artifacts/dsh-superagent-superagent-\\d{8}-\\d{6}-\\d+\\.log' 2>&1$`)
  expect(tmux.find(word => word.startsWith('umask 077; '))).toMatch(log)
  const second = sleeper()
  started(service(pid), `${second} node node /opt/dsh --profile superagent`)
  const again = await run('start', '--url', url, '--timeout', '10')
  expect(again).toMatchObject({ code: 1, stderr: expect.stringContaining('Multiple dsh-superagent processes') })
  expect(await status('superagent')).toMatchObject({ pids: [pid, second] })
}, 20_000)
it.each([undefined, '', "/tmp/profile with 'quotes'"])('uses the caller environment instead of the tmux server environment for DSH_HOME %s', async dshHome => {
  const url = await answering()
  const pid = sleeper()
  const home = "/tmp/home with 'quotes'"
  const path = `${join(root, 'bin')}:/usr/bin:/bin`
  program('dsh', `printf '%s\\n' "\${DSH_HOME-<unset>}" "$HOME" "$PATH" "\${TMUX-<unset>}" "\${TMUX_PANE-<unset>}" > '${root}/environment'`)
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  expect(await runWithEnvironment({ DSH_HOME: dshHome, HOME: home, PATH: path }, 'start', '--url', url, '--timeout', '10')).toMatchObject({ code: 0 })
  const command = readFileSync(join(root, 'tmux.log'), 'utf8').split('\n').find(line => line.startsWith('umask 077; '))!
  execFileSync('/bin/sh', ['-c', command], { env: { DSH_HOME: '/tmp/wrong-profile', HOME: '/tmp/wrong-home', PATH: '/usr/bin:/bin', TMUX: '/tmp/server,1,0', TMUX_PANE: '%1' } })
  expect(readFileSync(join(root, 'environment'), 'utf8').split('\n')).toEqual([dshHome ?? '<unset>', home, path, '<unset>', '<unset>', ''])
}, 20_000)
it.skipIf(!existsSync('/usr/bin/tmux'))('keeps the service socket alive when a worker runs tmux kill-server', async () => {
  const tmuxEnvironment = { ...process.env, TMUX: undefined, TMUX_TMPDIR: root }
  const socketName = 'service-test'
  const tmux = (...args: string[]) => execFileSync('/usr/bin/tmux', ['-L', socketName, ...args], { env: tmuxEnvironment })
  tmux('new-session', '-d', '-s', 'isolated', 'sleep 60')
  try {
    const serverPid = tmux('display-message', '-p', '-t', 'isolated', '#{pid}').toString().trim()
    const socket = join(root, `tmux-${process.getuid!()}`, socketName)
    const url = await answering()
    const pid = sleeper()
    program('dsh', `TMUX_TMPDIR='${root}' /usr/bin/tmux kill-server 2>/dev/null || :`)
    writeFileSync(join(root, 'pane'), `${pid}\n`)
    started(service(pid))
    expect(await run('start', '--url', url, '--timeout', '10')).toMatchObject({ code: 0 })
    const command = readFileSync(join(root, 'tmux.log'), 'utf8').split('\n').find(line => line.startsWith('umask 077; '))!
    execFileSync('/bin/sh', ['-c', command], { env: { ...process.env, TMUX: `${socket},${serverPid},0`, TMUX_TMPDIR: root } })
    expect(() => tmux('has-session', '-t', '=isolated')).not.toThrow()
  } finally {
    tmux('kill-server')
  }
}, 20_000)
it('waits only for the process it stopped', async () => {
  const pid = sleeper()
  // Another instance shows up once the stopped one ended.
  processes(service(pid), `after:${pid} ${sleeper()} node node /opt/dsh --profile superagent`)
  expect(await run('stop', '--stop-timeout', '5')).toMatchObject({ code: 0, stdout: expect.stringContaining('dsh-superagent stopped') })
}, 20_000)
it('keeps only the newest logs it wrote for the profile', async () => {
  const url = await answering()
  const pid = sleeper()
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  mkdirSync(join(root, '.artifacts'), { recursive: true })
  for (const profile of ['superagent', 'other']) for (let index = 0; index < 25; index++) {
    const log = join(root, '.artifacts', `dsh-superagent-${profile}-20260901-0000${String(index).padStart(2, '0')}-1.log`)
    writeFileSync(log, '')
    utimesSync(log, 1_700_000_000 + index, 1_700_000_000 + index)
  }
  writeFileSync(join(root, '.artifacts', 'dsh-superagent-20260901-000000-1.log'), '')
  expect(await run('start', '--url', url, '--timeout', '10')).toMatchObject({ code: 0 })
  const logs = readdirSync(join(root, '.artifacts'))
  const own = logs.filter(name => name.startsWith('dsh-superagent-superagent-')).sort()
  expect(own).toHaveLength(20)
  // The oldest went; the new one stays, with the newest earlier ones. Another profile's logs and older names stay.
  expect(own).not.toContain('dsh-superagent-superagent-20260901-000000-1.log')
  expect(own.filter(name => !name.startsWith('dsh-superagent-superagent-20260901-'))).toHaveLength(1)
  expect(logs.filter(name => name.startsWith('dsh-superagent-other-'))).toHaveLength(25)
  expect(logs).toContain('dsh-superagent-20260901-000000-1.log')
}, 20_000)
it('reports a service whose Feishu bot setup could not check as running, and reads an answer with keys missing', async () => {
  processes(service(sleeper()))
  const feishu = { health: { runtime: { state: 'ready', detail: '' }, feishu: { state: 'paused', detail: '' } },
    setup: { problem: null, feishuProblem: { code: 'feishuNoBot', detail: 'No bot' } } }
  expect(await run('status', '--url', await answering(feishu, true))).toMatchObject({ code: 0 })
  server!.close()
  expect(await run('status', '--url', await answering({ health: { runtime: { state: 'ready' } } }, true))).toMatchObject({ code: 0 })
  server!.close()
  expect(await run('status', '--url', await answering({ health: { runtime: { state: 'error' } } }, true))).toMatchObject({ code: 1 })
})
it('exits 2 while a part such as a Source reports an error, which a restart does not fix, and prints what it reports', async () => {
  processes(service(sleeper()))
  const github = { health: { runtime: { state: 'ready', detail: '' }, github: { state: 'error', detail: 'bad token' } }, setup: {} }
  const url = await answering(github, true)
  const checked = await run('status', '--url', url)
  expect(checked.code).toBe(2)
  expect(JSON.parse(checked.stdout)).toMatchObject({ errors: { github: 'bad token' } })
  expect(await run('start', '--url', url, '--timeout', '10'))
    .toMatchObject({ code: 2, stdout: expect.stringContaining('github reports an error, which a restart does not fix: bad token') })
}, 20_000)
it('exits 3 while the service waits for setup, from status and from start, which a restart does not fix', async () => {
  processes(service(sleeper()))
  const waiting = { health: { runtime: { state: 'paused', detail: '' } },
    setup: { problem: { code: 'repositoryUnset', detail: 'The GitHub Source names no repository.' }, feishuProblem: null } }
  const url = await answering(waiting, true)
  expect(await run('status', '--url', url)).toMatchObject({ code: 3 })
  expect(await run('start', '--url', url, '--timeout', '10'))
    .toMatchObject({ code: 3, stdout: expect.stringContaining('waiting for setup: The GitHub Source names no repository.') })
}, 20_000)
it('restarts the service, and a restart whose graceful stop timed out does not keep recovery off', async () => {
  const url = await answering()
  const old = sleeper(), pid = sleeper()
  processes(service(old))
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  const restarted = await run('restart', '--url', url, '--timeout', '10', '--stop-timeout', '5')
  expect(restarted).toMatchObject({ code: 0, stdout: expect.stringContaining('dsh-superagent stopped.') })
  expect(restarted.stdout).not.toContain('Automatic recovery is paused')
  expect(existsSync(join(control('superagent'), 'manually-stopped'))).toBe(false)
  expect(readFileSync(join(control('superagent'), 'service.pid'), 'utf8')).toBe(`${pid}\n`)
  // A service that does not stop in time is left running, and the next check may restart it.
  rmSync(join(root, 'launched'))
  processes(service(sleeper(true)))
  expect(await run('restart', '--url', url, '--timeout', '10', '--stop-timeout', '1'))
    .toMatchObject({ code: 1, stderr: expect.stringContaining('Graceful stop timed out') })
  expect(await status('superagent')).toMatchObject({ manually_stopped: false })
}, 20_000)
it('refuses a second control operation while one holds the profile\'s lock', async () => {
  mkdirSync(join(control('superagent'), 'operation.lock'), { recursive: true })
  expect(await run('status')).toMatchObject({ code: 1,
    stderr: expect.stringContaining('Another dsh-superagent control operation is in progress') })
}, 20_000)
})
it('exposes the platform-specific process, start and argument forms', async () => {
  const module = pathToFileURL(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent')).href
  const script = `import(${JSON.stringify(module)}).then(m => console.log(JSON.stringify({
    ps: m.parsePs('  123 node node /opt/my tools/dsh --profile superagent --no-open\\n'),
    windows: m.parseWindowsProcesses(JSON.stringify([{ ProcessId: 7, Name: 'node.exe', CommandLine: 'node /opt/dsh --profile superagent --no-open' },
      { ProcessId: 8, Name: 'other.exe', CommandLine: 'node /opt/dsh --profile superagent' },
      { ProcessId: 9, Name: 'DeepSeek Harness.exe', CommandLine: 'D:\\\\app\\\\DeepSeek Harness.exe --expose-internals D:\\\\app\\\\cli.js --profile superagent --no-open' }])),
    start: m.windowsStart('C:\\\\Program Files\\\\dsh.cmd', 'superagent'),
    socket: m.tmuxSocket('superagent'),
    command: m.tmuxCommand('/opt/dsh', 'superagent', '/tmp/log file.log', { DSH_HOME: '/tmp/home', PATH: '/usr/bin', HOME: undefined, TMUX: '/tmp/x,1,0' }),
    argv: m.parseArgv(['--respect-stop', 'start', '--profile', 'one', '--timeout', '5']),
    watchdog: m.parseArgv(['watchdog', '--stale-minutes', '7', '--url', 'http://127.0.0.1:1']),
    serves: [
      m.serves(['node', '/x/scripts/dsh-superagent', '--profile', 'one', 'start'], 'one'),
      m.serves(['node', '/x/scripts/dsh-superagent', '--profile', 'one', 'restart'], 'one'),
      m.serves(['node', '/x/scripts/dsh-superagent', '--profile', 'one'], 'one'),
      m.serves(['node', '/opt/dsh', '--profile', 'one', '--no-open'], 'one'),
      m.serves(['node', '/opt/dsh', '--profile', 'other', '--no-open'], 'one')
    ]
  })))`
  const out = await new Promise<string>((resolve, reject) => execFile(process.execPath, ['-e', script],
    (error, stdout) => error ? reject(error) : resolve(stdout)))
  const value = JSON.parse(out) as { ps: unknown[]; windows: unknown[]; start: unknown; socket: string; command: string; argv: Record<string, unknown>; watchdog: Record<string, unknown>; serves: boolean[] }
  expect(value.ps).toEqual([{ pid: 123, name: 'node', args: ['node', '/opt/my', 'tools/dsh', '--profile', 'superagent', '--no-open'] }])
  expect(value.windows).toEqual([{ pid: 7, name: 'node', args: ['node', '/opt/dsh', '--profile', 'superagent', '--no-open'] },
    { pid: 9, name: 'deepseek harness', args: ['D:\\app\\DeepSeek', 'Harness.exe', '--expose-internals', 'D:\\app\\cli.js', '--profile', 'superagent', '--no-open'] }])
  expect(value.start).toEqual({ file: '"C:\\Program Files\\dsh.cmd"', args: ['--profile', 'superagent', '--no-open'], shell: true })
  expect(value.socket).toBe('dsh-superagent-f063ff9f0c5ba70eeebc')
  expect(value.command).toBe("umask 077; export DSH_HOME=/tmp/home; unset HOME; export PATH=/usr/bin; unset TMUX TMUX_PANE; exec /opt/dsh --profile superagent --no-open >> '/tmp/log file.log' 2>&1")
  expect(value.argv).toMatchObject({ action: 'start', profile: 'one', timeout: 5, respect_stop: true })
  expect(value.watchdog).toMatchObject({ action: 'watchdog', stale_minutes: 7, url: 'http://127.0.0.1:1' })
  // A control invocation of this script carries --profile too, but only the DSH launcher is the service.
  expect(value.serves).toEqual([false, false, false, true, false])
})
it('launches a Windows npm shim through its Node entry', async () => {
  const shim = join(root, 'bin', 'dsh.cmd')
  const entryDir = join(root, 'bin', 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(entryDir, { recursive: true })
  const entry = join(entryDir, 'bin.js')
  writeFileSync(entry, '')
  writeFileSync(shim, '"%_prog%" "%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n')
  const module = pathToFileURL(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent')).href
  const script = `import(${JSON.stringify(module)}).then(m => console.log(JSON.stringify(m.windowsStart(${JSON.stringify(shim)}, 'superagent', ${JSON.stringify(process.execPath)}))))`
  const out = await new Promise<string>((resolve, reject) => execFile(process.execPath, ['-e', script],
    (error, stdout) => error ? reject(error) : resolve(stdout)))
  expect(JSON.parse(out)).toEqual({ file: process.execPath, args: [entry, '--profile', 'superagent', '--no-open'], shell: false })
})
it.skipIf(process.platform !== 'win32')('keeps a detached Node shim hidden and writes its output to the log', async () => {
  const entry = join(root, 'bin', 'entry.js')
  const shim = join(root, 'bin', 'dsh.cmd')
  const log = join(root, 'service.log')
  writeFileSync(entry, "console.log('started'); setTimeout(() => console.log('still running'), 300); setInterval(() => {}, 1000)\n")
  writeFileSync(shim, '"%_prog%" "%dp0%\\entry.js" %*\r\n')
  const module = pathToFileURL(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent')).href
  const script = `import(${JSON.stringify(module)}).then(m => console.log(JSON.stringify(m.windowsStart(${JSON.stringify(shim)}, 'superagent', ${JSON.stringify(process.execPath)}))))`
  const out = await new Promise<string>((resolve, reject) => execFile(process.execPath, ['-e', script],
    (error, stdout) => error ? reject(error) : resolve(stdout)))
  const invocation = JSON.parse(out) as { file: string; args: string[]; shell: boolean }
  const output = openSync(log, 'w')
  const child = spawn(invocation.file, invocation.args, { detached: true, shell: invocation.shell, windowsHide: true, stdio: ['ignore', output, output] })
  closeSync(output)
  try {
    await new Promise(resolve => setTimeout(resolve, 1200))
    expect(readFileSync(log, 'utf8')).toContain('still running')
    const window = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).MainWindowHandle`], { encoding: 'utf8' }).trim()
    expect(window).toBe('0')
  } finally {
    child.kill()
    await new Promise(resolve => child.once('exit', resolve))
  }
}, 10_000)
it('prints the Watchdog snapshot over GET and refuses an unreachable service', async () => {
  const requests: { method?: string; url?: string; header?: string }[] = []
  server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, header: String(request.headers['x-orchestrator-request']) })
    response.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ at: '2026-11-07T01:00:00.000Z', staleMinutes: 15, open: 1, tickets: [{ id: 't1', signals: ['no-progress'] }],
        state: { paused: false }, watchdog: { mode: 'enforce', staleMinutes: 30 }, audit: [] }))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  const watched = await run('watchdog', '--url', url, '--stale-minutes', '15')
  expect(watched.code).toBe(0)
  expect(JSON.parse(watched.stdout)).toMatchObject({ profile: 'superagent', url, staleMinutes: 15, open: 1, tickets: [{ id: 't1' }],
    watchdog: { mode: 'enforce', staleMinutes: 30 }, audit: [] })
  // The command is read-only: one GET, no retry, stop, settings or prompt call.
  expect(requests).toEqual([{ method: 'GET', url: '/orchestrator/api/watchdog?stale_minutes=15', header: '1' }])
  expect(await run('watchdog', '--url', 'http://127.0.0.1:9')).toMatchObject({ code: 1,
    stderr: expect.stringContaining('No management API answer') })
  expect(await run('watchdog', '--stale-minutes', '0')).toMatchObject({ code: 1,
    stderr: expect.stringContaining('--stale-minutes must be an integer between 1 and 1440') })
})
/** A snapshot row the CLI can ask the server to act on. */
function watchdogTicket(fields: Record<string, unknown> = {}) {
  return { id: 't1', title: 'Fix the build', stage: 'person', action: 'failed', silentMinutes: 90, signals: ['waiting-person'],
    lastReport: { state: 'failed', summary: 'The build broke', at: '2026-11-07T00:00:00.000Z', ageMinutes: 90 },
    attempts: ['failed'], actions: { retry: true, stop: true }, ...fields }
}
/** Answer the Watchdog snapshot and record each action request, including its JSON body. */
async function watchdogApi(ticket: () => Record<string, unknown> = () => watchdogTicket()) {
  const calls: { method?: string; url?: string; body?: string; header?: string }[] = []
  server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      calls.push({ method: request.method, url: request.url, body, header: String(request.headers['x-orchestrator-request']) })
      if (request.method === 'POST') {
        const value = JSON.parse(body) as { idempotencyKey: string; snapshotAt: string; reason: string }
        const id = /tickets\/([^/]+)\//.exec(request.url ?? '')?.[1] ?? 't1'
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'watchdog-audit-1',
          idempotency: value.idempotencyKey, at: '2026-11-07T00:01:00.000Z', snapshotAt: value.snapshotAt, ticketId: id,
          action: request.url?.endsWith('/stop') ? 'stop' : 'retry', mode: 'enforce', initiator: 'watchdog', reason: value.reason,
          result: 'executed', before: { stage: 'person', action: 'failed' }, after: { stage: 'working' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ at: '2026-11-07T00:00:00.000Z', staleMinutes: 30,
        open: 1, tickets: [ticket()], state: { paused: false, health: {} },
        watchdog: { mode: 'enforce', actions: ['retry', 'stop'], staleMinutes: 30, cooldownMinutes: 15, perTicketPerHour: 2, perHour: 6 },
        audit: [] }))
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  return { calls, url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}` }
}
it('asks the server for one retry or stop with the snapshot and a fresh idempotency key', async () => {
  const { calls, url } = await watchdogApi()
  const retry = await run('watchdog', 'retry', 't1', '--reason', 'No report for 90 minutes', '--url', url)
  expect(retry.code).toBe(0)
  expect(JSON.parse(retry.stdout)).toMatchObject({ result: 'executed', ticketId: 't1', action: 'retry' })
  const stop = await run('watchdog', 'stop', 't1', '--reason', 'Stuck and drifting', '--url', url)
  expect(stop.code).toBe(0)
  expect(JSON.parse(stop.stdout)).toMatchObject({ result: 'executed', ticketId: 't1', action: 'stop' })
  const posts = calls.filter(call => call.method === 'POST')
  expect(posts.map(call => call.url)).toEqual(['/orchestrator/api/watchdog/tickets/t1/retry',
    '/orchestrator/api/watchdog/tickets/t1/stop'])
  expect(calls[0]).toMatchObject({ method: 'GET', url: '/orchestrator/api/watchdog?stale_minutes=30' })
  const first = JSON.parse(posts[0]!.body!) as { reason: string; snapshotAt: string; idempotencyKey: string; evidence: Record<string, unknown> }
  expect(first).toMatchObject({ reason: 'No report for 90 minutes', snapshotAt: '2026-11-07T00:00:00.000Z',
    evidence: { stage: 'person', action: 'failed', silentMinutes: 90 } })
  const second = JSON.parse(posts[1]!.body!) as { idempotencyKey: string }
  expect(first.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
  expect(second.idempotencyKey).not.toBe(first.idempotencyKey)
  expect(posts.every(call => call.header === '1')).toBe(true)
})
it('refuses an action for a Ticket that is not open, and a missing ticket or reason', async () => {
  const { calls, url } = await watchdogApi(() => watchdogTicket())
  expect(await run('watchdog', 'retry', 'unknown', '--reason', 'Gone', '--url', url)).toMatchObject({ code: 1,
    stderr: expect.stringContaining('is not open') })
  expect(await run('watchdog', 'retry', '--reason', 'No ticket', '--url', url)).toMatchObject({ code: 1,
    stderr: expect.stringContaining('needs a ticket id') })
  expect(await run('watchdog', 'stop', 't1', '--url', url)).toMatchObject({ code: 1,
    stderr: expect.stringContaining('needs --reason') })
  expect(await run('watchdog', 'restart', 't1', '--url', url)).toMatchObject({ code: 1,
    stderr: expect.stringContaining('watchdog action must be retry or stop') })
  expect(calls.some(call => call.method === 'POST')).toBe(false)
})
it('reports a management API refusal from the action route', async () => {
  server = createServer((request, response) => {
    if (request.method === 'POST') {
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid settings: reason' }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ at: '2026-11-07T00:00:00.000Z', staleMinutes: 30,
      open: 1, tickets: [watchdogTicket()], state: { paused: false, health: {} },
      watchdog: { mode: 'enforce' }, audit: [] }))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  expect(await run('watchdog', 'retry', 't1', '--reason', 'Bad request', '--url', url)).toMatchObject({ code: 1,
    stderr: expect.stringContaining('Invalid settings: reason') })
})
// The remaining cases also drive the POSIX control path with stubbed shell binaries.
describe.skipIf(process.platform === 'win32')('POSIX service lifecycle (continued)', () => {
it('refuses to start a service while no process runs it but something answers at its URL', async () => {
  const url = await answering(READY, true)
  expect(await run('start', '--url', url, '--timeout', '5'))
    .toMatchObject({ code: 1, stderr: expect.stringContaining('An existing orchestrator answers at this URL') })
  expect(readFileSync(join(root, 'tmux.log'),
    'utf8').split('---\n').filter(Boolean).map(call => call.split('\n')[2])).toEqual(['has-session'])
}, 20_000)
it('starts the service in a new window of the profile\'s tmux session when the session exists', async () => {
  program('tmux', `for a in "$@"; do printf '%s\\n' "$a"; done >> '${root}/tmux.log'; echo --- >> '${root}/tmux.log'\n`
    + `case "$1" in -L) shift 2;; esac\ncase "$1" in has-session) exit 0;; new-*) touch '${root}/launched'; cat '${root}/pane';; esac`)
  const url = await answering()
  const pid = sleeper()
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  expect(await run('start', '--url', url, '--timeout', '10')).toMatchObject({ code: 0 })
  const calls = readFileSync(join(root, 'tmux.log'), 'utf8').split('---\n').map(call => call.split('\n'))
  expect(calls.find(call => call[2] === 'new-window')).toEqual(expect.arrayContaining(['-t', '=dsh-superagent:']))
  expect(calls.some(call => call[2] === 'new-session')).toBe(false)
}, 20_000)
it('exits 1 when the started service does not answer in time, and leaves its process running', async () => {
  const pid = sleeper()
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  expect(await run('start', '--url', 'http://127.0.0.1:9', '--timeout', '2'))
    .toMatchObject({ code: 1, stderr: expect.stringContaining('Startup health check timed out') })
  expect(() => process.kill(pid, 0)).not.toThrow()
}, 20_000)
it('does not signal a process that took the recorded service PID, and keeps a stop that timed out', async () => {
  mkdirSync(control('superagent'), { recursive: true })
  const other = sleeper()
  processes(`${other} sleep sleep 60`)
  writeFileSync(join(control('superagent'), 'service.pid'), `${other}\n`)
  expect(await run('stop', '--stop-timeout', '1')).toMatchObject({ code: 0 })
  expect(() => process.kill(other, 0)).not.toThrow()
  // A service that does not stop in time keeps the stop, so recovery does not start it again.
  rmSync(join(control('superagent'), 'manually-stopped'))
  processes(service(sleeper(true)))
  expect(await run('stop', '--stop-timeout', '1')).toMatchObject({ code: 1, stderr: expect.stringContaining('Graceful stop timed out') })
  expect(existsSync(join(control('superagent'), 'manually-stopped'))).toBe(true)
}, 20_000)
})
