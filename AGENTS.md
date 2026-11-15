# Agent instructions

## Pull request language

Write pull request titles and descriptions in Simplified Chinese. Keep subsequent PR description updates and PR discussion replies in Simplified Chinese as well, unless the user explicitly requests another language. Preserve code identifiers, commands, paths, and quoted technical terms as appropriate; translate the surrounding explanations.

## Local development and deployment

Follow the user's instructions for the selected checkout and deployment. An explicit deployment request includes the necessary build, installation, service stop, start and verification; do not require a second confirmation solely because the target is local or production. Use the user's selected scope, preserve unrelated work, and report actual errors and downtime accurately.

The local production runtime and its dated observations are described in [deployment](docs/006-deployment.md#production-host-for-this-checkout). Check the actual service, configuration and deployment entry before acting; documentation, historical incidents and uninstalled candidates are not evidence of the current state. Explain concrete technical failures rather than treating historical precautions as authorization rules.

Use isolated test resources when practical and verify the target before lifecycle operations. When changing Windows deployment, service lifecycle, worktree preparation, runtime paths, isolation, or release procedures, update the relevant deployment documentation and distinguish verified behavior from historical observations and plans.
