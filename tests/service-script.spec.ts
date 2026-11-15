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
let home: string
let server: Server | undefined
let sleepers: ChildProcess[] = []
let fallbackServer: Server
let fallbackUrl: string
const allowedEnvironment = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PROCESSOR_ARCHITECTURE'])
const testEnvironment = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowedEnvironment.has(key.toUpperCase()))),
  HOME: home, USERPROFILE: home, DSH_HOME: home, LUMOS_API_KEY: 'test-only',
})
const control = (profile: string) => join(home, 'service', 'control', 'profiles', profile)
const logs = () => join(home, 'service', 'logs')
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
beforeEach(async () => {
  fallbackServer = createServer(request => request.socket.destroy())
  await new Promise<void>(resolve => fallbackServer.listen(0, '127.0.0.1', resolve))
  fallbackUrl = `http://127.0.0.1:${(fallbackServer.address() as AddressInfo).port}`
  root = mkdtempSync(join(tmpdir(), 'service script '))
  home = join(root, 'home')
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin')); mkdirSync(home)
  // The copied script is an ES module; give its temporary checkout the same package type as the repository.
  writeFileSync(join(root, 'package.json'), '{ "type": "module" }\n')
  copyFileSync(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent'), join(root, 'scripts', 'dsh-superagent'))
  copyFileSync(join(import.meta.dirname, '..', 'scripts', 'superagent-lifecycle-lock.ps1'), join(root, 'scripts', 'superagent-lifecycle-lock.ps1'))
  copyFileSync(join(import.meta.dirname, '..', 'scripts', 'runtime-paths.ps1'), join(root, 'scripts', 'runtime-paths.ps1'))
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
  program('lsof', 'exit 2')
})
afterEach(() => {
  fallbackServer.close()
  server?.close(); server = undefined
  for (const child of sleepers) child.kill()
  sleepers = []
  rmSync(root, { recursive: true, force: true })
})
function runWithEnvironment(environment: NodeJS.ProcessEnv, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  if (args.some(arg => arg.startsWith('--url=')) || args.filter(arg => arg === '--url').length > 1) {
    throw new Error('Test commands must use one explicit --url argument')
  }
  const urlIndex = args.indexOf('--url')
  const url = urlIndex < 0 ? fallbackUrl : args[urlIndex + 1]
  const activeServerUrl = server?.listening ? `http://127.0.0.1:${(server.address() as AddressInfo).port}` : undefined
  if (!url || (url !== activeServerUrl && (url !== fallbackUrl || !fallbackServer.listening))) throw new Error(`Test target is not an active owned endpoint: ${url}`)
  if (urlIndex < 0) args.push('--url', url)
  return new Promise(resolve => execFile(process.execPath, [join(root, 'scripts', 'dsh-superagent'), ...args, '--home', home],
    { env: { ...testEnvironment(), PATH: `${join(root, 'bin')}:${process.env.PATH}`, DSH_SUPERAGENT_PROFILE: '', DSH_SUPERAGENT_URL: '', ...environment },
      timeout: 20_000 },
    (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : error ? 1 : 0, stdout, stderr })))
}
const run = (...args: string[]) => runWithEnvironment({}, ...args)
it('refuses lifecycle commands aimed at endpoints not owned by the test', () => {
  expect(() => run('stop', '--url', 'http://127.0.0.1:3082')).toThrow('not an active owned endpoint')
  expect(() => run('restart', '--url', 'http://127.0.0.1:3082')).toThrow('not an active owned endpoint')
  expect(() => run('stop', `--url=${fallbackUrl}`, '--url', 'http://127.0.0.1:3082')).toThrow('one explicit --url')
  expect(() => run('stop', '--url', fallbackUrl, '--url', 'http://127.0.0.1:3082')).toThrow('one explicit --url')
})
it('sends stop requests to a held mock endpoint', async () => {
  const requests: { method?: string; url?: string; header?: string }[] = []
  server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, header: String(request.headers['x-orchestrator-request']) })
    response.writeHead(requests.length === 1 ? 200 : 503).end()
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const { stopRequest } = await import(pathToFileURL(join(root, 'scripts', 'dsh-superagent')).href) as {
    stopRequest: (url: string) => Promise<{ status: number; body: string } | null>
  }
  expect(await stopRequest(url)).toMatchObject({ status: 200 })
  expect(await stopRequest(url)).toMatchObject({ status: 503 })
  expect(requests).toEqual(Array.from({ length: 2 }, () => ({ method: 'POST', url: '/orchestrator/api/service/stop', header: '1' })))
})
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
const status = async (profile: string, url = fallbackUrl) =>
  JSON.parse((await run('status', '--profile', profile, '--url', url)).stdout) as
    { pids: number[]; manually_stopped: boolean; listener: number[] | null; unlistening: number[]; foreign: { pid: number }[] }

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
  const log = new RegExp(`>> '${logs().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/dsh-superagent-superagent-\\d{8}-\\d{6}-\\d+\\.log' 2>&1$`)
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
  mkdirSync(logs(), { recursive: true })
  for (const profile of ['superagent', 'other']) for (let index = 0; index < 25; index++) {
    const log = join(logs(), `dsh-superagent-${profile}-20260901-0000${String(index).padStart(2, '0')}-1.log`)
    writeFileSync(log, '')
    utimesSync(log, 1_700_000_000 + index, 1_700_000_000 + index)
  }
  writeFileSync(join(logs(), 'dsh-superagent-20260901-000000-1.log'), '')
  expect(await run('start', '--url', url, '--timeout', '10')).toMatchObject({ code: 0 })
  const entries = readdirSync(logs())
  const own = entries.filter(name => name.startsWith('dsh-superagent-superagent-')).sort()
  expect(own).toHaveLength(20)
  // The oldest went; the new one stays, with the newest earlier ones. Another profile's logs and older names stay.
  expect(own).not.toContain('dsh-superagent-superagent-20260901-000000-1.log')
  expect(own.filter(name => !name.startsWith('dsh-superagent-superagent-20260901-'))).toHaveLength(1)
  expect(entries.filter(name => name.startsWith('dsh-superagent-other-'))).toHaveLength(25)
  expect(entries).toContain('dsh-superagent-20260901-000000-1.log')
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
    record: m.parseArgv(['watchdog', 'run', '--note', 'No signals']),
    runs: m.parseArgv(['watchdog', 'runs', '--limit', '5']),
    report: m.parseArgv(['watchdog', 'report', '--chat', 'oc_team', '--note', 'Stalled']),
    verify: m.parseArgv(['verify', '--survival-seconds', '5', '--profile', 'one']),
    stopDefault: m.parseArgv(['stop', '--profile', 'one']),
    stopUrl: m.parseArgv(['stop', '--profile', 'one', '--url', 'http://127.0.0.1:3999']),
    quote: [m.quoteWindowsArg('a b'), m.quoteWindowsArg('a"b'), m.quoteWindowsArg('C:\\\\a b\\\\'), m.quoteWindowsArg('')],
    outside: m.outsideJobStartCommand({ shell: 'C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe',
      wrapper: 'C:\\\\a b\\\\scripts\\\\service-start.ps1', checkout: 'C:\\\\a b', environmentFile: 'C:\\\\c\\\\e.json',
      home: 'C:\\\\h', profile: 'superagent', url: 'http://127.0.0.1:3083', timeout: 60, log: 'C:\\\\c\\\\l.log' }),
    listeners: [m.parseListenerPids('[75240]'), m.parseListenerPids('[]'), m.parseListenerPids('123 456'), m.parseListenerPids('not json')],
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
  const value = JSON.parse(out) as { ps: unknown[]; windows: unknown[]; start: unknown; socket: string; command: string; argv: Record<string, unknown>; watchdog: Record<string, unknown>; record: Record<string, unknown>; runs: Record<string, unknown>; report: Record<string, unknown>; verify: Record<string, unknown>; stopDefault: Record<string, unknown>; stopUrl: Record<string, unknown>; quote: string[]; outside: string; listeners: unknown[]; serves: boolean[] }
  expect(value.ps).toEqual([{ pid: 123, name: 'node', args: ['node', '/opt/my', 'tools/dsh', '--profile', 'superagent', '--no-open'] }])
  expect(value.windows).toEqual([{ pid: 7, name: 'node', args: ['node', '/opt/dsh', '--profile', 'superagent', '--no-open'] },
    { pid: 9, name: 'deepseek harness', args: ['D:\\app\\DeepSeek', 'Harness.exe', '--expose-internals', 'D:\\app\\cli.js', '--profile', 'superagent', '--no-open'] }])
  expect(value.start).toEqual({ file: '"C:\\Program Files\\dsh.cmd"', args: ['--profile', 'superagent', '--no-open'], shell: true })
  expect(value.socket).toBe('dsh-superagent-f063ff9f0c5ba70eeebc')
  expect(value.command).toBe("umask 077; export DSH_HOME=/tmp/home; unset HOME; export PATH=/usr/bin; unset TMUX TMUX_PANE; exec /opt/dsh --profile superagent --no-open >> '/tmp/log file.log' 2>&1")
  expect(value.argv).toMatchObject({ action: 'start', profile: 'one', timeout: 5, respect_stop: true })
  expect(value.watchdog).toMatchObject({ action: 'watchdog', stale_minutes: 7, url: 'http://127.0.0.1:1' })
  expect(value.record).toMatchObject({ action: 'watchdog', watchdog_action: 'run', note: 'No signals' })
  expect(value.runs).toMatchObject({ action: 'watchdog', watchdog_action: 'runs', limit: 5 })
  expect(value.report).toMatchObject({ action: 'watchdog', watchdog_action: 'report', chat: 'oc_team', note: 'Stalled' })
  expect(value.verify).toMatchObject({ action: 'verify', profile: 'one', survival_seconds: 5 })
  expect(value.stopDefault).toMatchObject({ action: 'stop', profile: 'one', profile_explicit: true, url_explicit: false })
  expect(value.stopUrl).toMatchObject({ action: 'stop', url_explicit: true })
  expect(value.quote).toEqual(['"a b"', '"a\\"b"', '"C:\\a b\\\\"', '""'])
  // Paths with spaces are quoted; the arguments are the wrapper's fixed set.
  expect(value.outside).toBe('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -NoProfile -NonInteractive -File '
    + '"C:\\a b\\scripts\\service-start.ps1" -Checkout "C:\\a b" -EnvFile C:\\c\\e.json -DshHome C:\\h -Profile superagent '
    + '-Url http://127.0.0.1:3083 -Timeout 60 -Log C:\\c\\l.log')
  expect(value.listeners).toEqual([[75240], [], [123, 456], null])
  // A control invocation of this script carries --profile too, but only the DSH launcher is the service.
  expect(value.serves).toEqual([false, false, false, true, false])
})
it('discovers a superagent server from its management state and resolves one stop target', async () => {
  const module = pathToFileURL(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent')).href
  const script = `import(${JSON.stringify(module)}).then(async m => {
    const records = [
      { pid: 10, name: 'node', args: ['node', '/opt/dsh', '--profile', 'superagent', '--no-open'] },
      { pid: 11, name: 'node', args: ['node', '/opt/dsh', '--profile', 'desktop', '--no-open'] },
      { pid: 12, name: 'node', args: ['node', '/x/scripts/dsh-superagent', '--profile', 'superagent', 'start'] }
    ]
    const portsOf = pid => pid === 10 ? [3999] : pid === 11 ? [3998] : []
    const probe = async url => url.endsWith(':3999')
      ? { health: { runtime: 'ready', assessment: 'ready' } }
      : { health: { runtime: 'ready' } }
    const servers = await m.discoverServers(records, portsOf, probe)
    const other = { pid: 13, profile: 'other', port: 4000, url: 'http://127.0.0.1:4000' }
    const same = { pid: 14, profile: 'superagent', port: 4001, url: 'http://127.0.0.1:4001' }
    console.log(JSON.stringify({
      servers,
      sole: m.chooseServer(servers, { profile: 'superagent' }),
      fallback: m.chooseServer([other], { profile: 'superagent' }),
      explicitMiss: m.chooseServer([other], { profile: 'superagent', profileExplicit: true }) ?? null,
      ambiguous: m.chooseServer([...servers, same], { profile: 'superagent' }) ?? null,
      byUrl: m.chooseServer([...servers, other], { url: 'http://127.0.0.1:4000', profile: 'superagent', urlExplicit: true }),
      states: [m.isSuperagentState({ health: { assessment: 'ready' } }), m.isSuperagentState({ health: { runtime: 'ready' } })],
      profiles: [m.profileFromArgs(['node', '/opt/dsh', '--profile', 'one']), m.profileFromArgs(['node', '/opt/dsh', '--profile=two'])],
      ports: [m.parsePorts('[3083]'), m.parsePorts('n127.0.0.1:3083')]
    }))
  })`
  const out = await new Promise<string>((resolve, reject) => execFile(process.execPath, ['-e', script],
    (error, stdout) => error ? reject(error) : resolve(stdout)))
  const value = JSON.parse(out) as {
    servers: { pid: number; profile: string; port: number; url: string }[]
    sole: { pid: number } | null; fallback: { pid: number } | null; explicitMiss: unknown; ambiguous: unknown; byUrl: { pid: number } | null
    states: boolean[]; profiles: (string | undefined)[]; ports: number[][]
  }
  expect(value.servers).toEqual([{ pid: 10, profile: 'superagent', port: 3999, url: 'http://127.0.0.1:3999',
    health: { runtime: 'ready', assessment: 'ready' } }])
  expect(value.sole).toMatchObject({ pid: 10 })
  expect(value.fallback).toMatchObject({ pid: 13 })
  expect(value.explicitMiss).toBeNull()
  expect(value.ambiguous).toBeNull()
  expect(value.byUrl).toMatchObject({ pid: 13 })
  expect(value.states).toEqual([true, false])
  expect(value.profiles).toEqual(['one', 'two'])
  expect(value.ports).toEqual([[3083], [3083]])
})
it.skipIf(process.platform !== 'win32')('reads Job ownership from the probe rather than plain membership', async () => {
  const module = pathToFileURL(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent')).href
  const script = `import(${JSON.stringify(module)}).then(m => console.log(JSON.stringify([
    m.processJobFacts(1, () => 'none'),
    m.processJobFacts(1, () => 'own'),
    m.processJobFacts(1, () => 'foreign'),
    m.processJobFacts(1, () => 'unknown'),
    m.processJobFacts(1, () => { throw new Error('no PowerShell') })
  ])))`
  const out = await new Promise<string>((resolve, reject) => execFile(process.execPath, ['-e', script],
    (error, stdout) => error ? reject(error) : resolve(stdout)))
  expect(JSON.parse(out)).toEqual([
    { inJob: false, foreignJob: false },
    { inJob: true, foreignJob: false },
    { inJob: true, foreignJob: true },
    null,
    null
  ])
})
it('reads the deployment facts from the profile home for a release preflight', async () => {
  const home = join(root, 'home')
  const profileDir = join(home, 'profiles', 'superagent')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(home, 'service.ps1'), '# service control\n')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: dsh-superagent\n  config:\n    stateDir: /srv/dsh-superagent/state\n')
  const module = pathToFileURL(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent')).href
  const script = `import(${JSON.stringify(module)}).then(m => console.log(JSON.stringify(m.deploymentFacts('superagent', ${JSON.stringify(home)}))))`
  const out = await new Promise<string>((resolve, reject) => execFile(process.execPath, ['-e', script],
    (error, stdout) => error ? reject(error) : resolve(stdout)))
  const value = JSON.parse(out) as Record<string, unknown>
  expect(value).toMatchObject({ profile: 'superagent', home, profileDir, serviceScript: join(home, 'service.ps1'),
    stateDir: '/srv/dsh-superagent/state', bundleLink: join(profileDir, 'node_modules', 'dsh-superagent'),
    git: { head: expect.stringMatching(/^[0-9a-f]{40}$/), branch: expect.any(String), dirty: expect.any(Boolean) } })
  // The profile home is also a parse-time option, and no other status field is disturbed by it.
  expect(JSON.parse(await new Promise<string>((resolve, reject) => execFile(process.execPath, ['-e',
    `import(${JSON.stringify(module)}).then(m => console.log(JSON.stringify(m.parseArgv(['status'], { DSH_HOME: ${JSON.stringify(home)} }))))`],
  (error, stdout) => error ? reject(error) : resolve(stdout))))).toMatchObject({ home, profile: 'superagent' })
})
it('discovers loopback servers without process command lines', async () => {
  const module = pathToFileURL(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent')).href
  const script = `import(${JSON.stringify(module)}).then(async m => {
    const listeners = m.parseWindowsListeners(' TCP 127.0.0.1:3101 0.0.0.0:0 LISTENING 101\\n TCP [::1]:3101 [::]:0 LISTENING 101\\n TCP 0.0.0.0:3102 0.0.0.0:0 LISTENING 102\\n TCP 10.1.2.3:3103 0.0.0.0:0 LISTENING 103\\n TCP 127.0.0.1:3104 0.0.0.0:0 LISTENING 104')
    const calls = []
    const found = await m.discoverLoopbackServers(listeners, async url => {
      calls.push(url)
      return url.endsWith(':3104') ? { health: { runtime: 'ready' } } : { health: { assessment: 'ready' } }
    })
    console.log(JSON.stringify({ pids: found.map(server => server.pid).sort(), profiles: found.map(server => server.profile ?? null), calls: calls.sort() }))
  })`
  const out = await new Promise<string>((resolve, reject) => execFile(process.execPath, ['-e', script],
    (error, stdout) => error ? reject(error) : resolve(stdout)))
  expect(JSON.parse(out)).toEqual({ pids: [101, 102], profiles: [null, null], calls: [
    'http://127.0.0.1:3101', 'http://127.0.0.1:3102', 'http://127.0.0.1:3104', 'http://[::1]:3101',
  ] })
})
it('selects a discovered server only when its profile control records match its PID', async () => {
  const module = pathToFileURL(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent')).href
  const script = `import(${JSON.stringify(module)}).then(m => {
    const candidates = [{ pid: 101, url: 'http://127.0.0.1:3101' }, { pid: 102, url: 'http://127.0.0.1:3102' }]
    const controls = { actual: [101], second: [102], duplicate: [101, 102] }
    const find = (server, home) => home === '/test' && controls[server.profile]?.includes(server.pid) ? {} : undefined
    const select = (servers, profile) => {
      try { return m.selectRecordedServer(servers, profile, '/test', find) } catch (error) { return error.message }
    }
    console.log(JSON.stringify({ actual: select(candidates, 'actual'), wrong: select([candidates[0]], 'wrong'),
      absent: select(candidates, 'missing'), duplicate: select(candidates, 'duplicate'), original: candidates }))
  })`
  const out = await new Promise<string>((resolve, reject) => execFile(process.execPath, ['-e', script],
    (error, stdout) => error ? reject(error) : resolve(stdout)))
  const result = JSON.parse(out)
  expect(result.actual).toMatchObject({ pid: 101, profile: 'actual' })
  expect(result.wrong).toContain('pass --url')
  expect(result.absent).toContain('pass --url')
  expect(result.duplicate).toContain('pass --url')
  expect(result.original).toEqual([{ pid: 101, url: 'http://127.0.0.1:3101' }, { pid: 102, url: 'http://127.0.0.1:3102' }])
})
it('does not mistake an inaccessible process for an exited process', async () => {
  const module = pathToFileURL(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent')).href
  const script = `import(${JSON.stringify(module)}).then(m => {
    const failure = code => () => { throw Object.assign(new Error(code), { code }) }
    const calls = []
    const running = m.alive(123, (...args) => calls.push(args))
    let unexpected
    try { m.alive(123, failure('EIO')) } catch (error) { unexpected = error.code }
    console.log(JSON.stringify({ running, denied: [m.alive(123, failure('EPERM')), m.alive(123, failure('EACCES'))],
      exited: m.alive(123, failure('ESRCH')), unexpected, calls }))
  })`
  const out = await new Promise<string>((resolve, reject) => execFile(process.execPath, ['-e', script],
    (error, stdout) => error ? reject(error) : resolve(stdout)))
  expect(JSON.parse(out)).toEqual({ running: true, denied: [true, true], exited: false, unexpected: 'EIO', calls: [[123, 0]] })
})
it('identifies Windows listeners using unprivileged netstat output', async () => {
  const module = pathToFileURL(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent')).href
  const script = `import(${JSON.stringify(module)}).then(m => {
    const calls = []
    const run = (...args) => { calls.push(args); return { status: 0, stdout: '  TCP    127.0.0.1:3083  0.0.0.0:0 LISTENING 123\\r\\n  TCP    [::1]:3083 [::]:0 LISTENING 123\\r\\n  TCP    127.0.0.1:4000 0.0.0.0:0 LISTENING 456\\r\\n  TCP    127.0.0.1:5000 127.0.0.1:80 ESTABLISHED 123' } }
    const failed = () => ({ status: 1, stderr: 'denied' })
    console.log(JSON.stringify({ listeners: m.listenerPids('http://127.0.0.1:3083', run, 'win32'),
      ports: m.portsForPid(123, run, 'win32'), failure: m.listenerPids('http://127.0.0.1:3083', failed, 'win32'),
      calls }))
  })`
  const out = await new Promise<string>((resolve, reject) => execFile(process.execPath, ['-e', script],
    (error, stdout) => error ? reject(error) : resolve(stdout)))
  const value = JSON.parse(out)
  expect(value.listeners).toEqual([123])
  expect(value.ports).toEqual([3083])
  expect(value.failure).toBeNull()
  expect(value.calls[0]).toEqual(['netstat.exe', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true }])
})
it('lists Windows service processes through a hidden PowerShell window', async () => {
  const module = pathToFileURL(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent')).href
  const rows = [{ ProcessId: 7, Name: 'node.exe', CommandLine: 'node x --profile superagent' }]
  const script = `import(${JSON.stringify(module)}).then(m => {
    const calls = []
    const run = (...args) => { calls.push(args); return { status: 0, stdout: ${JSON.stringify(JSON.stringify(rows))} } }
    console.log(JSON.stringify({ value: m.windowsProcesses(run), options: calls[0][2] }))
  })`
  const out = await new Promise<string>((resolve, reject) => execFile(process.execPath, ['-e', script],
    (error, stdout) => error ? reject(error) : resolve(stdout)))
  expect(JSON.parse(out)).toEqual({
    value: [{ pid: 7, name: 'node', args: ['node', 'x', '--profile', 'superagent'] }],
    options: { encoding: 'utf8', windowsHide: true },
  })
})
it('restricts a Windows log through hidden helper processes', async () => {
  const module = pathToFileURL(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent')).href
  const log = join(root, 'protected.log')
  const identity = 'DESKTOP-MAX\\dd,S-1-5-21-1-2-3-1001'
  const script = `import(${JSON.stringify(module)}).then(m => {
    const calls = []
    let answer = ${JSON.stringify(identity)}
    const run = (...args) => { calls.push(args); const stdout = answer; answer = ''; return { status: 0, stdout } }
    m.restrictWindowsLog(${JSON.stringify(log)}, run)
    console.log(JSON.stringify(calls))
  })`
  const out = await new Promise<string>((resolve, reject) => execFile(process.execPath, ['-e', script],
    (error, stdout) => error ? reject(error) : resolve(stdout)))
  const calls = JSON.parse(out) as [string, string[], { windowsHide?: boolean }][]
  expect(calls.map(([program]) => program)).toEqual(['whoami.exe', 'icacls.exe'])
  expect(calls.map(([, , options]) => options.windowsHide)).toEqual([true, true])
})
it.skipIf(process.platform !== 'win32')('runs a non-interactive node entry point in a hidden window and keeps its exit code', async () => {
  const background = join(root, 'background.mjs')
  const pidFile = join(root, 'background.pid')
  writeFileSync(background, [
    "import { writeFileSync } from 'node:fs'",
    `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
    'setTimeout(() => process.exit(7), 4000)',
  ].join('\n'))
  const launcher = join(import.meta.dirname, '..', 'scripts', 'launch-hidden.vbs')
  const child = spawn('wscript.exe', [launcher, process.execPath, background], { stdio: 'ignore' })
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve))
  try {
    const deadline = Date.now() + 10_000
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
    expect(existsSync(pidFile)).toBe(true)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    const window = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).MainWindowHandle`],
      { encoding: 'utf8' }).trim()
    expect(window).toBe('0')
  } finally {
    await exited
  }
  expect(await exited).toBe(7)
}, 20_000)
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
it.skipIf(process.platform !== 'win32')('restricts Windows service log access before launch', async () => {
  const log = join(root, 'protected.log')
  writeFileSync(log, '')
  const module = pathToFileURL(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent')).href
  const script = `import(${JSON.stringify(module)}).then(m => m.restrictWindowsLog(${JSON.stringify(log)}))`
  await new Promise<void>((resolve, reject) => execFile(process.execPath, ['-e', script], error => error ? reject(error) : resolve()))
  const query = `(Get-Acl -LiteralPath '${log.replaceAll("'", "''")}').AreAccessRulesProtected`
  const protectedAcl = execFileSync('pwsh', ['-NoProfile', '-Command', query], { encoding: 'utf8' }).trim()
  expect(protectedAcl).toBe('True')
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
it('still honors a stop marker written before control files moved into the home', async () => {
  const legacy = join(root, '.artifacts', 'control', 'profiles', 'legacy')
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, 'manually-stopped'), '2026-11-09T00:00:00+0800\n')
  expect(await status('legacy')).toMatchObject({ manually_stopped: true, pids: [] })
})
it.skipIf(process.platform !== 'win32')('wraps the control script with a pinned machine configuration', async () => {
  const entry = join(import.meta.dirname, '..', 'scripts', 'dsh-superagent.ps1')
  const profile = 'entry-test'
  mkdirSync(join(home, 'profiles', profile), { recursive: true })
  const config = join(root, 'service.json')
  writeFileSync(config, JSON.stringify({ checkout: root, home, profile, url: fallbackUrl, node: process.execPath }))
  const call = (args: string[], environment: NodeJS.ProcessEnv = {}) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    execFile('pwsh', ['-NoProfile', '-File', entry, ...args], { timeout: 30_000, env: { ...testEnvironment(), ...environment } },
      (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : error ? 1 : 0, stdout, stderr }))
  })
  const checked = await call(['-Action', 'status', '-Config', config])
  expect(checked.code).toBe(1)
  expect(JSON.parse(checked.stdout)).toMatchObject({ pids: [], profile, url: fallbackUrl })
  const remoteConfig = join(root, 'remote-service.json')
  writeFileSync(remoteConfig, JSON.stringify({ checkout: root, home, profile, url: 'http://10.0.0.1:3083', node: process.execPath }))
  const remote = await call(['-Action', 'status', '-Config', remoteConfig])
  expect(remote.code).toBe(1)
  expect(remote.stderr).toContain('loopback')
  const missing = await call(['-Action', 'status', '-Config', join(root, 'missing.json')])
  expect(missing.code).toBe(1)
  expect(missing.stderr).toContain('does not exist')

  // A stop without a configured URL lets the control script discover the server; a configured URL stays exact.
  const entryCheckout = join(root, 'entry-checkout')
  mkdirSync(join(entryCheckout, 'scripts'), { recursive: true })
  writeFileSync(join(entryCheckout, 'scripts', 'dsh-superagent'), 'console.log(JSON.stringify(process.argv.slice(2)))\n')
  const discoveryConfig = join(root, 'discovery-service.json')
  writeFileSync(discoveryConfig, JSON.stringify({ checkout: entryCheckout, home, profile }))
  const stopDefault = await call(['-Action', 'stop', '-Config', discoveryConfig], { DSH_SUPERAGENT_URL: '' })
  expect(stopDefault.code).toBe(0)
  expect(JSON.parse(stopDefault.stdout)).toContain('stop')
  expect(JSON.parse(stopDefault.stdout)).not.toContain('--url')
  const stopConfig = join(root, 'stop-service.json')
  writeFileSync(stopConfig, JSON.stringify({ checkout: entryCheckout, home, profile, url: 'http://127.0.0.1:4000' }))
  const stopConfigured = await call(['-Action', 'stop', '-Config', stopConfig])
  expect(stopConfigured.code).toBe(0)
  expect(JSON.parse(stopConfigured.stdout)).toEqual(expect.arrayContaining(['--url', 'http://127.0.0.1:4000']))
  // The simplest form: one action word, with the machine configuration selected by environment.
  const zeroArg = await call(['stop'], { DSH_SUPERAGENT_SERVICE_CONFIG: stopConfig })
  expect(zeroArg.code).toBe(0)
  expect(JSON.parse(zeroArg.stdout)).toEqual(expect.arrayContaining(['stop', '--url', 'http://127.0.0.1:4000']))
}, 60_000)
it('prints the Watchdog snapshot over GET and refuses an unreachable service', async () => {
  const requests: { method?: string; url?: string; header?: string }[] = []
  server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, header: String(request.headers['x-orchestrator-request']) })
    response.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ at: '2026-11-07T01:00:00.000Z', staleMinutes: 15, open: 1, tickets: [{ id: 't1', signals: ['no-progress'] }],
        state: { paused: false }, lastRun: null }))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  const watched = await run('watchdog', '--url', url, '--stale-minutes', '15')
  expect(watched.code).toBe(0)
  expect(JSON.parse(watched.stdout)).toMatchObject({ profile: 'superagent', url, staleMinutes: 15, open: 1, tickets: [{ id: 't1' }] })
  // The command is read-only: one GET, no settings or prompt call.
  expect(requests).toEqual([{ method: 'GET', url: '/orchestrator/api/watchdog?stale_minutes=15', header: '1' }])
  expect(await run('watchdog', '--url', fallbackUrl)).toMatchObject({ code: 1,
    stderr: expect.stringContaining('No management API answer') })
  expect(await run('watchdog', '--stale-minutes', '0')).toMatchObject({ code: 1,
    stderr: expect.stringContaining('--stale-minutes must be an integer between 1 and 1440') })
})
/** A snapshot row the CLI reads for the Watchdog summary and run record. */
function watchdogTicket(fields: Record<string, unknown> = {}) {
  return { id: 't1', title: 'Fix the build', stage: 'person', action: 'failed', silentMinutes: 90, signals: ['waiting-person'],
    lastReport: { state: 'failed', summary: 'The build broke', at: '2026-11-07T00:00:00.000Z', ageMinutes: 90 },
    attempts: ['failed'], ...fields }
}
it('asks the server to send the Watchdog observation summary to a Feishu chat', async () => {
  const calls: { method?: string; url?: string; body?: string; header?: string }[] = []
  server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      calls.push({ method: request.method, url: request.url, body, header: String(request.headers['x-orchestrator-request']) })
      response.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ sent: true, at: '2026-11-07T00:00:00.000Z', chatId: 'oc_team', text: '**Watchdog 观察汇总**' }))
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  const report = await run('watchdog', 'report', '--chat', 'oc_team', '--note', 'No report for 90 minutes', '--url', url)
  expect(report.code).toBe(0)
  expect(JSON.parse(report.stdout)).toMatchObject({ sent: true, chatId: 'oc_team' })
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ method: 'POST', url: '/orchestrator/api/watchdog/report', header: '1' })
  const body = JSON.parse(calls[0]!.body!) as { chatId: string; note: string; idempotencyKey: string }
  expect(body).toMatchObject({ chatId: 'oc_team', note: 'No report for 90 minutes' })
  expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
  // A report takes no ticket, needs a chat id and sends nothing when either check fails.
  expect(await run('watchdog', 'report', '--url', url)).toMatchObject({ code: 1, stderr: expect.stringContaining('needs --chat') })
  expect(await run('watchdog', 'report', '--chat', 'team', '--url', url)).toMatchObject({ code: 1,
    stderr: expect.stringContaining('--chat must be a Feishu chat id') })
  expect(await run('watchdog', 'report', 't1', '--chat', 'oc_team', '--url', url)).toMatchObject({ code: 1,
    stderr: expect.stringContaining('unexpected argument') })
  expect(calls).toHaveLength(1)
})

it('asks the service for one bounded recovery and exits non-zero when it is refused', async () => {
  const calls: { method?: string; url?: string; body?: string; header?: string }[] = []
  let result = 'executed'
  server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      calls.push({ method: request.method, url: request.url, body, header: String(request.headers['x-orchestrator-request']) })
      response.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ id: 'r1', idempotency: 'key', at: '2026-11-07T01:00:00.000Z', ticketId: 't1',
          sessionId: 'worker-t1', action: 'retry', reason: 'Session missing', snapshotAt: '2026-11-07T01:00:00.000Z', result }))
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  const executed = await run('watchdog', 'recover', '--ticket', 't1', '--reason', 'Session missing',
    '--snapshot-at', '2026-11-07T01:00:00.000Z', '--url', url)
  expect(executed.code).toBe(0)
  expect(JSON.parse(executed.stdout)).toMatchObject({ result: 'executed', ticketId: 't1' })
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ method: 'POST', url: '/orchestrator/api/watchdog/recoveries', header: '1' })
  expect(JSON.parse(calls[0]!.body!)).toMatchObject({ ticketId: 't1', action: 'retry', reason: 'Session missing',
    snapshotAt: '2026-11-07T01:00:00.000Z' })
  expect((JSON.parse(calls[0]!.body!) as { idempotencyKey: string }).idempotencyKey).toMatch(/^watchdog-recovery-t1-/)
  result = 'refused'
  const refused = await run('watchdog', 'recover', '--ticket', 't1', '--reason', 'Session missing',
    '--snapshot-at', '2026-11-07T01:00:00.000Z', '--idempotency-key', 'recover-key', '--url', url)
  expect(refused.code).toBe(1)
  expect(JSON.parse(calls[1]!.body!)).toMatchObject({ idempotencyKey: 'recover-key' })
  expect(await run('watchdog', 'recover', '--ticket', 't1', '--url', url)).toMatchObject({ code: 1,
    stderr: expect.stringContaining('needs --reason') })
})

it('records an observation run and prints recent runs', async () => {
  const calls: { method?: string; url?: string; body?: string; header?: string }[] = []
  server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      calls.push({ method: request.method, url: request.url, body, header: String(request.headers['x-orchestrator-request']) })
      if (request.method === 'POST') {
        const value = JSON.parse(body) as { note: string; idempotencyKey: string }
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'watchdog-run-1',
          idempotency: value.idempotencyKey, at: '2026-11-07T00:00:00.000Z', paused: false, open: 1, flagged: 1,
          note: value.note, text: '**Watchdog 观察汇总**' }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ runs: [{ id: 'watchdog-run-1' }] }))
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  const recorded = await run('watchdog', 'run', '--note', 'One stuck Ticket', '--url', url)
  expect(recorded.code).toBe(0)
  expect(JSON.parse(recorded.stdout)).toMatchObject({ open: 1, flagged: 1, note: 'One stuck Ticket' })
  const posts = calls.filter(call => call.method === 'POST')
  expect(posts).toHaveLength(1)
  expect(posts[0]).toMatchObject({ method: 'POST', url: '/orchestrator/api/watchdog/runs', header: '1' })
  const body = JSON.parse(posts[0]!.body!) as { note: string; idempotencyKey: string }
  expect(body).toMatchObject({ note: 'One stuck Ticket' })
  expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
  const listed = await run('watchdog', 'runs', '--limit', '5', '--url', url)
  expect(listed.code).toBe(0)
  expect(JSON.parse(listed.stdout)).toMatchObject({ runs: [{ id: 'watchdog-run-1' }] })
  expect(calls.at(-1)).toMatchObject({ method: 'GET', url: '/orchestrator/api/watchdog/runs?limit=5', header: '1' })
  // A run takes no positional argument and both commands reject invalid input before any request.
  expect(await run('watchdog', 'run', 't1', '--url', url)).toMatchObject({ code: 1,
    stderr: expect.stringContaining('unexpected argument') })
  expect(await run('watchdog', 'run', '--note', 'x'.repeat(501), '--url', url)).toMatchObject({ code: 1,
    stderr: expect.stringContaining('--note must be at most 500 characters') })
  expect(await run('watchdog', 'runs', '--limit', '0', '--url', url)).toMatchObject({ code: 1,
    stderr: expect.stringContaining('--limit must be an integer between 1 and 100') })
})

it('reports a management API refusal from the report route', async () => {
  server = createServer((_request, response) => {
    response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'The Feishu Source is off' }))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  expect(await run('watchdog', 'report', '--chat', 'oc_team', '--url', url)).toMatchObject({ code: 1,
    stderr: expect.stringContaining('The Feishu Source is off') })
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
  expect(await run('start', '--url', fallbackUrl, '--timeout', '2'))
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
