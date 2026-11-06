# Windows stage 3: visual evidence

Scenario: Superagent panel → Settings → Execution, with the **Prepare command** hint tooltip open, in the same
throwaway DSH profile, the same 1440×900 Chromium window, the same light theme and the same setup-pending state
copy. Both captures use the same interaction (open the panel, Settings, Execution, open the hint), so the only
difference is the revision under test.

- `before-execution-settings.png`: the baseline, `main` at `8d4c416`, served by a throwaway DSH profile that links
  a build of that revision. The hint says the command runs with `sh`.
- `after-execution-settings.png`: this ticket's branch, served by the same throwaway profile after relinking it to
  the branch build. The hint names the platform shell: `sh` on POSIX, PowerShell 7's `pwsh` on Windows, with
  `$env:DSH_SUPERAGENT_DIR` in PowerShell.

The screenshots contain no Feishu content, credentials, host details or other private material.
