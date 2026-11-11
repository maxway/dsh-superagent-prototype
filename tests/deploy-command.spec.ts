import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { deploymentConfig, requestDeployment } from '../src/app/deployment.ts'

let directory: string | undefined
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

it('reads the deploy request path and an optional wakeup command', () => {
  expect(deploymentConfig({})).toBeUndefined()
  expect(deploymentConfig({ DSH_SUPERAGENT_DEPLOY_REQUEST: 'C:\\watchdog\\deploy-request.json' }))
    .toEqual({ requestPath: 'C:\\watchdog\\deploy-request.json' })
  expect(deploymentConfig({ DSH_SUPERAGENT_DEPLOY_REQUEST: ' C:\\watchdog\\deploy-request.json ',
    DSH_SUPERAGENT_DEPLOY_COMMAND: ' schtasks /run /tn dsh-superagent-deploy ' }))
    .toEqual({ requestPath: 'C:\\watchdog\\deploy-request.json', command: 'schtasks /run /tn dsh-superagent-deploy' })
})

it('writes the operator request atomically and starts the independent deployment task', async () => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-deploy-'))
  const requestPath = join(directory, 'deploy-request.json')
  const marker = join(directory, 'started.txt')
  const command = `node -e "require('fs').writeFileSync(process.argv[1], 'started')" "${marker}"`
  const request = await requestDeployment({ requestPath, command }, '部署superagent', new Date('2026-11-09T01:00:00Z'))

  expect(JSON.parse(readFileSync(requestPath, 'utf8'))).toEqual({
    at: '2026-11-09T01:00:00.000Z', requestedBy: 'superagent-main', confirmation: '部署superagent', target: 'latest' })
  expect(readFileSync(marker, 'utf8')).toBe('started')
  expect(request).toMatchObject({ confirmation: '部署superagent', target: 'latest' })
})

it('queues a request without a scheduler command for the standing Watchdog', async () => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-deploy-'))
  const requestPath = join(directory, 'deploy-request.json')
  const request = await requestDeployment({ requestPath }, '部署最新版本')
  expect(JSON.parse(readFileSync(requestPath, 'utf8'))).toEqual(request)
})

it('keeps the request and reports a failing deployment command', async () => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-deploy-'))
  const requestPath = join(directory, 'deploy-request.json')
  await expect(requestDeployment({ requestPath, command: 'node -e "process.exit(3)"' }, '部署superagent'))
    .rejects.toThrow(/The deployment command failed/)
  expect(existsSync(requestPath)).toBe(true)
})