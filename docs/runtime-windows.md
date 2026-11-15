# Windows runtime deployment

The Superagent runtime is separate from its source checkout and managed repositories. The current implementation is a deployment candidate, not an installed one-command upgrade. An explicit deployment request authorizes its necessary stop; a normal successful deployment should not need a separate confirmation or manual test.

## Candidate workflow

`scripts/deploy-runtime-local.ps1` reads `deploy-runtime.local.json` from its independent control directory and invokes `deploy-runtime.ps1`. The configuration pins the bare source repository, remote and ref, runtime root, service configuration, Node, Git and pnpm. `examples/deploy-runtime.local.windows.json` is a template; its source and tool paths are placeholders, not verified local settings.

The coordinator fetches the configured ref, builds the selected commit in isolation, prepares a new release and then requests activation. It does not build uncommitted worktree changes. Its scripts and configuration must be installed separately from the runtime; the configured ref must contain the builder. It records interrupted activation and refuses a new attempt until the failure is investigated.

The candidate currently cannot upgrade a running service: its profile link check does not prove which release the process loaded, so it refuses to stop the service. The coordinator checks for a stopped service before fetching or building, but this is only a snapshot: if a service starts afterward, activation still refuses to stop it and can leave `deploy-runtime.json` at `activation-started`, requiring investigation. This is an implemented restriction, not a general prohibition on an explicitly requested deployment. The link target, listener PID, command line and start record do not by themselves prove the loaded release. The currently installed process has no process-bound loaded-release evidence; a future design needs evidence captured by the loaded service and a stop bound to the same process generation. Ordinary start and legacy recovery do not enforce the activation journal; after an incomplete activation inspect the process, journal, links and data before recovery. There is no automatic rollback.

Preparation installs the locked dependency tree in a new release with lifecycle scripts disabled and checks imports before activation. The package-file hashes do not independently authenticate the dependency tree, source or toolchain. The complete production dependency graph has not been verified.

## Current local runtime

The local service uses `F:\dsh-superagent-runtime\current` and `F:\dsh-superagent-runtime\config\service.json`, retaining its existing home, profile, database and Source credentials. Previously installed deployment tasks and their user-level wakeup variables were removed with operator authorization; scripts in the stable checkout were not changed and must not be used for this runtime. Already-running processes or WMI providers may retain inherited values, so explicitly set `DSH_SUPERAGENT_DEPLOY_REQUEST` and `DSH_SUPERAGENT_DEPLOY_COMMAND` to empty when starting the installed runtime.

A candidate release, its control scripts and a replacement deployment entry have not been installed. Do not change the running service for tests. Use a separate profile, home, state, port and credentials for candidate validation, with Feishu disabled.
