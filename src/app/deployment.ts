/** The main Session's single channel to the independent Watchdog: one explicit deploy request at a time. */
import { exec } from 'node:child_process'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Where the request goes and how the independent deployment task is started; unset disables the deploy command. */
export interface DeploymentConfig {
  /** The Watchdog request file the independent deployment task reads, such as C:\Users\me\.dsh\watchdog\deploy-request.json. */
  requestPath: string
  /** The command that starts the independent deployment task, such as `schtasks /run /tn dsh-superagent-deploy`. */
  command: string
}

/** The request the superagent writes for the Watchdog; the Watchdog, not this process, performs the release. */
export interface DeployRequest {
  at: string
  requestedBy: string
  /** The operator's exact instruction, the authorization the Watchdog verifies before it releases. */
  confirmation: string
  target: 'latest'
}

/** Read the deploy configuration from the environment; without both values the superagent cannot request a deployment. */
export function deploymentConfig(env: NodeJS.ProcessEnv = process.env): DeploymentConfig | undefined {
  const requestPath = env.DSH_SUPERAGENT_DEPLOY_REQUEST?.trim()
  const command = env.DSH_SUPERAGENT_DEPLOY_COMMAND?.trim()
  return requestPath && command ? { requestPath, command } : undefined
}

/**
 * Write the operator's request atomically and start the independent deployment task. The request is what the Watchdog
 * verifies and releases; this process only sends it, so the main instance never releases or restarts itself.
 */
export async function requestDeployment(config: DeploymentConfig, confirmation: string, now = new Date()): Promise<DeployRequest> {
  const request: DeployRequest = { at: now.toISOString(), requestedBy: 'superagent-main', confirmation, target: 'latest' }
  mkdirSync(dirname(config.requestPath), { recursive: true, mode: 0o700 })
  const temporary = `${config.requestPath}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, config.requestPath)
  await new Promise<void>((resolve, reject) => {
    exec(config.command, { timeout: 15_000, windowsHide: true }, error => {
      if (error) reject(new Error(`The deployment command failed: ${error.message}`))
      else resolve()
    })
  })
  return request
}