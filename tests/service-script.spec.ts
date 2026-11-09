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
    record: m.parseArgv(['watchdog', 'run', '--note', 'No signals']),
    runs: m.parseArgv(['watchdog', 'runs', '--limit', '5']),
    report: m.parseArgv(['watchdog', 'report', '--chat', 'oc_team', '--note', 'Stalled']),
    verify: m.parseArgv(['verify', '--survival-seconds', '5', '--profile', 'one']),
    quote: [m.quoteWindowsArg('a b'), m.quoteWindowsArg('a"b'), m.quoteWindowsArg('C:\\\\a b\\\\'), m.quoteWindowsArg('')],
    outside: m.outsideJobStartCommand({ shell: 'C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe',
      wrapper: 'C:\\\\a b\\\\scripts\\\\service-start.ps1', checkout: 'C:\\\\a b', environmentFile: 'C:\\\\c\\\\e.json',
      profile: 'superagent', url: 'http://127.0.0.1:3083', timeout: 60, log: 'C:\\\\c\\\\l.log' }),
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
  const value = JSON.parse(out) as { ps: unknown[]; windows: unknown[]; start: unknown; socket: string; command: string; argv: Record<string, unknown>; watchdog: Record<string, unknown>; record: Record<string, unknown>; runs: Record<string, unknown>; report: Record<string, unknown>; verify: Record<string, unknown>; quote: string[]; outside: string; serves: boolean[] }
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
  expect(value.quote).toEqual(['"a b"', '"a\\"b"', '"C:\\a b\\\\"', '""'])
  // Paths with spaces are quoted; the arguments are the wrapper's fixed set.
  expect(value.outside).toBe('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -NoProfile -NonInteractive -File '
    + '"C:\\a b\\scripts\\service-start.ps1" -Checkout "C:\\a b" -EnvFile C:\\c\\e.json -Profile superagent '
    + '-Url http://127.0.0.1:3083 -Timeout 60 -Log C:\\c\\l.log')
  // A control invocation of this script carries --profile too, but only the DSH launcher is the service.
  expect(value.serves).toEqual([false, false, false, true, false])
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
it('reports the deployment facts from the profile home for a release preflight', async () => {
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
it.skipIf(process.platform !== 'win32')('proves a service created outside every foreign Job survives and verify notices its loss', async () => {
  const serviceDirectory = mkdtempSync(join(tmpdir(), 'verify service '))
  const profile = `p1verify${process.pid}`
  const portFile = join(serviceDirectory, 'port.txt')
  const entry = join(serviceDirectory, 'entry.js')
  writeFileSync(entry, `import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
const ready = { health: { runtime: { state: 'ready', detail: '' } }, setup: { problem: null, feishuProblem: null } }
const server = createServer((request, response) => {
  if (request.url?.startsWith('/orchestrator/api/state')) {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(ready))
    return
  }
  response.writeHead(404).end()
})
server.listen(0, '127.0.0.1', () => writeFileSync(${JSON.stringify(portFile)}, String(server.address().port)))
// A long-running service spawns children (the Feishu event consumer is one) and joins the Job Node creates for them.
spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' })
setInterval(() => {}, 60_000)
`)
  const controlScript = join(import.meta.dirname, '..', 'scripts', 'dsh-superagent')
  const module = pathToFileURL(controlScript).href
  const run = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, args, { timeout: 60_000 }, (error, stdout, stderr) =>
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr }))
  })
  let servicePid: number | undefined
  try {
    // Ask the WMI provider for the service process: a DSH tool command's Job must not own it.
    const startScript = `import(${JSON.stringify(module)}).then(m => {
      const commandLine = [process.execPath, ${JSON.stringify(entry)}, '--profile', ${JSON.stringify(profile)}, '--no-open']
        .map(m.quoteWindowsArg).join(' ')
      console.log(m.createOutsideJob(commandLine, ${JSON.stringify(serviceDirectory)}))
    })`
    try {
      servicePid = Number((await new Promise<string>((resolve, reject) => {
        execFile(process.execPath, ['--input-type=module', '-e', startScript], (error, stdout) => error ? reject(error) : resolve(stdout))
      })).trim())
    } catch (error) {
      // A host that cannot create a process through WMI cannot deploy this way either; do not pretend to check it.
      console.warn('WMI process creation is unavailable; the Job escape could not be checked', error)
      return
    }
    expect(servicePid).toBeGreaterThan(0)
    let port = 0
    for (let attempt = 0; attempt < 100 && !port; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      try { port = Number(readFileSync(portFile, 'utf8')) } catch { /* The service has not listened yet. */ }
    }
    expect(port).toBeGreaterThan(0)
    const url = `http://127.0.0.1:${port}`
    const verified = await run([controlScript, 'verify', '--profile', profile, '--url', url, '--survival-seconds', '1'])
    expect(verified).toMatchObject({ code: 0, stderr: '' })
    // Node puts the service into its own Job when it spawns a child; only a Job it merely inherited may fail the check.
    expect(JSON.parse(verified.stdout)).toMatchObject({ ok: true, pid: servicePid, inJob: true, foreignJob: false, survivalSeconds: 1 })
    process.kill(servicePid!)
    const stopped = servicePid!
    servicePid = undefined
    for (let attempt = 0; attempt < 50; attempt++) {
      try { process.kill(stopped, 0) } catch { break }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const lost = await run([controlScript, 'verify', '--profile', profile, '--url', url, '--survival-seconds', '0'])
    expect(lost.code).toBe(1)
    expect(lost.stderr).toContain('Expected exactly one running service')
  } finally {
    if (servicePid) { try { process.kill(servicePid) } catch { /* It already exited. */ } }
    rmSync(serviceDirectory, { recursive: true, force: true })
    rmSync(join(import.meta.dirname, '..', '.artifacts', 'control', 'profiles', profile), { recursive: true, force: true })
  }
}, 45_000)
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
  expect(await run('watchdog', '--url', 'http://127.0.0.1:9')).toMatchObject({ code: 1,
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
