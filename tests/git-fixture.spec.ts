import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)

it('isolates inherited Git configuration and paths while allowing local clones and explicit overrides', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'git-fixture-'))
  const template = join(directory, 'template')
  const hooks = join(template, 'hooks')
  const config = join(directory, 'host-config')
  const source = join(directory, 'source')
  const clone = join(directory, 'clone')
  const git = async (...args: string[]) => (await exec('git', args, { cwd: directory, env: gitEnv(), windowsHide: true })).stdout.trim()
  try {
    mkdirSync(hooks, { recursive: true })
    writeFileSync(join(hooks, 'post-checkout'), '#!/bin/sh\nexit 1\n')
    chmodSync(join(hooks, 'post-checkout'), 0o755)
    await git('config', '--file', config, 'init.templateDir', template)
    await git('config', '--file', config, 'core.hooksPath', hooks)
    await git('config', '--file', config, 'url.invalid://host/.insteadOf', source)
    vi.stubEnv('GIT_CONFIG_GLOBAL', config)
    vi.stubEnv('GIT_CONFIG_SYSTEM', config)
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '0')
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.hooksPath')
    vi.stubEnv('GIT_CONFIG_VALUE_0', hooks)
    vi.stubEnv('GIT_CONFIG_PARAMETERS', 'invalid')
    vi.stubEnv('GIT_TEMPLATE_DIR', template)
    vi.stubEnv('GIT_DIR', join(directory, 'foreign-git'))
    vi.stubEnv('GIT_OBJECT_DIRECTORY', join(directory, 'foreign-objects'))
    vi.stubEnv('GIT_CEILING_DIRECTORIES', directory)
    vi.stubEnv('GIT_EXEC_PATH', join(directory, 'foreign-exec'))
    const env = gitEnv()
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.GIT_OBJECT_DIRECTORY).toBeUndefined()
    expect(env.GIT_CEILING_DIRECTORIES).toBeUndefined()
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined()
    await git('init', '-q', source)
    await git('-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'initial')
    await git('clone', '-q', source, clone)
    expect(existsSync(join(source, '.git', 'hooks', 'post-checkout'))).toBe(false)
    expect(existsSync(join(clone, '.git', 'hooks', 'post-checkout'))).toBe(false)
    expect((await git('-C', clone, 'remote', 'get-url', 'origin')).replaceAll('\\', '/')).toBe(source.replaceAll('\\', '/'))
    const explicit = await exec('git', ['config', '--global', '--get', 'core.hooksPath'], {
      cwd: directory, env: gitEnv({ GIT_CONFIG_GLOBAL: config }), windowsHide: true,
    })
    expect(explicit.stdout.trim().replaceAll('\\', '/')).toBe(hooks.replaceAll('\\', '/'))
  } finally {
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
  }
})
