import { expect, it, vi } from 'vitest'
import { promisify } from 'node:util'

const execute = vi.hoisted(() => vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '' }))

vi.mock('node:child_process', () => {
  const execFile = Object.assign(() => {}, { [promisify.custom]: execute })
  return { execFile }
})

import { Commands } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'

it('hides the window when running a background CLI command', async () => {
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  await expect(commands.run(process.execPath, ['--version'])).resolves.toBe('ok')
  expect(execute).toHaveBeenCalledWith(process.execPath, ['--version'], expect.objectContaining({ windowsHide: true }))
})
