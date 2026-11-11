import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export function createDeploymentPoller({ checkout, deployConfig, intervalMs = 5000, onEvent = () => {} }) {
  if (!checkout || !deployConfig) throw new Error('checkout and deployConfig are required')
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('intervalMs must be positive')
  const configPath = resolve(deployConfig)
  let timer
  let active
  const emit = event => { try { onEvent(event) } catch {} }

  async function consume() {
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    if (typeof config.requestPath !== 'string' || !config.requestPath.trim() || typeof config.resultFile !== 'string' || !config.resultFile.trim()) {
      throw new Error('requestPath and resultFile are required')
    }
    const serviceHome = config.serviceHome || config.home || process.env.DSH_HOME || join(homedir(), '.dsh')
    const serviceConfig = config.serviceConfig ? resolve(config.serviceConfig) : join(resolve(serviceHome), 'service.json')
    let service = {}
    try { service = JSON.parse(await readFile(serviceConfig, 'utf8')) } catch (error) {
      if (config.serviceConfig || error.code !== 'ENOENT') throw error
    }
    const executor = join(resolve(config.checkout || service.checkout || checkout), 'scripts', 'deploy.mjs')
    const requestPath = resolve(config.requestPath)
    let request
    try { request = await readFile(requestPath) } catch (error) {
      if (error.code === 'ENOENT') return { status: 'idle' }
      throw error
    }
    const digest = createHash('sha256').update(request).digest('hex')
    const marker = `${resolve(config.resultFile)}.watchdog-${digest}.attempt`
    await mkdir(dirname(marker), { recursive: true })
    let claim
    try { claim = await open(marker, 'wx') } catch (error) {
      if (error.code === 'EEXIST') return { status: 'already-attempted', digest }
      throw error
    }
    emit({ status: 'started', digest })
    const resultPromise = new Promise(resolvePromise => {
      const child = spawn(process.execPath, [executor, '--config', configPath], {
        windowsHide: true, detached: true, stdio: ['ignore', 'ignore', claim.fd],
        env: { ...process.env, DSH_WATCHDOG_REQUEST_SHA256: digest },
      })
      child.unref()
      child.once('error', error => resolvePromise({ status: 'failed', digest, error: error.message }))
      child.once('close', async code => {
        const stderr = await readFile(marker, 'utf8').catch(() => '')
        if (code === 0) resolvePromise({ status: 'exited', digest, code })
        else if (stderr.startsWith('deploy_locked:')) resolvePromise({ status: 'locked', digest, error: stderr.trim() })
        else resolvePromise({ status: 'failed', digest, code, error: stderr.slice(-8192).trim() })
      })
    })
    await claim.close()
    const result = await resultPromise
    if (result.status === 'locked') await unlink(marker)
    emit(result)
    return result
  }

  function poll() {
    if (active) return active
    active = consume().catch(error => {
      const result = { status: 'error', error: error.message }
      emit(result)
      return result
    }).finally(() => { active = undefined })
    return active
  }

  return {
    poll,
    start() {
      if (!timer) {
        void poll()
        timer = setInterval(() => { void poll() }, intervalMs)
        timer.unref()
      }
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
    },
  }
}
