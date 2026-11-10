# 006 Deployment

Use this guide to install, configure and operate dsh-superagent. It covers accounts, startup checks, upgrades and troubleshooting, building on [001 Domain model](001-domain.md) through [005 Panel](005-panel.md).

## Production host for this checkout

The intended production host is native Windows, using the stable checkout at `F:\code\dsh-superagent-prototype` and a DSH home separate from Desktop. A different profile alone does not isolate workspace and session storage. On 2026-11-08 the operator authorized a cutover to `C:\Users\dd\.dsh-superagent`, with `DSH_AGENTS_HOME` set to its `agents` subdirectory. The versioned entry `scripts\dsh-superagent.ps1` reads a machine configuration from `%USERPROFILE%\.dsh-superagent\service.json` outside the checkout and pins the checkout, DSH home, profile, loopback URL, Node path, optional PATH additions and deployment request/command; a generic invocation without that file can start against the shared Desktop home. `C:\Users\dd\.dsh-superagent\service.ps1` remains the compatibility entry for the operator's existing tools; after cutover it should be reduced to a shim that passes `-Config` to the versioned entry. The existing dedicated state directory remains at `C:\Users\dd\.dsh\state\superagent`, outside the new home. Startup reported runtime and Feishu ready, with GitLab starting; workspace and session recovery and end-to-end behavior were not independently verified after cutover at the operator's request. This separation is not an OS security boundary. The profile links the bundle directly to the F: checkout; do not rename that checkout to match the package name. Use the Windows profile example in `examples/profile.cordis.patch.yml`; the POSIX / WSL example remains in `examples/profile.posix.cordis.patch.yml` for a separately managed deployment. Historical WSL state and worktrees are not Windows worker directories and must not be pruned or resumed on Windows.

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
file. It refuses a checkout that does not exist, a non-loopback URL, or (for a start) a missing profile directory.

After cutover, replace the old hard-coded `C:\Users\dd\.dsh-superagent\service.ps1` with a compatibility shim so existing
tools keep working:

```powershell
param([ValidateSet('start', 'stop', 'restart', 'status', 'verify')][string]$Action = 'status')
& 'F:\code\dsh-superagent-prototype\scripts\dsh-superagent.ps1' -Action $Action -Config "$env:USERPROFILE\.dsh-superagent\service.json"
exit $LASTEXITCODE
```

The Node script remains the implementation and is available on both platforms when the environment is already set:

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

On Windows that is `node scripts\dsh-superagent start` and the same actions; `node` is required because the file has no
`.cmd` shim.

The process that owns the listening socket of `--url` is authoritative. `status` reports `identity: "listener"`, the
`listener` PIDs, `unlistening` (processes that match the profile but do not own this URL) and `foreign` (another process
owns the URL). `start` refuses a foreign listener or a process this home recorded but that no longer listens. On
Windows, `stop` without `--url` discovers running superagent servers from their management state and stops the only
one, or the one matching `--profile`, so a matching home or URL is not required; an explicit `--url` is exact. A foreign listener is
never stopped, and neither action force-kills. When listener lookup is unavailable, `identity: "scan"` says the older
command-line fallback was used.

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
facts so an intentional stop and the current start survive the upgrade; it writes nothing there. Archive that directory
after the new entry is deployed and no old invocation remains.

Open the URL printed in the log, then choose **Superagent** in the sidebar.

### Hourly check

Create the hourly check in the DeepSeek Harness profile you normally use, not in `superagent`. It must keep running when the agent service is down. Ask an agent in that profile to create an hourly schedule using this prompt, with the checkout path filled in:

```text
Check dsh-superagent: run `scripts/dsh-superagent --profile superagent --home <DSH home> status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/dsh-superagent --profile superagent --home <DSH home> --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest <DSH home>/service/logs/dsh-superagent-superagent-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

`--respect-stop` preserves an intentional stop. Only `stop` writes the marker; `start` clears it. `restart` writes no marker, so the check can recover a restart whose shutdown timed out. On Windows, use `pwsh scripts\dsh-superagent.ps1 -Action status` and `pwsh scripts\dsh-superagent.ps1 -Action restart -RespectStop` instead, and read the same log under the configured DSH home.

### Task-level check (Watchdog)

The hourly check watches the process. A task-level check also watches the work: every open Ticket's stage, latest report, silence and mechanical signals. The independent Watchdog does this outside the service, so it keeps working when the service is down. The service formerly offered its own intervention settings, SQLite decision audit and `retry`/`stop` route; those are removed because the external Watchdog owns the decisions, and the service now exposes only the read-only observation surface.

`GET /orchestrator/api/watchdog` returns the read-only snapshot: service state, every open Ticket with its stage, latest Assignment and report, silence and mechanical signals, and the last recorded observation (`lastRun`). `scripts/dsh-superagent --profile superagent --url <panel URL> watchdog` prints the same JSON. The snapshot command sends only GET requests; `--stale-minutes` changes only its signal threshold.

To follow changes without polling the full snapshot, the service also offers a versioned wait: `GET /orchestrator/api/watchdog/wait?since=<version>&timeout=<seconds>&stale_minutes=<minutes>` returns at once with a new `version` when a Ticket, health, pause or setup fact changes, at the next silence or review deadline, or when the timeout expires. The timeout is capped at 240 seconds. The Watchdog keeps one request in flight and reads the full snapshot only after the wait returns.

An external agent reading the snapshot reports only what a person should act on: `delivery-error` or `undelivered-inputs`; `no-progress` or `queued` that `offPeak`, a paused service, incomplete setup or a full worker load does not explain; a person stage that has waited far longer than 30 minutes, or a ready result awaiting review for more than a day; repeated failed attempts; or a last report that no longer matches the Ticket title. It records its observation every time it runs, even when nothing is wrong, and keeps quiet otherwise. It does not edit settings, prompts, the database or Session files; the service has no intervention route for it to call.

When the Watchdog has something to report, `scripts/dsh-superagent --profile superagent --url <panel URL> watchdog report --chat <chat id>` sends the observation summary to that Feishu chat through the Feishu Source's bot, so a person reads it where they already talk to the service. The server renders the summary from the live snapshot: the service state and the open Tickets that carry mechanical signals with their silence and latest report. `--note "<one sentence>"` appends the Watchdog's own judgement. The chat must be one the bot is in, and the Feishu Source must be on and configured; the report changes no Ticket and is separate from the 100-word limit on conversational replies. The command calls `POST /orchestrator/api/watchdog/report` with `chatId`, `idempotencyKey` and an optional `note`.

Record each observation run with `scripts/dsh-superagent --profile superagent --url <panel URL> watchdog run [--note "<one sentence>"]`. The server renders the observation from the live snapshot and keeps it for thirty days, so `watchdog runs [--limit <n>]` lists recent observations and `GET /orchestrator/api/watchdog` reports the newest as `lastRun`. A recorded run changes no Ticket and sends nothing; a quiet period with a fresh `lastRun` is distinguishable from a check that stopped running. Record one every time the check runs, including when there is nothing to report.

### Independent Watchdog process

`scripts/watchdog` reads the same read-only snapshot, records each observation as a run, reports changed mechanical findings to Feishu, and keeps its own configuration, state and log; it needs neither DSH nor the operator's profile, and it is where host and deployment checks live. Create `watchdog.json`; its relative paths resolve against the file's folder:

```json
{
  "url": "http://127.0.0.1:3083",
  "chatId": "oc_...",
  "report": true,
  "intervalSeconds": 900,
  "staleMinutes": 30,
  "dailyReport": { "hour": 9, "timezone": "Asia/Shanghai" },
  "stateDir": "watchdog-state"
}
```

Run `node scripts/watchdog --config watchdog.json` in the foreground or under a process manager, or run `--once` from a scheduled task every 15 to 30 minutes. `--status` prints the last recorded state; the process writes `state.json` and `watchdog.log` under `stateDir` and holds `watchdog.pid` while it runs. It records a run every cycle, so `GET watchdog`'s `lastRun` and `watchdog runs` show that it is alive, and it reports when the mechanical finding set changes. A long-running process holds one versioned wait request instead of sleeping for `intervalSeconds`; the wait returns on a Ticket, health, pause or setup change, at the next silence or review deadline, or at the API's 240-second cap. A change or a deadline runs the full cycle at once; a cap only reconnects the wait, and the process runs a fallback cycle once `intervalSeconds` has passed, so `intervalSeconds` is the maximum gap between cycles. With `dailyReport`, it also sends one quiet report in the morning when nothing is wrong, so a healthy deployment still proves it is checked; the report is sent once per local date (within the fallback gap), and a findings report is not suppressed by it. It has no model judgement: it reports Ticket signals, unhealthy service parts and setup problems, and a full worker load or a paused service explains the signals it leaves out. While the service is down it logs the failure and keeps checking, but it cannot send a Feishu report because the bot belongs to the service.

To keep the model cost out of ordinary cycles, run the process as a gate with `--gate` on the same interval when a scheduled one-shot is used. A gate cycle reads the snapshot, records the observation, and exits 0 when nothing is risky; it exits 2 when a mechanical finding needs judgement: a Ticket signal, a part in error, incomplete setup, a ready result waiting more than a day, or repeated failed attempts. Run a full DSH agent only when the gate exits 2; the agent records its own observation and reports, so the LLM is paid for only on those cycles. The gate sends only the configured quiet daily report, never a findings report, and changes nothing else; `--status`, the state file and the log show its exit reason. Host checks, bounded recovery and deployment supervision (roadmap workflows K and L) belong in this process later.

### Starting the service outside a Windows Job

A tool command run by DSH belongs to a Windows Job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; a service started from it is terminated when the command ends, after a health check inside the command has already passed. `scripts/dsh-superagent start` detects that state, asks the WMI provider to create `scripts/service-start.ps1` outside every Job, and waits for health. The wrapper restores the service environment from an access-restricted file, starts the detached service and exits; it never starts the observer. A start from a normal terminal that is not inside a Job keeps the ordinary path, and a scheduled task leaves its Job the same way; `status` reports the live `inJob` value, whether any of those Jobs was not created by the service itself (`foreignJob`), and the newest start's method in `start`. A start that cannot prove the service is outside every Job it did not create fails instead of leaving a service that a closing command could kill.

Node puts a long-running service into its own kill-on-close Job the first time it spawns a child (the Feishu event consumer is one), so plain `inJob` is also true for a healthy service. The service holds that Job, and it closes only when the service exits, so it cannot kill the service from outside; `foreignJob` is the fact the checks gate on. A Job the service merely inherited from its launch chain still fails them.

The versioned `scripts\dsh-superagent.ps1` is the service entry point: it validates the machine configuration and calls the control script, so the service keeps its own profile home and credentials while its process is outside the Job. The operator's `C:\Users\dd\.dsh-superagent\service.ps1` remains the compatibility entry for existing tools; after cutover it should be reduced to a shim to that entry. `scripts/service-start.ps1` can also run directly from an independent scheduled task; it receives the same `-DshHome` as the parent.

`node scripts/dsh-superagent verify --profile superagent --url <url> --survival-seconds 30` proves a release after its executor has exited: exactly one process serves the profile, the management API answers ready (or paused), the process belongs to no Windows Job it did not create, and the same process is alive after the survival window. Exit 1 names the failed condition.

### Deploying the latest superagent

The main Session can send the operator's explicit deployment request to the independent Watchdog instead of releasing anything itself. The `orchestrator_deploy` tool writes the request to the file named by `DSH_SUPERAGENT_DEPLOY_REQUEST` and starts the command in `DSH_SUPERAGENT_DEPLOY_COMMAND` (for example `schtasks /run /tn dsh-superagent-deploy`); unset values disable the tool. The independent deployment task reads the request, verifies the operator's words, and releases the latest commit in its own process, so the main instance only stops; the outer task starts and verifies it after the agent exits. The tool is used when the operator explicitly asks to deploy superagent ("部署superagent"); ordinary requests never deploy, and the main Session never backs up, releases or restarts itself.

The deployment keeps to the minimum. A first deployment, before a candidate is staged, follows the full controlled release (candidate build and validation, a consistent backup, the start check and the rollback path) and is slower. In the stable period the Watchdog pre-builds and pre-validates the latest commit, and a deployment only stops the service, switches the built `lib` and `prompts` plus any other changed runtime file such as `scripts/watchdog` or `locale/`, starts it and runs a basic health check, keeping the previous build for rollback and targeting under a minute. The repository checks and the external maintenance channel cover code quality, so the deployment skips repeated test runs and broad checks. The Watchdog reports the result. The first deployment, which installs this command itself, is started by the operator or the Watchdog directly with the operator's confirmation; once the running superagent has the tool and the two environment values, the main Session sends later requests.

#### Deployment retrospective and a faster preflight

The 2026-11-09 deployment history in `C:\Users\dd\.dsh\watchdog\watchdog-deploy.log` shows where the time went. Two deployments each took about ten minutes end to end: the 08:46:58 run ended at 08:56:53, and the 10:33:47 run ended at 10:43:09. In the second run the service was stopped at about 10:40:56 and was ready at about 10:41:50, so the actual switch took about 54 seconds; almost all the remaining time was preflight, not release. The preflight repeated work the deployment already knew: which DSH home and profile directory the running service used, where its state directory and bundle link were, whether a candidate build already matched the target tree, and which watchdog writers had to pause. The request was also ambiguous ("deploy !43 and set two environment variables"), so the supervisor had to reconstruct the intent before it could start.

Use these facts to keep the next preflight short:

1. From the stable checkout, run `pwsh scripts\dsh-superagent.ps1 -Action status` once. `status` reports the profile directory, `service.ps1`, the home-scoped `serviceDirectory`/`logs`/`control`, the configured `stateDir`, the bundle link and target, the checkout revision and branch, the built `lib`, the listener identity (`identity`, `listener`, `unlistening`, `foreign`), the service's Windows Job membership (`inJob` and `foreignJob`) and how the newest start began; read those instead of rediscovering them.
2. Keep one candidate per target revision and record its revision, artifact hashes and test evidence. If `git rev-parse HEAD^{tree}` of the candidate worktree equals the target tree and the built files match, reuse it; do not rebuild or rerun the full suite during the maintenance window.
3. Confirm the service is idle with the same `status` output and record open and queued Ticket counts. Pause the independent Watchdog writers before the consistent backup, then restore and verify them after the service is ready.
4. Stop at the switched, stopped state. `scripts/dsh-superagent start` detects a Windows Job and creates the service outside it through `service-start.ps1`, so do not start a raw detached child from the agent's shell tool. After the DSH agent exits, the outer deployment task runs `verify --survival-seconds 30`; only a service that is alive, in no Job it did not create, and answering ready counts as success.
5. Write the measured stop, start and ready times into the deployment log. The log is the retrospective: a slow run can be compared with the previous one, and the switch target stays under a minute.
6. After deploying a change to `scripts/watchdog`, add `dailyReport` to the independent watchdog's `watchdog.json` and restart that process; if its scheduled gate still runs the old `gate.mjs`, point it at `scripts/watchdog --gate` so the quiet daily report uses the deployed version.

The release supervisor still owns identity checks, the backup, rollback readiness and the maintenance window; these facts shorten discovery, they do not replace those steps. The summarized timing record is in [the deployment-speed evidence](evidence/deployment-speed/).

The independent task runs `scripts/deploy.ps1` from this repository with a JSON configuration outside it. The script reads and archives the request, runs the headless DSH agent, and after that agent exits runs `verify` with a survival window; it records the agent's exit code and the survival result in the result file, and it never starts the observer or retries blindly. `-Validate` prints the resolved paths without running anything. The deployment-specific paths, prompt and model patch stay outside the repository:

```json
{
  "requestPath": "C:\\Users\\dd\\.dsh\\watchdog\\deploy-request.json",
  "promptPath": "C:\\Users\\dd\\.dsh\\watchdog\\deploy-prompt.md",
  "modelPatch": "C:\\Users\\dd\\.dsh\\watchdog\\model.patch.yml",
  "workdir": "F:\\code\\superagent-ops",
  "node": "D:\\Program Files\\nodejs\\node.exe",
  "dsh": "C:\\Users\\dd\\.local\\opt\\dsh-0.2.2-rc.1\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js",
  "home": "C:\\Users\\dd\\.dsh",
  "agentProfile": "headless",
  "serviceProfile": "superagent",
  "url": "http://127.0.0.1:3083",
  "logFile": "C:\\Users\\dd\\.dsh\\watchdog\\watchdog-deploy.log",
  "resultFile": "C:\\Users\\dd\\.dsh\\watchdog\\deploy-result.json",
  "survivalSeconds": 30
}
```

The `dsh-superagent-deploy` task then runs `pwsh -NoLogo -NoProfile -NonInteractive -File <checkout>\scripts\deploy.ps1 -Config <configuration>`. **Rollout note (2026-11-09).** Moving a production service from the Desktop DSH Job to this path needs an operator maintenance window: pull the merged commit, point the task at the versioned script, and restart the current production instance once from outside DSH so its process is no longer in that Job. See `docs/zh/references/watchdog-superagent-mutual-assist.md` (in Chinese) for the target relationship and the remaining phases.

### Versioned Watchdog artifact and update task

The Watchdog is not updated by pulling the superagent checkout: the repository builds an immutable artifact whose observer, agent wrapper and gate import only from the same version. `node scripts/watchdog-artifact.mjs --out <dir> --version <id> --commit <sha>` copies `scripts/watchdog`, `scripts/watchdog-agent/*` and the stable launchers into the artifact and writes `manifest.json` with the file hashes, one combined digest, `apiVersion` and `minServiceVersion`. `node scripts/watchdog-smoke.mjs <dir>` proves the artifact against a local mock management API, without the production service or Feishu.

Install the artifact under `<watchdogHome>\versions\<version>` and keep `<watchdogHome>\current.txt` as the active version; `previous.txt` is the rollback point. The scheduled task runs `<watchdogHome>\launch-agent.vbs -Config <agent.json>` through `wscript.exe`, whose own process has no console window, so a timer-driven check never flashes a PowerShell window on the desktop. The VBS starts the stable `<watchdogHome>\launch-agent.ps1 -Config <agent.json>` hidden and waits for its exit code; the PowerShell launcher reads `current.txt` and starts that version's `agent\run.ps1`. Changing the version never rewrites the task action and never restarts the superagent service. The agent configuration (service URL, chat id, checkout, workspace, DSH home, model patch, log) stays outside the repository; `scripts/watchdog-agent/config.example.json` and `model.patch.example.yml` are templates.

The agent must run in its own workspace, never the checkout. No manual path is needed: without `workspace`, the wrapper uses `<config directory>\workspaces\watchdog_<service profile>` — `watchdog_superagent` for this deployment, or `watchdog_sheepdoku` for a `sheepdoku` service profile — so Watchdogs on one host do not share a workspace. Set `workspace` only to choose another name or location. `run.ps1` creates the directory when missing, refuses one that is the checkout or inside it, and changes into it before running the gate and the full agent. The prompt addresses the checkout with absolute paths, so the agent still reads the deployment document and runs `node <checkout>\scripts\dsh-superagent ...`. DSH groups a Session under the workspace of its working directory, so the Watchdog's Sessions no longer join the checkout's Desktop DSH workspace; add the workspace directory as a DSH project to see them under their own workspace, otherwise they stay ungrouped. Existing installs must use a rebuilt artifact; the currently deployed local wrapper is not updated by a superagent release. This is workspace separation, not an isolation boundary: the agent still has full access to the checkout, and a shared DSH home still shares its session and workspace storage.

The independent `dsh-superagent-watchdog-update` task runs `node scripts/watchdog-update.mjs --config <update.json>`. The main Session or operator writes `watchdog-update-request.json` with the operator's confirmation, target version, artifact path, optional digest and an idempotency key. The task validates that the artifact is inside the staging root and matches its manifest, smokes it, installs it, switches `current.txt`, triggers the scheduled agent and waits for a recorded run carrying the new version. A failed smoke, trigger or heartbeat restores the previous pointer; a lock makes concurrent updates refuse, and a repeated idempotency key returns the recorded result. The update task does not start the observer itself and never backs up, restarts or replaces superagent. The snapshot's `lastRun` and the recorded runs carry the Watchdog `version` and `commit` for the panel and audit.

```json
{
  "watchdogHome": "C:\\Users\\me\\.dsh\\watchdog",
  "stagingRoot": "C:\\Users\\me\\.dsh\\watchdog\\staging",
  "requestPath": "C:\\Users\\me\\.dsh\\watchdog\\watchdog-update-request.json",
  "serviceUrl": "http://127.0.0.1:3083",
  "triggerCommand": "schtasks /run /tn dsh-superagent-watchdog-agent",
  "observerStopCommand": "",
  "observerStartCommand": "",
  "logFile": "C:\\Users\\me\\.dsh\\watchdog\\watchdog-update.log",
  "resultFile": "C:\\Users\\me\\.dsh\\watchdog\\watchdog-update-result.json",
  "heartbeatTimeoutSeconds": 180,
  "pollSeconds": 5,
  "smokeTimeoutSeconds": 30,
  "lockStaleSeconds": 900
}
```

The first installation is an operator step: build or copy the artifact into the staging root, install both stable launchers and the agent configuration, point the scheduled task's `wscript.exe` at `launch-agent.vbs`, and write `current.txt`. The Execution page now shows the Superagent version, the Watchdog artifact version from its latest recorded run, and that run's heartbeat; a missing or stale heartbeat is shown as a warning. The deployment can name the running build with DSH_SUPERAGENT_VERSION; the package version is the fallback.

The panel also shows the installed current and previous versions, the candidate from the last update request, and that update's time and result. The install facts come from `DSH_SUPERAGENT_WATCHDOG_HOME` and its `current.txt`, `previous.txt` and `watchdog-update-result.json` (override the result with `DSH_SUPERAGENT_WATCHDOG_UPDATE_RESULT`); without the home the panel says the install is not configured. For a persistent observer, set `observerStopCommand` and `observerStartCommand` in the update configuration: the updater stops the old observer before switching the pointer, starts the new version, and on a failed start restores the pointer and starts the previous version again. Without these commands the scheduled Watchdog agent task is triggered, as before. The commands receive `DSH_WATCHDOG_VERSION` and `DSH_WATCHDOG_SERVICE_URL`, and run outside the superagent service.

### Independent alerts and Session observation

The independent observer can leave a local alert when the management API stays unreachable, without the service or Feishu. Set `alertFile` (and optionally `alertAfterFailures`, default 2) in the Watchdog configuration: after that many consecutive failed reads it appends one JSON line `{schema, at, kind: "unreachable", url, failures, since, message}` to the file, and one `{kind: "recovered"}` line when the service answers again. It writes at most one unreachable record until recovery, so an external scheduled task can send or escalate the file without duplicating messages. The same state and log are still written while the service is down, so a stopped service is visible instead of silent.

```json
{
  "url": "http://127.0.0.1:3083",
  "report": false,
  "stateDir": "C:\\Users\\me\\.dsh\\watchdog\\state",
  "alertFile": "C:\\Users\\me\\.dsh\\watchdog\\alerts.jsonl",
  "alertAfterFailures": 2
}
```

The Watchdog snapshot also reports `session-missing` when a running Assignment has no live worker Session in the service. Recovery is disabled by default; set `DSH_SUPERAGENT_WATCHDOG_RECOVERY=enforce` in the service environment (then restart the service once) to let the full Watchdog agent request one retry for such a Ticket:

```
node scripts\dsh-superagent --profile superagent --url http://127.0.0.1:3082 watchdog recover ^
  --ticket <ticket id> --reason "<one-sentence evidence>" --snapshot-at "<snapshot.at>"
```

The server rechecks the live Session registry, the snapshot freshness (ten minutes), the executor pause and the per-Session ceiling of one retry, records an audit row, and never restarts the service. A refused or failed attempt is reported and must not be retried; the agent prompt allows exactly this command for `session-missing`, never the raw retry/stop API. The prompt and wrapper are versioned in the Watchdog artifact, so rebuild and install the artifact after changing this behavior. P3's service/host checks and independent Feishu delivery are still open.

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

   List personal CLIs, such as one signed in to your own account, as blocked commands. When a Ticket ends, the Executor reclaims its linked worktree and deletes its local `agent/<name>` branch once the worktree is clean and every commit is on a remote (or on the ref the prepare command fetched); a directory with uncommitted or unpushed work is kept, and a resumed Ticket runs the prepare command again. When the Ticket's own pull requests all merged, it also deletes the remote branch, but only while the remote tip is still the local HEAD; otherwise the remote branch stays.
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
| `cleanup` | Finished Ticket workspace cleanup; its failures stay off the health board because only a clean, fully remote checkout is removed |
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
- `executor`: `model`, `maxWorkers`, `offPeak`, `directory`, `prepare` and `blockedCommands`. `offPeak` is `{"enabled": false, "start": "22:00", "end": "08:00", "timezone": "Asia/Shanghai"}` by default: Tickets marked off-peak start new Assignments only inside that daily window (see [003 Execution](003-execution.md)). Alibaba Cloud Model Studio bills DeepSeek at off-peak rates from 22:00 to 08:00 Beijing time, peak 08:00–22:00 ([billing](https://help.aliyun.com/zh/model-studio/billing-for-model-studio)), which the defaults match. The processing pause is a setting of its own, `paused`, which `POST executor/pause` sets.

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

**Self-hosted development:** If the running superagent develops this repository, do not have it perform the in-place upgrade and restart below from its own worker session. Validate the candidate in an isolated task worktree and test instance first; then use an operator or deployment supervisor independent of the service to release, check health, and roll back if needed during an approved maintenance window. Use one non-production instance for both development and candidate validation, with separate profiles, DSH homes, state, control files, ports, credentials, and external sources; separate worktrees alone are not enough. Enable Feishu only on production and give the test instance no production bot credentials or CLI configuration. Before resuming an old ticket, verify its worktree and Session working directory. See the repository-root `AGENTS.md` for the local target topology, unresolved observations, and protection rules. Before cutover, take and verify a consistent backup and retain a compatible previous version. Reconcile data and external side effects created after the backup before rollback; copying a single live SQLite file is not necessarily a consistent backup.

The steps below apply only to deployments where an in-place upgrade has been explicitly deemed appropriate; they are not an automated self-hosted release procedure:

1. Wait until no Executor is in the middle of a turn.
2. Back up `<stateDir>/orchestrator.sqlite`.
3. Run `git pull && pnpm install && pnpm build`.
4. Run `scripts/dsh-superagent restart` and inspect its status.

On Windows, run the same steps in PowerShell; `&&` works in PowerShell 7, and the service command is
`pwsh scripts\dsh-superagent.ps1 restart`. The entry takes only the action (and an optional `-Config`/`-RespectStop`);
target facts stay in `%USERPROFILE%\.dsh-superagent\service.json`, created from `examples/service.windows.json`.

A restart ends running Assignments and starts replacements with recovery notes. Team text and overridden prompt parts are retained; parts without overrides follow the new defaults. Review parts marked **Default updated** after upgrading.

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
| A finished Ticket's worktree stays at `<stateDir>/work/…` | It has uncommitted or untracked changes, commits not on a remote, another checked-out branch, or is not a linked worktree. Commit and push or discard the work; the next host start tries the cleanup again |
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
