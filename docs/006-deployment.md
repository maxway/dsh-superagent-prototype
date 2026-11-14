# 006 Deployment

Use this guide to install, configure and operate dsh-superagent. It covers accounts, startup checks, upgrades and troubleshooting, building on [001 Domain model](001-domain.md) through [005 Panel](005-panel.md).

## Production host for this checkout

The intended production host is native Windows, using the stable checkout at `F:\code\dsh-superagent-prototype` and a DSH home separate from Desktop. A different profile alone does not isolate workspace and session storage. On 2026-11-08 the operator authorized a cutover to `C:\Users\dd\.dsh-superagent`, with `DSH_AGENTS_HOME` set to its `agents` subdirectory. The versioned entry `scripts\dsh-superagent.ps1` reads a machine configuration from `%USERPROFILE%\.dsh-superagent\service.json` outside the checkout and pins the checkout, DSH home, profile, loopback URL, Node path, optional PATH additions and deployment request/command; a generic invocation without that file can start against the shared Desktop home. `C:\Users\dd\.dsh-superagent\service.ps1` remains the compatibility entry for the operator's existing tools; after cutover it should be reduced to a shim that passes `-Config` to the versioned entry. The existing dedicated state directory remains at `C:\Users\dd\.dsh\state\superagent`, outside the new home. Startup reported runtime and Feishu ready, with GitLab starting; workspace and session recovery and end-to-end behavior were not independently verified after cutover at the operator's request. This separation is not an OS security boundary. The profile links the bundle directly to the F: checkout; do not rename that checkout to match the package name. Use the Windows profile example in `examples/profile.cordis.patch.yml`; the POSIX / WSL example remains in `examples/profile.posix.cordis.patch.yml` for a separately managed deployment. Historical WSL state and worktrees are not Windows worker directories and must not be pruned or resumed on Windows.

**Historical service isolation (2026-11-06).** Production reached ready with GitLab and Feishu before exiting. A recovered worker ran `tmux kill-server` while sharing a server with a test panel; logs and isolated reproduction strongly indicate inherited `TMUX` selected the shared socket, but the historical client's socket and exit signal were not recorded. The service was isolated and its profile and prepare command pointed to the F: checkout. The old ticket was stopped, its changes were pushed to GitLab branch `stage1-node/windows-deploy-stage2-a14b20f9bf4f`, and its former WSL worktree and clone were removed; its historical session still names the missing directory and cannot be assumed resumable. Recheck live facts before acting.

The service's logs and control files are under `<DSH home>\service\`. During the Windows upgrade, the old checkout `.artifacts\` location remains readable for the stop marker, recorded PID and start facts; stopping a legacy-recorded service writes its marker there. Windows and WSL must not share a dependency tree.

A Windows process cannot safely rely on WSL-created dependency links in a shared checkout. Prepare and verify a complete Windows dependency installation at the final path with the production service stopped and other users of that dependency tree quiesced. A pnpm `Already up to date` message is not proof: build and import the actual bundle with Windows Node, then require `GET /orchestrator/api/state` with `x-orchestrator-request: 1` to return 200 and check Source health. A listening web port alone is insufficient. Keep WSL and Windows dependency trees separate when both are needed. When running in the background, also verify the service and Feishu consumer have no visible console and the token-bearing startup log is accessible only to the intended user and administrators.

## What runs

- **A dedicated DeepSeek Harness profile**, called `superagent` in this guide. Create it from the Web profile template. It loads the bundle and serves its panel on `127.0.0.1`. Keep it separate from the profile you work in: the plugin changes process-wide `PATH` and git settings, and its process needs independent restarts and upgrades.
- **An agent GitHub account.** The agent comments, pushes branches and opens pull requests as this account, through a GitHub CLI signed in only as that account.
- **Optional:** a Feishu bot for chat requests.

Plugin configuration holds the state directory and machine limits. Use the panel for everything else: Sources for the repository and accounts, Policy for allowed lists, and Execution for worker directories and commands.

Windows hosts are supported for the Git Sources and the Feishu Source at prototype quality. The Windows paths for service control, the worker command layer, the prepare command and the router tools are implemented. The test suite runs in CI on a project Windows runner and passes with documented POSIX-only skips; a real Windows start/status/stop/restart smoke passes, and a real ticket on a scratch GitLab project has completed the end-to-end flow: Issue, Ticket, prepare, PowerShell worker, commit, push, merge request and source reply. Feishu is supported through the npm `lark-cli` `.cmd` shim, which the host resolves to its Node entry and runs without a shell; the Windows test suite covers that path. A live bot was not enabled on the scratch host, which must not receive Feishu credentials. Workers and the router use the `pwsh` tool instead of `bash` there, and the prepare command runs through PowerShell 7. Where a step below differs on Windows, its Windows form is given.

### Permissions and isolation

The bundle defines `dsh-superagent-worker` for Executors and `dsh-superagent-router` for the main Session. They appear in the DeepSeek Harness preset list but are intended only for dsh-superagent. Do not select them for personal Sessions or disable their configuration rows. The application needs them to create and resume its Sessions.

Opening a blank managed Session in the Web UI can select the profile's default preset. dsh-superagent restores its role-specific preset before the first turn.

Both presets run with `danger-full-access` as the operator's OS user and read messages from subscribed Threads. Account wrappers choose the agent's credentials by default; they do not isolate the process. A worker can execute programs by path and read the operator's home directory. For isolation, use a dedicated OS account containing only the agent's credentials. On Windows the same applies with no OS sandbox: the `.cmd` shims only block commands, so use a dedicated Windows account that holds only the agent's credentials and repository access. The Windows path has passed an end-to-end run on a scratch project and its suite runs in CI; the isolation caveat remains.

## Prerequisites

- Node.js 24.9+, pnpm and git 2.32+ (Git for Windows on a Windows host). POSIX also needs tmux; Windows needs PowerShell 7 (`pwsh`) and has no tmux or Python requirement.
- GitHub CLI (`gh`) 2.48 or later for a GitHub deployment, or GitLab CLI (`glab`) for a GitLab deployment. Source CLI fields must point to the agent CLI's command name or absolute path (`gh`, `glab` or `lark-cli`; on POSIX usually a wrapper script); the host relies on their subcommands and output formats.
- **Windows host:** the native `gh.exe` or `glab.exe`, signed in to the agent account as Windows credentials below describes. Do not use a `.cmd` wrapper.
- A repository on github.com, or a GitLab project on gitlab.com or a self-managed instance. GitHub Enterprise Server is not supported. To create a checkout per Ticket, keep a local clone from which the prepare command can add worktrees. Install `git-lfs` if that repository uses Git LFS.
- A model provider configured for DeepSeek Harness. dsh-superagent uses the profile's default model unless the Eval or Execution settings name another. Configure it in the deployment profile itself; that profile does not inherit the credentials or provider configuration of the profile you work in, and without a provider it reports a missing credential and cannot assess requests.
- For Feishu: `lark-cli` (tested with 1.0.90) and a Feishu or Lark app with a bot. On Windows install the npm package `@larksuite/cli`; the host resolves its `.cmd` shim to the package's Node entry.

## Accounts

### Agent GitHub account

1. Create a GitHub user account for the agent and give it write access to the repository. A GitHub App cannot be the agent, because dsh-superagent reads the account's notifications.
2. Give it a GitHub CLI that uses only its own credentials:

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
   EOF
   chmod +x ~/.local/bin/gh-agent
   gh-agent auth login
   gh-agent api user --jq .login
   ```

   Sign in as the agent account; the last command prints its login. dsh-superagent reads the login the same way. On Windows, use the native CLI and its configuration directory instead of this wrapper; see Windows credentials below.

### Agent GitLab account (GitLab deployments)

1. Create a GitLab user account for the agent and give it at least the Developer role on the project; the GitLab Free plan's Developer role can push branches and open merge requests. The optional GitLab webhook also needs the Maintainer role.
2. Give it a GitLab CLI that uses only its own credentials:

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/glab-agent <<'EOF'
   #!/bin/sh
   GLAB_CONFIG_DIR="$HOME/.config/glab-agent" exec glab "$@"
   EOF
   chmod +x ~/.local/bin/glab-agent
   glab-agent auth login --hostname gitlab.example.com
   glab-agent api user
   ```

   Use the self-managed host, not `gitlab.com`. The same host and protocol must be set on the GitLab Source: `https://gitlab.example.com`, or `http://gitlab.example.com` for an instance served over HTTP; the worker's git credential helper then uses that protocol. `glab auth git-credential` needs a glab version that provides it (1.36 or newer); check with `glab-agent auth git-credential --help` and update glab if the command is missing. If the instance uses a private certificate authority, teach glab and the worker's git to trust it (for git, set `GIT_SSL_CAINFO` in the service environment or install the CA in the OS trust store). On Windows, use the native CLI and its configuration directory instead of this wrapper; see Windows credentials below.

3. A deployment has one active Git Source. In the profile's `cordis.patch.yml`, install both Git Source plugins (`dsh-superagent-github` and `dsh-superagent-gitlab`) so either can be configured and made active from the panel; a profile that installs only one still works. In **Sources**, configure the Git Source you use now. The Sources page shows the active host and repository; to move to the other host, configure its card and choose **Switch to this source**.

Switching is one action: dsh-superagent checks the target account and repository, then restarts once. If the old host still has open Tickets, the switch lists them and waits for an explicit confirmation or their stop. A Ticket records the Git host it was accepted under, so it cannot resume on another host: a resume there is reported failed, and switching back lets it continue. The state directory keeps both hosts' records, and switching back reuses them.

### Windows credentials

A Windows host selects the agent account with a configuration directory instead of a wrapper script. Do not write a `.cmd` wrapper for `gh` or `glab`: it would forward every argument through `cmd.exe` and corrupt JSON and message text. Sign the native CLI in to the agent account with its configuration directory, then set the same directory in the Source's **Agent account configuration directory** advanced field; leaving the field empty uses the default shown below. Set the Source's `cli` field to the native executable, `gh` or `glab`, not a `.cmd` wrapper. The plugin and its workers inherit the directory, so both act as the same account.

GitHub:

```powershell
$env:GH_CONFIG_DIR = "$env:USERPROFILE\.config\gh-agent"
gh auth login
gh api user --jq .login
```

GitLab:

```powershell
$env:GLAB_CONFIG_DIR = "$env:USERPROFILE\.config\glab-agent"
glab auth login --hostname gitlab.example.com
glab api user
```

### GitLab webhook (optional)

The GitLab Source polls every `pollSeconds` (60 by default), so a change waits up to one polling interval. When the deployment host has a stable address that GitLab can reach (usually a fixed IP or a fixed hostname), GitLab events can wake one sync immediately and cut that latency to seconds; without it the Source keeps polling.

1. Enter the full address GitLab can reach in the Source's **Webhook URL**, for example `http://192.168.1.20:3084/gitlab/webhook`. Its path is the listening path. The advanced **Webhook listening port** (default 3084) and **Webhook listening address** (default `0.0.0.0`) choose the local listener; when a reverse proxy terminates HTTPS, put the proxy's address in the Webhook URL and keep this local port.
2. The agent account needs the project's **Maintainer** role, because only that role manages project hooks. After the settings are saved, the Source creates or updates that project hook on its next poll (usually within a minute) and subscribes it to Issue, merge request, note and pipeline events; dsh-superagent generates the token and keeps it in the state directory, so nothing is entered in GitLab by hand.
3. Allow only GitLab through the firewall to this port. The listener accepts POST only on the configured path and answers 401 for a wrong token; it does not parse the payload, it makes the next polling round start at once, so polling and the API reads remain the only data source. When the address is a private IP, the self-managed GitLab must also allow outbound requests to the local network (and this address) in its admin area, or it refuses delivery.
4. `pollSeconds` remains the fallback: without the webhook, or when GitLab disables it or its configuration fails, the Source keeps polling; a configuration failure appears in the Source's health and is retried every five minutes. Clearing **Webhook URL** disables and deletes the project hook this Source created.

### Feishu bot (optional)

On Windows the npm `lark-cli` is a `.cmd`. The host resolves the shim's `%dp0%` Node entry and runs it with Node, so message text and JSON never pass through `cmd.exe`. A `.cmd` without a Node entry is refused; use the npm package or a native executable rather than a custom wrapper.

1. Create a self-built app with the bot capability. Grant it the permissions to receive message events and to send messages as the bot, then publish the app version. It needs no permission to read messages, chat history, chats or chat members: the Source works from the event payload and replies only. The removed read paths called APIs that require `im:message`, `im:message:readonly` and `im:message.history:readonly` for messages, and `im:chat`, `im:chat:readonly`, `im:chat.group_info:readonly`, `im:chat:read` and `im:chat.members:read` for chats and members; this build does not call them. It therefore cannot recover messages sent while dsh-superagent was offline, cannot read a message or Thread by ID, cannot list chats or sync members, and cannot read images (see **Images and screenshots** below). Enter chat IDs and the allowed list by hand. Choosing **All** for a group additionally needs Feishu's permission to receive every group message; without it only messages that mention the bot arrive.
2. Give the bot its own `lark-cli` configuration, restricted to the bot identity. On POSIX, also create a wrapper:

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   On Windows install the package and point the Source's **Bot lark-cli** field at `lark-cli` (the npm `.cmd` shim) and its advanced configuration directory at `%USERPROFILE%\.lark-cli-dsh-superagent`:

   ```powershell
   npm install -g @larksuite/cli
   $env:LARKSUITE_CLI_CONFIG_DIR = "$env:USERPROFILE\.lark-cli-dsh-superagent"
   lark-cli config init --app-id <cli_…> --app-secret-stdin
   lark-cli config strict-mode bot --global
   ```

   The first command reads the app secret from standard input (`Get-Content secret.txt | lark-cli config init ...` in PowerShell). Use a separate configuration directory: `lark-cli` allows one profile per app id, and your personal configuration may already contain a user login for that app.

   The host refuses a CLI that can act as a user. It reads the app id, Feishu/Lark brand and bot `open_id` from the bot configuration.

   Both configurations share the keychain entry for the app secret. To remove only the bot configuration, delete its directory; do not run `lark-cli config remove`, which would affect the shared secret.

**Images and screenshots.** The bot cannot download images. A download would need `im:resource` for `GET /open-apis/im/v1/images/:image_key`, or `im:message:readonly` (or `im:message.history:readonly`) for a message resource. This self-built app has neither: an image-upload probe reported `im:resource` missing, and the message-resource download answered `99991672` with `im:message.history:readonly`/`im:message:readonly`/`im:message`. The operator confirmed on 2026-11-09 that neither scope can be granted. A live event therefore carries only its rendered text, where an image appears as an `![Image]` marker carrying an `img_…` key; the agent sees that marker, not the screenshot. A rich-text message that mentions the bot and contains an image still arrives, but only its text is readable. Ask the sender to describe the image in text, or to send the request as text. This is a deployment limitation, not a Source setting: if the app later gains one of those scopes, an image download path can be added.

## Install

Run this block once, on a machine that has no `superagent` profile yet:

```sh
npm install -g @deepseek-ai/dsh@0.2.2-rc.1
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

The pinned version above is public; other versions must satisfy `engines.dsh` in `package.json`.

The fourth command creates `~/.dsh/profiles/superagent` from the DeepSeek Harness Web template. The fifth installs this bundle. Set `DSH_HOME` to relocate the default `~/.dsh` directory.

On Windows, run the same block in PowerShell with `> $null` in place of `> /dev/null`; `$PWD` is the checkout's native path, so the installed link is `link:C:\...\dsh-superagent`. `dsh` is the npm `.cmd` shim, and the profile lives under `%USERPROFILE%\.dsh\profiles\superagent` unless `DSH_HOME` relocates it.

Run the profile-creation command only for a new installation. If the profile already exists, that command replaces it and deletes its `cordis.patch.yml`, including machine configuration. Do not use it for upgrades.

## Machine configuration

Copy [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) to `~/.dsh/profiles/superagent/cordis.patch.yml`, replacing that file, and replace every `<placeholder>`. On Windows the profile is `%USERPROFILE%\.dsh\profiles\superagent\cordis.patch.yml`. For Feishu, also enable the `dsh-superagent-feishu` entry there. The `webserver` entry sets the panel's port.

| Key | Required | Meaning |
| --- | --- | --- |
| `stateDir` | yes | Native absolute path: the database, the lock, the command shims in `worker-bin`, the agent's git configuration and, by default, the Ticket directories in `work`. On POSIX, for example `/home/me/.dsh/state/superagent`; on Windows, for example `C:\Users\me\.dsh\state\superagent`. A WSL path is not native to a Windows host. Back it up before upgrades |
| `promptMaxChars`, `admissionContextMaxPages`, `admissionContextTimeoutMs` | no | The largest saved prompt configuration, and how many Thread pages one assessment reads within what time |

After the first start, edit machine limits in **Settings → Deployment** or the DeepSeek Harness Plugin Manager. Changes apply without restart. `stateDir` cannot be changed there. Invalid values or unknown configuration keys prevent startup; the log identifies the key.

## Start and stop

On Windows the versioned entry is the operator command. It reads a machine configuration outside the checkout, so the
target cannot drift with the current directory or an unrelated environment variable:

```powershell
pwsh scripts\dsh-superagent.ps1 status
pwsh scripts\dsh-superagent.ps1 start
pwsh scripts\dsh-superagent.ps1 stop
pwsh scripts\dsh-superagent.ps1 restart
```

It reads `%USERPROFILE%\.dsh-superagent\service.json` unless `-Config` or `DSH_SUPERAGENT_SERVICE_CONFIG` names another
file; `examples/service.windows.json` is a template. The file pins `checkout`, `home`, `agentsHome`, `profile`, the
loopback `url`, the `node` executable, optional `path` additions and the optional `deployRequest`/`deployCommand`, and it
holds no secret. A start also needs the user-level `LUMOS_API_KEY`, which the wrapper copies from the user environment.
The entry exposes only the action (plus optional `-Config` and `-RespectStop`); target and timing facts stay in the
file. It refuses a checkout that does not exist or a non-loopback URL; ordinary `start` and `restart` update and build the latest code before starting.

After cutover, replace the old hard-coded `C:\Users\dd\.dsh-superagent\service.ps1` with a compatibility shim so existing
tools keep working:

```powershell
param([ValidateSet('start', 'stop', 'restart', 'status', 'verify')][string]$Action = 'status')
& 'F:\code\dsh-superagent-prototype\scripts\dsh-superagent.ps1' $Action -Config "$env:USERPROFILE\.dsh-superagent\service.json"
exit $LASTEXITCODE
```

For a simple Windows deployment from an independent operator session, `pwsh scripts\restart-superagent.ps1` sends the stop request to the configured loopback URL, waits for the port to close, pulls `origin/main`, installs locked dependencies, builds and starts the service. Pass `-Config <path>` to select another service configuration. It does not control Watchdog or ask a model to decide. A failed stop, pull, install or build prevents the subsequent start. Before stopping, the script checks the listener against the configured profile and the recorded service PID, and refuses foreign or other matching processes; it checks again that no target process or listener remains before updating. If process identity cannot be established, it stops rather than guessing. These checks are not an OS isolation boundary. A restart of an existing build alone is not a latest-code deployment.

The Node script remains the implementation and is available on both platforms when the environment is already set:

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

On Windows that is `node scripts\dsh-superagent start` and the same actions; `node` is required because the file has no
`.cmd` shim.

The process that owns the listening socket of `--url` is authoritative. `status` reports `listener`, `unlistening` and `foreign` process facts. On Windows, an explicit `stop --url` identifies the configured loopback listener and checks its Superagent management response without reading process command lines or requiring administrator rights. It does not check that the listener uses the supplied profile: select the URL of the intended service. Without `--url`, discovery checks loopback listeners and rejects ambiguous matches. Neither path force-kills.

`start` runs `dsh --profile superagent` in tmux session `dsh-superagent`, or `dsh-<profile>` for another profile. It waits
up to one minute for the runtime to become ready or report a setup requirement. On a first run it prints the missing
setup information. It refuses duplicate instances, including ones started outside this script. Each profile uses its own
named tmux socket. The pane uses the caller's `DSH_HOME`, `HOME`, and `PATH` (including unset values) and clears `TMUX`
and `TMUX_PANE` before starting DSH, so a worker does not inherit the service socket. Setting `TMUX_TMPDIR` alone does not
override an inherited `TMUX`; these measures are guardrails, not an OS security boundary.

On Windows, `start` requires `dsh` on `PATH` (the npm `.cmd` shim), spawns `dsh --profile <profile> --no-open` as a
detached process with the same log and control files, and waits for the management API; it does not use tmux. When the
caller is inside a Windows Job, it creates the service outside that Job through `scripts\service-start.ps1`, which also
receives the same `--home`. `status` lists processes through Windows PowerShell (`powershell.exe`, part of Windows).
`stop` asks DSH to exit through `POST /orchestrator/api/service/stop` instead of sending a signal; it waits up to five
minutes and never force-kills. The tmux socket and `TMUX` details above apply to POSIX only. The same exit codes, log
names and `manually-stopped` marker apply on both.

`stop` and `restart` request a graceful drain and wait up to five minutes for the process to exit. The Executor drain is
bounded at ten seconds and DSH's launcher adds a five-second grace, so a stop normally finishes within about fifteen
seconds; a worker still in a turn after the drain can be interrupted. On POSIX they never force-kill the process or
touch other tmux sessions.

`status` prints process ids, health and setup problems. For a different profile or port, use `--profile` and `--url`, or
set `DSH_SUPERAGENT_PROFILE` and `DSH_SUPERAGENT_URL`; in PowerShell, set `$env:DSH_SUPERAGENT_PROFILE` and
`$env:DSH_SUPERAGENT_URL`.

`status`, `start` and `restart` exit with one of four codes:

| Code | Meaning |
| --- | --- |
| 0 | The service runs normally |
| 1 | It does not run, runs twice, does not answer, or its runtime reports an error; a restart may fix it |
| 2 | It runs, but a part other than the runtime, such as a Source or a Policy sync (`sync:<source id>`), reports an error; a restart does not fix it |
| 3 | It runs and waits for setup; a restart does not fix it |

A Source that is still starting counts as normal operation. So does a Feishu bot that setup could not check.

`status` returns failed parts and their details under `errors`, and setup requirements under `setup`. `start` and `restart` print those problems as lines; they exit 1 if the service never comes up. Only an intentional `stop` pauses automatic recovery.

Each DSH home stores its service's logs and control files under `service/`, so a dirty or shared checkout is not runtime
state:

- Startup logs: `<DSH home>\service\logs\dsh-superagent-<profile>-<date>-<time>-<pid>.log`, where the pid belongs to the
  script. The newest 20 are kept.
- Control files: `<DSH home>\service\control\profiles\<profile>\`, containing the stop marker, lock, process id and the
  newest start facts.

This build still reads the old `<checkout>\.artifacts\control\profiles\<profile>\` stop marker, recorded PID and start
facts so an intentional stop and the current start survive the upgrade. A normal start writes nothing there, but
stopping a service still recorded there writes its stop marker back so the recovery check sees it. Archive that
directory after the new entry is deployed and no old invocation remains.

Open the URL printed in the log, then choose **Superagent** in the sidebar.

### Service check

Check status from an environment independent of `superagent`; exit codes 2 and 3 report a component error and setup requirements respectively, so do not treat a restart as a fix. For exit code 1, inspect the output and service logs and diagnose the cause. An intentional stop marker means the service should remain stopped; use the latest-code deployment path below for a normal restart.

### Task-level check (Watchdog)

The intended independent Watchdog observer reads `GET /orchestrator/api/watchdog` at a fixed interval, without long polling; the snapshot describes service state and open Tickets and their mechanical signals. When the service is unreachable the observer cannot inspect its current state, but can record the failed observation locally.

### Independent Watchdog process

The intended observer writes local state, logs and heartbeat; it does not run a model, send Feishu messages, write observations or reports to the service, automatically recover a service or Ticket, poll deployment requests, or update itself. Local evidence is not proactive notification: an operator must inspect it or arrange a separate alerting system. A service-side `lastRun` is not an observer heartbeat and can be stale. The service may still expose recovery or other write APIs, including an enforce-mode recovery API; a read-only observer does not disable or secure those APIs.

The launcher runs only the currently installed Watchdog version and does not fetch, build or switch versions at startup or after an exit. These are the intended new semantics, not a claim about an existing production installation: a separate Watchdog artifact and launcher deployment is required before they take effect. A normal Superagent deployment does not update an independently installed Watchdog. Until independently deployed and verified, an old observer, launcher, or separate scheduled task may retain its old behavior; check their configuration and installation separately.

The candidate disables dangerous PID-only force killing; an existing production installation may still use it until the new Watchdog is separately deployed. Without administrator access, process identity and permissions can be unavailable: verify PID together with creation time, or use the same process handle for identification and the operation. Reject the operation when identity or required permissions cannot be established; PID alone can be reused and is not proof of identity. These checks are not an OS isolation boundary.

### Starting the service outside a Windows Job

A tool command run by DSH belongs to a Windows Job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; a service started from it is terminated when the command ends, after a health check inside the command has already passed. `scripts/dsh-superagent start` detects that state, asks the WMI provider to create `scripts/service-start.ps1` outside every Job, and waits for health. WMI is asked to hide the created process window. The wrapper restores the service environment from an access-restricted file, starts the detached service and exits; it never starts the observer. A start from a normal terminal that is not inside a Job keeps the ordinary path, and a scheduled task leaves its Job the same way; `status` reports the live `inJob` value, whether any of those Jobs was not created by the service itself (`foreignJob`), and the newest start's method in `start`. If the caller's Job membership cannot be determined, start still uses the WMI path; startup no longer rejects a service solely because its post-start Job membership is unavailable.

Node puts a long-running service into its own kill-on-close Job the first time it spawns a child (the Feishu event consumer is one), so plain `inJob` is also true for a healthy service. The service holds that Job, and it closes only when the service exits, so it cannot kill the service from outside. The separate `verify` command still checks `foreignJob`; ordinary start no longer blocks on that optional post-start inspection.

The versioned `scripts\dsh-superagent.ps1` is the service entry point: it validates the machine configuration and calls the control script, so the service keeps its own profile home and credentials while its process is outside the Job. The operator's `C:\Users\dd\.dsh-superagent\service.ps1` remains the compatibility entry for existing tools; after cutover it should be reduced to a shim to that entry. `scripts/service-start.ps1` can also run directly from an independent scheduled task; it receives the same `-DshHome` as the parent. Start that task through `wscript.exe <checkout>\scripts\launch-hidden.vbs <pwsh> -NoLogo -NoProfile -NonInteractive -File <checkout>\scripts\service-start.ps1 ...` so the wrapper and the node control script it runs stay windowless.

A scheduled task has no console to inherit, so Windows gives the first console program it starts (`node` or `pwsh`) a visible console window. Every non-interactive entry point therefore goes through `scripts/launch-hidden.vbs`: `wscript.exe` itself has no console, the launcher starts the command in a hidden window, waits for it and returns its exit code, and all console children of that command share the hidden console. This covers deployment and service-start tasks; separately installed legacy Watchdog tasks must be checked independently. Run a command directly only when a person is watching it interactively. The control script also hides its own PowerShell, `git` and Windows ACL helper processes, so a background `status`, `start` or `stop` never flashes them either.

`node scripts/dsh-superagent verify --profile superagent --url <url> --survival-seconds 30` proves a release after its executor has exited: exactly one process serves the profile, the management API answers ready (or paused), the process belongs to no Windows Job it did not create, and the same process is alive after the survival window. Exit 1 names the failed condition.

### Deploying the latest superagent

The main Session can queue the operator's explicit deployment request without releasing anything itself. The `orchestrator_deploy` tool writes the request to `DSH_SUPERAGENT_DEPLOY_REQUEST`; `DSH_SUPERAGENT_DEPLOY_COMMAND`, such as `schtasks /run /tn dsh-superagent-deploy`, is an optional wakeup command for the independent task. The request path must match the independent deployment configuration's `requestPath`. A successful tool response means only that the request was queued, not that the observer is running or the deployment succeeded; inspect the independent result file for the outcome. The request file remains in place; success records its digest and archive. A matching request is not deployed again after success or `started_needs_attention` (restart exit code 2 or 3); the latter remains a failure requiring investigation before issuing a new request. A newer request may safely replace it. The executor checks that confirmation is nonempty and uses the mechanical latest-code restart, without asking a model to make the release decision.

`scripts/deploy.ps1` is the scheduled task's Windows entry point over `scripts/deploy.mjs`. Deployment is mechanical: the script calls `restart-superagent.ps1`, which stops the configured service, pulls `origin/main`, installs dependencies, builds and starts. It does not call a model or control Watchdog; the old agent fallback is disabled. Failure to stop, pull, install or build is reported rather than silently starting old code.

`-Validate` prints resolved configuration; `-Plan` displays the target and script without starting a deployment. The executor does not use a persistent deployment lock file; old `<resultFile>.lock` files are ignored. The service lifecycle mutex still prevents overlapping stop, update and start operations, but concurrent executors can race while recording results or deduplicating requests. This minimal in-place path does not create a database backup or roll back on failure. An update failure can leave the service stopped, and Feishu messages received while it is offline may be lost.

The separate `scripts/recover-superagent.ps1` helper starts the installed version without pulling or building and honors the intentional-stop marker; the intended observer does not invoke it. Any separately scheduled legacy caller must be assessed independently.

#### Configuration

The deployment configuration names `checkout`, `requestPath`, `resultFile`, `serviceHome`, `serviceProfile`, `url`, and optionally `node` and `serviceAgentsHome`. The service's own `service.json` supplies its PATH and deployment command. The old `mechanical` candidate, manifest, pinned revision and observer commands are no longer needed. Existing request and result paths remain in use, so scheduled-task entry points do not need to change. A new service-crash recovery task is not installed automatically.

**Historical baseline.** The 2026-11-09 deployments took about ten minutes each; the second spent about 54 seconds stopped. See [deployment-speed evidence](evidence/deployment-speed/). Those timings describe the retired agent-driven flow, not the current in-place mechanical path.

The `dsh-superagent-deploy` task runs the entry in the background through `scripts/launch-hidden.vbs`. Its result file records whether the restart completed. Historical production version and readiness observations are not evidence that this revised script has been deployed; the task and its configuration must be checked separately when installing it.

### Versioned Watchdog artifact and installation

A Watchdog installation is independent of the Superagent installation. Its active artifact is selected by `<watchdogHome>\current.txt`; the intended launcher runs that installed version without automatically updating it. Installing a new observer and launcher is a separate operator-controlled deployment, not a consequence of editing this checkout or deploying Superagent. In the candidate, `watchdog-control` provides read-only `status`; its `start`, `stop` and `deploy` commands and the Watchdog update entry are disabled for safety. Verify the installed version, local state, logs and heartbeat after a separately authorized installation; do not infer success from a queued request or a service-side observation.

The observer uses an atomically exclusive PID lock. An abnormal exit can leave the lock behind; it is not automatically removed. Before manually removing a leftover lock, confirm that its corresponding observer process no longer exists, taking PID reuse and process identity into account. Local logs and heartbeat can be stale or unavailable after an event-loop stall, process exit, PID reuse or write failure; handle logs as sensitive evidence. There is no built-in proactive notification in the intended mode. The new artifact excludes the agent, bootstrap and deployment modules; separately installed legacy tasks may still run.

## Settings

Setup must succeed before polling or work starts. Overview lists missing requirements and links to their settings. A settings change runs setup again. If you fix something outside the application, such as CLI authentication, choose **Check again**.

1. **Sources.** Enable exactly one Git Source. For GitHub, set the repository (`owner/name`) and agent CLI, for example `/home/me/.local/bin/gh-agent`. Requests normally arrive through the agent account's notifications. A new Issue or comment mentioning the account arrives on the next poll; adding a mention by editing an existing Issue body does not. Post a new comment instead. For GitLab, add the GitLab plugin in the profile, configure the GitLab Source card with the URL, project and agent CLI, for example `/home/me/.local/bin/glab-agent`, and switch to it from the Sources page; its project scan reads Issues, merge requests, notes and pipeline changes since the Source was switched on. Optionally set **Webhook URL** so GitLab events trigger a sync immediately (see GitLab webhook above); leaving it empty falls back to `pollSeconds` polling. For Feishu, set the bot CLI, chats, each chat's receive-all or mentions-only mode, and whether to receive direct messages. On Windows, set the CLI to the native `gh` or `glab` and set the advanced configuration directory instead of a wrapper path; see Windows credentials above.
2. **Policy.** The two example rules can be edited or removed. Under **On each Source**, add the GitHub or GitLab accounts and Feishu users who may ask for execution; until a list has someone or a scope admits read-only replies, no request can become a Ticket. With Feishu, a chat can be chosen to sync the list from, at startup and on **Sync now**. The admission table can also set a group scope's unlisted-addressed cell to **read-only reply**, which lets anyone there, including bots and agents, ask a question the agent answers after read-only investigation without executing. Direct messages offer only Ignore to unlisted senders and stay limited to listed senders.
3. **Execution.** The directory root and a prepare command. To give each Ticket a checkout of the repository on GitHub:

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
   ```

   On GitLab, use the GitLab variables:

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "$DSH_SUPERAGENT_GITLAB_HOST/$DSH_SUPERAGENT_GITLAB_PROJECT.git" "${DSH_SUPERAGENT_GITLAB_MR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
   ```

   On Windows the prepare command runs with PowerShell 7 (`pwsh`) instead of `sh`, and the variables are `$env:DSH_SUPERAGENT_DIR`, `$env:DSH_SUPERAGENT_NAME` and so on. For GitHub, with the clone at `C:\src\widgets`:

   ```powershell
   $head = if ($env:DSH_SUPERAGENT_GITHUB_PR_HEAD) { $env:DSH_SUPERAGENT_GITHUB_PR_HEAD } else { "HEAD" }
   git -C C:\src\widgets fetch --no-tags "https://github.com/$($env:DSH_SUPERAGENT_GITHUB_REPOSITORY).git" "${head}:refs/dsh-superagent/$($env:DSH_SUPERAGENT_TICKET)"
   git -C C:\src\widgets worktree add -b "agent/$($env:DSH_SUPERAGENT_NAME)" "$($env:DSH_SUPERAGENT_DIR)" "refs/dsh-superagent/$($env:DSH_SUPERAGENT_TICKET)"
   ```

   For GitLab, replace the repository and head variables with the GitLab ones:

   ```powershell
   $head = if ($env:DSH_SUPERAGENT_GITLAB_MR_HEAD) { $env:DSH_SUPERAGENT_GITLAB_MR_HEAD } else { "HEAD" }
   git -C C:\src\widgets fetch --no-tags "$($env:DSH_SUPERAGENT_GITLAB_HOST)/$($env:DSH_SUPERAGENT_GITLAB_PROJECT).git" "${head}:refs/dsh-superagent/$($env:DSH_SUPERAGENT_TICKET)"
   git -C C:\src\widgets worktree add -b "agent/$($env:DSH_SUPERAGENT_NAME)" "$($env:DSH_SUPERAGENT_DIR)" "refs/dsh-superagent/$($env:DSH_SUPERAGENT_TICKET)"
   ```

   List personal CLIs, such as one signed in to your own account, as blocked commands. The previous Executor cleanup can remove an ended Ticket's linked worktree and refs, and may attempt remote branch deletion; a deployed version may still do so, and its checks do not establish that ignored data, external users or remote updates are safe. A fetched ref is not proof of a durable remote copy, and the remote comparison and delete are not atomic. The lifecycle candidate replaces that path with read-only per-Ticket reconciliation and retains the latest report in Ticket detail; ending a Ticket does not automatically delete its worktree or local or remote branch. This is not a claim about the deployed version. Historical remnants need human confirmation. See `docs/015-workspace-lifecycle.md` before resuming or considering cleanup; do not recreate a missing old worktree from the current prepare command without recovery review.

   The rc.3 compatibility candidate removes native subagent tools from the worker preset and guards known native tools for recognized managed workers and subagents, including older presets. It cannot revoke prepared calls or cover other entry points, external or GUI work, or unrecognized subagents; it is not complete isolation. On rc.2/rc.3 it best-effort interrupts catalogued children and waits for tree work rather than releasing activations. Pending inboxes or local activations may remain and wake later, and the catalog can miss work. Any catalogued child or diagnostic, including historical entries, or observed tree work makes cleanup unconfirmed even without another error; an empty catalog or false wait does not prove no activity remains. Existing persistent Ticket fences block later automated work, remain visible as worker health errors after restart and have no automatic release. Crashes before intent recording and direct GUI or unconfirmed external work remain outside the safeguard. The rc.1 path differs. On in-process shutdown failure the candidate keeps its database and state lock rather than allowing another Runtime to open them. If a worker's stop intent cannot be recorded, the candidate does not cancel or clean up that worker; it requires operator investigation. Investigate the original process and remaining work before any recovery. On a failed HTTP-requested shutdown the candidate logs the failure and does not invoke the process exit hook; it remains in a closing state for investigation, not in normal service. This is not proof that external work stopped or evidence of production deployment.
4. **Prompts.** Set the team sections: the GitHub disclosure line, review bots, the commit author and the auto-merge condition.

### Management API

The panel uses a local HTTP API that agents can also call. `SETUP.md` uses it to save settings, and the service script reads `GET state`.

Send requests to `http://127.0.0.1:<port>/orchestrator/api/` with `x-orchestrator-request: 1`. The host must be `127.0.0.1:<port>` or `localhost:<port>`. Missing headers or an `Origin` from another site receive 403.

API saves have the panel's permissions. They can change execution environment and setup account fields, unlike saves made through the main Session's tools.

Agents may rely on these routes and fields. The other routes in `src/app/api.ts` serve the panel and change with it.

| Request | Answer |
| --- | --- |
| `GET state` | What every page reads: `setup`, with `problem` and `feishuProblem`, each `null` or a setup problem with `place`, `code`, `values` and `detail`, and `accounts` once setup resolved them; `health`, an entry per part, below, with `state` (`starting`, `ready`, `paused` or `error`), `detail` and `at`; `load`, the Executor Sessions `running`, the Tickets `queued` and `maxWorkers`; `paused`; and `masterId` |
| `GET settings` | `blocks`: `policy`, `eval` and `executor`, each with its `value` and its `revision`; `sources`: the Source instances, each with `id`, `kind`, `installed`, its block's `value`, `{"enabled": …, "config": {…}}`, and `revision`, its kind's form, and its setup `problem` when it has one; `policyVersion`; and `environment`, the execution environment's `root` and `variables` |
| `GET sources` | Each Source's status: `state` (`missing`, `off`, `error`, `setup`, `starting`, `paused` or `ready`), the `health` of its parts, its setup `problem`, the last day's `stats`, the Triggers it `filtered` in that day, and the messages it `dropped` in that day, newest drop first, each with its `channel`, `preview`, `ticket` (`id` and `title`) when it was for one, its `thread` when the store has it, and `dropped.at` and `dropped.reason`, `channelGone` or `channelIgnored` |
| `PUT settings/<block>` with `{"value": …, "revision": n}` | Saves one block: `saved`, the block's new `revision`, `policy_changed` and `restarting`. `value` is the whole block, as `GET settings` holds it; a missing key takes its default |
| `POST executor/pause` with `{"paused": true}` or `false` | Pauses or resumes processing: `paused` |
| `POST setup/check` | Runs setup again by restarting dsh-superagent: `restarting: true`. Refused when setup has nothing to fix |
| `POST service/stop` | Asks dsh-superagent to drain Executors, bounded at ten seconds, and then exit through DSH's launcher: `stopping: true`. Refused with 500 when the launcher provides no exit hook; the service script uses it to stop without a POSIX signal |
| `POST policy-sync/<source id>` | Syncs that Source's allowed list now: `policy`, the Source's part as saved |
| `GET prompts`, `PUT prompts` with `{"config", "baseRevision"}` | Reads the prompt configuration: `current`, with its `revision` and `config`, `defaults`, `sections`, the team sections in the order Sessions read them, `skillName`, the pattern of a team skill's name, `builtin`, the names a team skill cannot take, and `skillPrefix`, which Sessions load a skill's name under. Or saves it: the new `revision` |
| `POST tickets/<id>/retry`, `POST tickets/<id>/stop` | Retries or stops a Ticket, as the panel does |

Health entries are grouped by responsibility:

| Entry | Reports |
| --- | --- |
| `runtime` | The application itself |
| `models` | Sessions waiting on a model-budget retry |
| `evals` | Unavailable Evals from the last hour with no later judgement or dismissal |
| `assessment`, `launch`, `delivery`, `relay`, `notice`, `reply` | Stored work described in [003 Execution](003-execution.md); delivery counts waiting work, while reply covers Channel messages |
| `cleanup` | The lifecycle candidate handles legacy queued effects as read-only observations for ended Tickets, without deleting resources; failures are visible on the health board. A deployed older version may still run destructive cleanup; verify deployment separately |
| `worker` | Executor Session event handling; appears after its first failure |
| `github`, `gitlab`, `feishu` | Source polling, webhook and events |
| `sync:<source id>` | Allowed-list synchronization |

A refusal has a status and `error`, its English text:

- 400: an invalid value (`issues`, each with its `path`), a failed account check (`setup`), a fixed refusal (`code` and `values`), or a body that is not JSON or is too large.
- 404: something that does not exist.
- 409: a stale revision.
- 500: anything else.

The blocks:

- `source:github`, `source:gitlab`, `source:feishu`: `{"enabled": true, "config": {…}}`. GitHub's config has `repository`, `cli` and the advanced `configDir`, the `GH_CONFIG_DIR` that selects the agent account, and the switches `observeIssues`, `observePulls`, `observeComments` and `observeCi`, off by default, which receive every new Issue, new pull request and comment in the repository and the default branch's CI. GitLab's has `host`, `repository` as `group/project`, `cli`, `configDir` (`GLAB_CONFIG_DIR`), the optional `webhookUrl`, advanced `webhookPort` (default 3084) and `webhookBind` (default `0.0.0.0`), `pollSeconds`, `failuresBeforeError` and the same observe switches. Feishu's has `cli`, `configDir` (`LARKSUITE_CLI_CONFIG_DIR`), `chats` as `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]` (or `"all"`), `directMessages`, and `otherChats` as `"none"` or `"mentions"`.
- `policy`: `{"rules": […], "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`. `bots` lists the bots whose messages may become inferred candidates. An `admission` row is keyed by chat id, `other` or `direct` for Feishu, and by `issues`, `pulls`, `comments` or `ci` for GitHub; its `unlistedAddressed` cell takes `explicit`, `reply`, `inferred` or `ignore`, and an unset cell takes its default (see [002 Authorization](002-authorization.md)).
- `eval`: `mode`, `timeoutSeconds` and `model`.
- `executor`: `model`, `tierModels`, `models`, `maxWorkers`, `offPeak`, `directory`, `prepare` and `blockedCommands`. `tierModels` maps `low`, `high` and `expert` to a model or `null`; a tiered Ticket uses its tier model, else `model`, then the host default. `models` maps the legacy `query`, `research` and `development` categories to a model or `null` and applies only to old Tickets without a tier; those fall back to `model`, then the host default. `offPeak` is `{"enabled": false, "start": "22:00", "end": "08:00", "timezone": "Asia/Shanghai"}` by default: Tickets marked off-peak start new Assignments only inside that daily window (see [003 Execution](003-execution.md)). Alibaba Cloud Model Studio bills DeepSeek at off-peak rates from 22:00 to 08:00 Beijing time, peak 08:00–22:00 ([billing](https://help.aliyun.com/zh/model-studio/billing-for-model-studio)), which the defaults match. The processing pause is a setting of its own, `paused`, which `POST executor/pause` sets.

Changing a repository or CLI runs the corresponding setup check first. A failed check returns 400 with details in `setup`. A successful account change, or any save while setup is pending, returns `restarting: true`. The API is temporarily unavailable while the application restarts.

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

On Windows, use `curl.exe`, which current Windows versions ship, set `cli` to `gh` or `glab`, and add the account directory as `configDir`, for example `"configDir": "C:\\Users\\me\\.config\\gh-agent"`.

## Setup checks

Setup uses the DeepSeek Harness subprocess service, as worker shells do. It removes environment variables whose names contain KEY, PASSWORD, SECRET or TOKEN.

Setup verifies the active Git Source's repository or project and the agent's push access, writes the worker environment, and checks that git uses only the agent credentials for that host. A Feishu setup failure disables only the Feishu Source.

The process environment that setup writes:

- **Command shims** in `<stateDir>/worker-bin`, first on `PATH`. On POSIX, `gh` runs the agent's CLI, `lark-cli` runs the bot's CLI, and blocked commands fail; a shim removes its own directory from `PATH` before it runs its target. On Windows, only blocked and inactive commands get a `.cmd` shim (the inactive Git host's shim fails); the active Git CLI runs as a native executable selected by `GH_CONFIG_DIR` or `GLAB_CONFIG_DIR`, and `lark-cli` is resolved through its npm `.cmd` shim's Node entry, so arguments never pass through `cmd.exe`.
- **git configuration** in `<stateDir>/worker-gitconfig`: replaces the operator's global and system git configuration. It selects the agent CLI as the active host's credential helper, rewrites that host's SSH addresses to HTTPS and defines Git LFS filters. Personal git settings such as an HTTP proxy do not apply. No commit identity is set here, git never prompts for credentials, and `GH_TOKEN`, `GITHUB_TOKEN`, `GLAB_TOKEN` and `GITLAB_TOKEN` are removed.

A file in `worker-bin` or `worker-gitconfig` that dsh-superagent did not write stops setup. A Ticket directory inside a git repository whose own configuration adds credentials fails the Ticket.

## Try it

From an allowed GitHub account, open an Issue or post a comment containing `@<agent login> <request>`. Within a polling interval (one minute by default), Overview should show a Ticket. The agent acknowledges the request, works in its own Session and directory, and delivers in the original conversation. For Feishu, mention the bot in a configured chat.

## Upgrade

**Self-hosted development:** Do not have the running service perform its own in-place upgrade from a worker session; use an independent operator or deployment task. Development tests must use separate profiles, DSH homes, state, controls, ports and credentials, with Feishu disabled. Deployment and lifecycle fixtures must explicitly select temporary service homes and checkouts and use fake executors or isolated endpoints; inheriting `DSH_HOME` can redirect a test to production configuration. The legacy Watchdog deployment fixture does this explicitly, but this is not a suite-wide or OS security boundary: separate runtime directories and environment variables do not block access to a production loopback port. The minimal production deployment described above does not create a backup or rollback point; a build failure can leave it stopped. If restoring a database manually, reconcile external side effects and do not treat a copy of a live SQLite file as a consistent backup. See `AGENTS.md` for the task-worktree and production boundaries.

The steps below apply only to deployments where an in-place upgrade has been explicitly deemed appropriate; they are not an automated self-hosted release procedure:

1. Wait until no Executor is in the middle of a turn.
2. Back up `<stateDir>/orchestrator.sqlite`.
3. Run `git pull && pnpm install && pnpm build`.
4. Run `scripts/dsh-superagent restart` and inspect its status.

On Windows, run the same steps in PowerShell; `&&` works in PowerShell 7, and the service command is
`pwsh scripts\dsh-superagent.ps1 restart`. The entry takes only the action (and an optional `-Config`/`-RespectStop`);
target facts stay in `%USERPROFILE%\.dsh-superagent\service.json`, created from `examples/service.windows.json`.

A restart ends running Assignments and starts replacements with recovery notes. This does not verify the original workspace or isolate recovered workers: before resuming, verify the worktree, branch, uncommitted work and Session working directory, and stop for operator recovery if the original directory is missing or mismatched. See `docs/015-workspace-lifecycle.md`. Team text and overridden prompt parts are retained; parts without overrides follow the new defaults. Review parts marked **Default updated** after upgrading.

A database migrated by a newer version cannot be opened by an older one. Rollback therefore requires the pre-upgrade backup. After upgrading DeepSeek Harness itself, restart the running instance so the panel loads matching artifacts.

### Agent presets

The worker and router presets move shell commands to the background after 5 seconds. A Session cannot load without its preset. Keep the `dsh-superagent-worker` and `dsh-superagent-router` rows in `cordis.patch.yml` while their Sessions are in use; otherwise resume fails with `agent-preset/not-found`.

## Troubleshooting

Setup problems appear on the overview with a link to the fix, in the panel's language; the log and the API show the English text below.

| Symptom | Cause and fix |
| --- | --- |
| `The agent GitHub CLI is not set.` | Set the agent's CLI on the GitHub card |
| `The agent GitHub CLI was not found.` | Set the wrapper's absolute path, or a command name on `PATH` |
| `The agent GitHub CLI cannot read its account` | Sign the wrapper in with `auth login` |
| `@… cannot read …` or `@… cannot push to …` | Give the agent account write access to the repository |
| `The GitHub Source names no repository.` | Set the repository, `owner/name`, on the GitHub card |
| A Ticket fails with `The prepare command failed: …` | The output names the cause, such as a wrong clone path; fix the command, then retry the Ticket |
| A finished Ticket's worktree stays at `<stateDir>/work/…` | Expected in the candidate: ending a Ticket does not automatically delete its worktree or branches. Preserve it and investigate ownership, ignored and other local data, active users and recovery needs before any manual action. A deployed older version may retry cleanup at host startup; historical remnants require human confirmation. See `docs/015-workspace-lifecycle.md` |
| `pwsh` is not found, or the prepare command fails with a PowerShell error | Install PowerShell 7 and put `pwsh` on `PATH`; Windows PowerShell 5.1 is not used for the prepare command |
| `dsh must be on PATH.` when starting on Windows | Install DSH globally and open a new shell; `start` resolves the npm `dsh.cmd` |
| PowerShell or `cmd.exe` cannot run `scripts\dsh-superagent` | The script has no `.cmd` shim on Windows; run `pwsh scripts\dsh-superagent.ps1 <action>`, or `node scripts\dsh-superagent <command>` when the environment is already set |
| `The service configuration does not exist` or a target mismatch | Create `%USERPROFILE%\.dsh-superagent\service.json` from `examples/service.windows.json`; the entry refuses a checkout or non-loopback URL, and a start also needs the profile directory |
| `The management URL … is owned by PID …` | Another process owns the port; stop it or choose the service's real `url`. The entry never kills a foreign listener |
| `This home's dsh-superagent process … does not listen` | The recorded process is running but not serving the target URL. Inspect it, fix its listener, or restart it from an independent task; `start` and an explicit-URL `stop` refuse, while a zero-parameter `stop` discovers another running server |
| A `.cmd` wrapper for `gh` or `glab` drops or corrupts an argument | Use the native `gh.exe` or `glab.exe` with its configuration directory (see Windows credentials); never pass JSON or message text through `cmd.exe` |
| The Feishu Source is refused on a Windows host | Point the Source's **Bot lark-cli** field at `lark-cli` (the npm `.cmd` shim) or at the package's Node entry; a custom `.cmd` wrapper without a Node entry is refused |
| `git does not read the credential configuration dsh-superagent writes` | Install git 2.32 or later |
| A Ticket fails with `The git configuration of the repository in … sets …` | Remove the named credential or `http.*.extraheader` settings from the clone's `.git/config` |
| `… was not written by dsh-superagent` | Move the named file out of `<stateDir>/worker-bin` or `<stateDir>/worker-gitconfig`, or choose another `stateDir` |
| `The bot lark-cli allows user identities` | Point the Feishu Source at a bot-only configuration, as in Feishu bot above |
| `The bot lark-cli does not work.` or `The bot identity of app … is …` | Check the configuration's app id and secret |
| `The Feishu bot is not a member of the chat.` | Add the bot to the chat in the chat's settings; the next attempt succeeds |
| A screenshot or image sent to the bot is not understood | The bot cannot download images: the app has neither `im:resource` nor `im:message:readonly`, and neither can be granted (see Images and screenshots above). Ask for a text description |
| `status` exits 2 | A part reports an error, which a restart does not fix: `errors` names each part, as listed under Management API, with its detail; each part clears its own entry once it works again |
| `status` exits 3 | Setup waits: `setup` says what is missing, and the overview links to the setting that fixes it |
| `status` exits 1 | The service does not run, runs twice, does not answer, or its runtime reports an error; the output and the newest log say which |
| `… timed out after 90 s`, `… was stopped by …`, `… exited with code …` or `… could not run: …` | A CLI failed without printing why; run the named program by hand as the operator's user to see its own message |
| The panel says dsh-superagent is not answering | It is restarting, or did not start because of its configuration; the DeepSeek Harness log names the cause |
| `dsh-superagent configuration has keys it does not use` (log) | Remove the named keys; the message says where each value lives now |
| The log says the plugin is incompatible with the running dsh | Install a DeepSeek Harness version within the `engines.dsh` range |
| The panel shows "Failed to load plugins" after a DeepSeek Harness upgrade | Restart the running instance |
| Nothing happens after a mention | Check that the author is on the Source's allowed list, the Source is on, and processing is not paused. On GitHub, a mention added by editing an Issue's body is not received; mention the agent in a comment |
