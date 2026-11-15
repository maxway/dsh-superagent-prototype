# Windows runtime deployment

The Superagent runtime is separate from its source checkout and managed repositories. The current implementation is a deployment candidate, not an installed one-command upgrade. An explicit deployment request authorizes its necessary stop; a normal successful deployment should not need a separate confirmation or manual test.

## Direct deployment

`scripts/deploy-runtime-local.ps1` reads `deploy-runtime.local.json` alongside it and invokes `deploy-direct.ps1`. The configuration names the source repository, remote and ref, runtime root, service configuration, Node, Git and pnpm; `examples/deploy-runtime.local.windows.json` is a template. Run the entry from an independent operator session with these files available. An explicit deployment request includes the stop and restart; no second confirmation is needed.

The entry fetches the configured ref, exports the fetched commit into a new release directory, installs dependencies and builds it, then stops the configured service, switches `current` and starts it. Uncommitted changes are not deployed. It does not rerun tests, perform a separate staging acceptance, or invoke the older artifact preparation and activation workflow. Command failures stop the deployment; there is no automatic rollback. If switching or starting fails, inspect `current` and the service output before recovery. Restarting can interrupt work and lose Feishu messages. Trust the configured source, dependency registry and install scripts.

This is a repository implementation, not a claim that the local production host has installed or run it. The previous `deploy-runtime.ps1`, preparation and activation scripts remain available as a separate candidate workflow; their journal and validation restrictions do not apply to the direct entry.

## Current local runtime

The local service uses `F:\dsh-superagent-runtime\current` and `F:\dsh-superagent-runtime\config\service.json`, retaining its existing home, profile, database and Source credentials. Previously installed deployment tasks and their user-level wakeup variables were removed with operator authorization; the old checkout deployment scripts are not suited to this runtime. Already-running processes or WMI providers may retain inherited values, so explicitly set `DSH_SUPERAGENT_DEPLOY_REQUEST` and `DSH_SUPERAGENT_DEPLOY_COMMAND` to empty when starting the installed runtime.

A candidate release, its control scripts and a replacement deployment entry have not been installed. Do not change the running service for tests. Use a separate profile, home, state, port and credentials for candidate validation, with Feishu disabled.
