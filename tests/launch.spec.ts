import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { launch } from '../src/infra/launch.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'launch-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** The npm Windows shim for `@larksuite/cli`, which names its Node entry relative to `%dp0%`. */
const npmShim = (entry: string): string => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${entry}" %*\r\n`

describe('launch', () => {
  it('leaves POSIX commands alone', () => {
    expect(launch(['/home/me/bin/lark-cli', 'event', 'consume'], 'linux')).toEqual({ program: '/home/me/bin/lark-cli', args: ['event', 'consume'] })
    expect(launch(['lark-cli', 'api', 'x'], 'darwin')).toEqual({ program: 'lark-cli', args: ['api', 'x'] })
  })
  it('leaves native Windows executables and unknown extensions alone', () => {
    expect(launch(['C:\\tools\\glab.exe', 'api', 'user'], 'win32')).toEqual({ program: 'C:\\tools\\glab.exe', args: ['api', 'user'] })
    expect(launch(['git', 'status'], 'win32')).toEqual({ program: 'git', args: ['status'] })
  })
  it('runs a Node entry with this process\'s Node executable', () => {
    const script = join(dir, 'run.js')
    writeFileSync(script, '')
    expect(launch([script, 'event', 'consume'], 'win32')).toEqual({ program: process.execPath, args: [script, 'event', 'consume'] })
  })
  it('resolves an npm .cmd shim to its Node entry without going through cmd.exe', () => {
    const shim = join(dir, 'lark-cli.cmd')
    writeFileSync(shim, npmShim('..\\@larksuite\\cli\\scripts\\run.js'))
    const entry = join(dir, '..', '@larksuite', 'cli', 'scripts', 'run.js')
    expect(launch([shim, 'event', 'consume', 'im.message.receive_v1', '--as', 'bot'], 'win32'))
      .toEqual({ program: process.execPath, args: [entry, 'event', 'consume', 'im.message.receive_v1', '--as', 'bot'] })
  })
  it('resolves the %~dp0 spelling and forward slashes', () => {
    const shim = join(dir, 'tool.cmd')
    writeFileSync(shim, '@ECHO off\r\n"%~dp0" "%~dp0/scripts/tool.mjs" %*\r\n')
    expect(launch([shim, 'a'], 'win32')).toEqual({ program: process.execPath, args: [join(dir, 'scripts', 'tool.mjs'), 'a'] })
  })
  it('refuses a .cmd without a Node entry rather than quoting arguments through a shell', () => {
    const shim = join(dir, 'wrapper.cmd')
    writeFileSync(shim, '@ECHO off\r\ncall "C:\\tools\\gh.exe" %*\r\n')
    expect(() => launch([shim], 'win32')).toThrow('without a Node entry')
  })
  it('does not try to read a .cmd on POSIX', () => {
    const shim = join(dir, 'missing.cmd')
    expect(launch([shim, 'a'], 'linux')).toEqual({ program: shim, args: ['a'] })
  })
})