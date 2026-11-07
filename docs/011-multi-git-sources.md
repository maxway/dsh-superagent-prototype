# 011 Multiple Git Sources

An assessment of whether one dsh-superagent deployment can work with several Git sources, either concurrently or by switching, and of the confusion that multiple projects would introduce. This document records the current behavior, the layers that assume exactly one source, feasible options and a staged recommendation. It does not implement any of them.

## Summary

- **Today one deployment has one active Git Source and one repository or project.** A Ticket therefore always has one remote, one prepare command context and one change request. `gitProvider` refuses two configured Git Sources and refuses none. The other provider's CLI is deliberately blocked.
- **Switching already exists, but it is a deployment operation, not a UI toggle.** It needs the target provider's plugin installed, a source switch, a plugin restart and a transient setup state; running Assignments are interrupted and old-host Tickets are not re-homed.
- **Concurrent multi-source is technically feasible, but it is a coordinated redesign of source identity, not a configuration change.** The core domain already stores a `source` on Triggers, Threads and Channels; the problem is that this identifier is also the Source *kind*, and many application layers read one global `Deployment`.
- **Multiple projects will be confusing if they are added without an explicit project scope.** The confusion is manageable, and worth removing before concurrency: every Ticket, Thread, policy entry, execution environment, repository read and reply must carry the source instance. Each group chat binds one project, and each private chat also binds one project, which the person may rebind themselves; both give Feishu traffic a project. Without such scoping, Feishu routing, `#12` lookups, branch-to-Ticket binding, permissions and checkouts become guesses.
- **Recommendation.** First harden switching while keeping exactly one active Git Source. If concurrent work is required, add same-host multi-project instances before cross-host concurrency. Do not configure two Git Sources in one deployment before the instance work; do not make one Ticket span projects in the first version.

## What the deployment does today

The bundle installs both Git plugins but enables one by default: GitHub is enabled and GitLab is disabled in `cordis.patch.yml`; a profile can enable both plugins, but the Source settings still resolve exactly one active Git host. The relevant behavior is:

- Setup resolves one `Deployment` with one `repository`, one `GitIdentity` and, for GitLab, one project id and host. `gitProvider` returns `github` or `gitlab`, and refuses a pair of configured Sources or none.
- Setup writes one worker git configuration, one credential helper for that host, and command shims in which the inactive provider's CLI fails. Workers see `DSH_SUPERAGENT_GIT_PROVIDER` and one provider's repository/project variables.
- A Source kind has one stored instance in `settings.sources`, keyed by the kind id, one health entry, and one watcher. Both kinds may be registered, but the kind whose provider is not active parks itself as `sourceOff`.
- Thread keys are kind-wide: `github:<number>`, `gitlab:mr:<iid>`, `gitlab:issue:<iid>`, `github:ci:<branch>` and `gitlab:ci:<branch>`. A Ticket's change request is parsed from those keys and read through the active provider.
- `Commands` restricts GitHub API paths to the configured repository and GitLab API paths to the configured project id. Repository reads for the assessment use the same single deployment.

### How switching works and where it stops short

Saving a Source's enable switch or a setup-read field (repository, CLI, account directory) triggers `Settings.save`, which validates the account and calls `setup.restart()`. The plugin restarts, setup resolves the new provider and rewrites the worker environment. Records for the old provider stay in the state directory, so switching back reuses its stored cursors and Tickets.

The gaps for a person switching hosts are:

1. The target provider's plugin must be installed; the default bundle disables GitLab, so moving from GitHub to GitLab starts with a profile edit and a service restart.
2. Enabling a second *configured* Git Source is refused (`multipleGitSources`). In practice the operator disables the current Source, passes through a setup state with no Git Source, then enables and configures the target.
3. A restart interrupts running Assignments and restarts them with a recovery note. Their Ticket origin, worktree remote and open change request still belong to the old host, but the worker environment now names the new host. The deployment documentation therefore asks the operator to finish or stop old Tickets first; nothing enforces that.
4. There is no per-Ticket host binding to fall back on, so a resumed old-host Ticket is not protected from acting through the new host.

## What "multiple sources" can mean

| Reading | Example | What has to be true |
| --- | --- | --- |
| A. Switch the active source | A deployment moves from GitHub to GitLab, or from one GitLab project to another | One source at a time is enough; switching should be safe and should not strand Tickets |
| B. Several projects on one host | One GitLab instance, `team/widgets` and `team/service`, both watched concurrently | Source instances, per-project threads, policies and execution environments; one provider account |
| C. Several hosts concurrently | GitHub and GitLab, both watched and both able to deliver | B plus per-host CLI, credentials, commit identity, skills and health |
| D. One Ticket across projects | A Ticket changes a library and its consumer | Multi-repository workspace, multi-remote commits and change requests; a different product decision |

The question "will several different projects be confusing?" is about B, and partly C. D is the version that fundamentally conflicts with the current "one Ticket, one remote" design.

## Findings: where one source is assumed

The core is less coupled than the application glue. `Trigger.source`, `ThreadRef.source` and `ChannelRef.source` already exist, and the Engine treats them as opaque keys. The following table separates what already generalizes from what assumes a single source.

| Layer | Current assumption | What multiple sources needs |
| --- | --- | --- |
| Settings identity | `settings.sources` is keyed by kind id; `SourceInstance.id` is the kind; policy parts and `source:<id>` settings blocks use the same key | A stable instance id distinct from the kind, a stored `kind`, and a migration that keeps existing blocks working |
| Policy | Allowed senders, bots and admission rows are stored per kind | Per-instance policy so a person allowed in one project is not implicitly allowed in another |
| Setup | One `Deployment` with one repository, account, commit email and CLI | A resolved identity per Git source (or a shared identity plus per-instance repository facts) and a setup report per instance |
| Worker environment | One `DSH_SUPERAGENT_GIT_PROVIDER` and one provider's repository/project variables; the inactive CLI shim fails | Per-Ticket source variables; both CLIs reachable for C; one credential helper per host |
| Commands | API paths are restricted to the one repository or project id | A `Commands` bound to the instance that the Trigger or Ticket names |
| Watchers | One loop per kind, one health entry per kind, `ctx.config(kind)`, one webhook listener per kind | One loop and health entry per instance; per-project webhook registration; GitHub notifications remain account-wide but must filter per repository |
| Thread identity | Keys such as `github:12` and `gitlab:ci:main` are kind-wide; `find('#12')` returns one thread | Instance-qualified keys (or an instance-scoped lookup) plus a compatibility path for existing keys |
| Change requests | `changeOf` parses the provider from a follow key; reads and claims use the single active provider; `pr_number` alone disambiguates | The follow key must carry the instance, and the read/claim must use that instance; number-only input is ambiguous across projects |
| Repository reads | The assessor reads one repository through the active provider | The Trigger's instance supplies the repository; cross-project reads need an explicit instance |
| Worker tools and prompts | One Git skill is registered, and the worker prompt says to use the active host only | Per-Ticket Git skill/environment, or one skill that names the instance and both CLIs for C |
| UI | One card per kind, no project dimension on source, ticket or thread views | Per-instance cards, policy sections, health and project labels/filters |
| Operations | One service account per CLI, one git config, one webhook port | One account per host for C; per-project webhook hooks sharing a listener; per-instance rate-limit accounting |

Two details make B smaller than C:

- On one host, the CLI, configuration directory, commit email and git credential helper are shared. The variable part is the project/repository and the API path restriction.
- On two hosts, the worker environment must keep both CLIs usable instead of failing the inactive one, and the git configuration needs a credential helper per host. The worker prompt and git skill also stop having a single "active host".

## Feasibility by option

| Option | Feasibility | Main work | Risk |
| --- | --- | --- | --- |
| A. Harden switching | High; small | Explicit active-source state, switch preflight that names open Tickets, block or freeze old-host Ticket resume, one switch action instead of a transient no-source state | Low; it changes operations, not the domain |
| B. Same-host multi-project | High; medium-large, coordinated | Instance identity, per-instance registry/settings/policy/health, per-instance watcher and commands, thread-key namespace and migration, per-Ticket environment and prepare context, per-group and per-private-chat project binding with rebinding, UI | Medium; rebinding a chat must not re-home open Tickets |
| C. Multi-host concurrent | Feasible; larger | B plus both CLI/account paths, per-host credential helpers, per-Ticket Git skill and provider variables, per-host setup problems and rate limits | Medium-high; credential and identity mistakes have wider consequences |
| D. One Ticket across projects | Not recommended for the first version | Multi-repo workspace, multi-remote commit/change-request handling, cross-repo CI and delivery semantics | High; it changes the Ticket contract and the prepare-command contract |

There is no fundamental blocker in the domain model for B or C: the Engine already routes by `source`, and the database stores that value. The size comes from the application layer, where "source" currently means "kind" and "the deployment" means "the one Git context". A credible implementation treats the source instance as the unit and threads it through setup, commands, threads, policy and the execution environment.

## The confusion question

The short answer is yes under today's implicit model, and no if the project becomes an explicit scope. Multiple projects are not inherently chaotic, but they are chaotic if only the configuration layer changes. The concrete confusion vectors are:

| Confusion | Why it arises | Mitigation |
| --- | --- | --- |
| Which project does a Feishu request mean? | A Feishu Trigger carries no Git project; a group or a private chat can bind one | Bind each group chat and each private chat to one source instance; a private chat's binding can be changed by the person themselves. An unbound chat has no project to route to, so it must ask or refuse. Rebinding applies to new requests; open Tickets stay with their original project. Never guess |
| `#12`, `!12`, or the same branch name in two projects | Thread keys and branch-to-Ticket binding are kind-wide; `find` returns one thread | Instance-qualified keys and lookups; scope auto-binding by instance; show the project next to every number and link |
| The wrong checkout | One prepare command, one deployment-wide repository variable | Per-Ticket instance variables; the prepare command clones the Ticket's project, not "the" project |
| Permission leakage | One allowed-sender list per kind would apply everywhere | Per-instance policy; a sender allowed on one project is not allowed on another until listed there |
| The wrong repository read | The assessor reads the one active repository | Read the Trigger's instance by default; require an explicit instance for another project |
| The wrong CLI or host | One active provider and a failed inactive CLI | Per-Ticket provider and instance; both CLIs usable only for C; never infer the host from global state |
| Replies on the wrong thread | Outbox resolves the channel by source kind | Resolve the channel by instance, then dispatch to the kind's adapter |
| A Ticket that mixes projects | One worktree, one remote, one prepare command | Keep one project per Ticket; route cross-project requests to separate Tickets |

The group convention is the right shape: bind a new group to one source instance when it is set up — the operator records its chat id with the project, because the bot cannot list chats — and every request in that group has a project and can be scoped by policy. Private chat uses the same rule: one project bound to the conversation, and the person can rebind it themselves, for example with a binding command. The binding applies to new requests; Tickets already open stay with their original project. A chat with no binding has no project to route to, so it must ask or refuse. Silence followed by a guessed project is the failure to avoid.

The pattern is the same in every row: make the project an explicit, propagated piece of context. If that is done, a person sees which project a Ticket belongs to, a worker knows which repository and credentials apply, and the assessor reads the right files. If it is not done, the engine's defaults will silently choose one project, which is exactly the confusion the question anticipates.

## Recommendation

1. **Now: harden switching, keep one active Git Source.** Make the active host visible, add a switch check that lists open Tickets on the old host and requires an explicit drain/stop decision, and prevent an old-host Ticket from resuming against the new host. This delivers the "switchable" fallback with predictable behavior and no new domain model.
2. **Next, if concurrency is needed: same-host multi-project instances.** Introduce an instance id separate from the kind, make registry, settings, policy, health, watcher, commands and thread keys instance-scoped, add per-Ticket project variables, bind each group and each private chat to one instance (the person can rebind a private chat), and give the panel project labels and filters. Keep one provider account and one CLI. This covers most real "several projects" needs at the lowest risk.
3. **Then, only for a real requirement: cross-host concurrency.** Add both CLI/account paths, per-host git credentials, per-Ticket Git skills and health, and per-host setup problems. Treat C as a second phase of B, not a separate architecture.
4. **Do not start with D.** One Ticket across projects changes the execution contract more than the source model. Route such requests to separate Tickets until a concrete workflow proves otherwise.

A reasonable order is A, then B, then C. A is useful even if B is never built. B is the version that answers "several different projects" without multiplying credentials. C is only justified when the organization actually works through both GitHub and GitLab at the same time.

## Open questions for the operator

- Is the need several projects on one GitLab instance or GitHub organization, or genuinely GitHub and GitLab together?
- When a group is bound to one project, may a request there ask for another project's work, or must it move to that project's group?
- Must one Ticket ever change two projects? If yes, that is option D and should be designed as such; if no, one project per Ticket is the simpler contract.
- Should allowed senders and bots be global across projects or per project? The current per-kind model is global within a kind; per-instance is the safer default.
- Is a switch allowed while Tickets are running, or should it wait for a drain? The current answer is "finish or stop them first", but nothing enforces it.

## Evidence

| Area | Where |
| --- | --- |
| One provider, one deployment | `src/deployment.ts` (`GitProvider`, `Deployment`), `src/app/setup.ts` (`gitProvider`) |
| Refusal of zero or two configured Sources | `src/setup.ts` (`multipleGitSources`, `gitSourceUnset`) |
| One instance per kind | `src/policy.ts` (`settings.sources`), `src/sources/registry.ts` (`instances`, `instance`, `resolve`) |
| Inactive provider blocked | `src/infra/environment.ts` (worker shims and `worker-gitconfig`) |
| Active provider variables | `src/app/execution-environment.ts`, `src/sources/github.ts`, `src/sources/gitlab.ts` |
| Kind-wide thread keys | `src/sources/github-trigger.ts`, `src/sources/gitlab-trigger.ts`, `src/sources/git-change.ts` |
| Single repository in commands and assessment | `src/infra/commands.ts`, `src/app/assessment.ts` |
| One Git skill | `src/app/prompts.ts` (`gitSkill`) |
| Switching semantics | [006 Deployment](006-deployment.md), `src/app/settings.ts` (`save`) |
| One Ticket, one remote | [007 Architecture](007-architecture.md), `src/sources/git-change.ts` |