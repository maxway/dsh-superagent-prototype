# Off-peak scheduling: visual evidence

Scenario: Superagent panel → Settings → Execution, in the same paused test deployment and the same 1440×900
Chromium window, English UI, cropped to the Executor card. Both captures use the same state copy, the same
browser profile and the same interaction (open the panel, Settings, Execution), so the only difference is the
revision under test.

- `before-execution-settings.png`: the baseline, `main` at `6a1aa71`, served by a throwaway DSH profile that
  links a build of that revision.
- `after-execution-settings.png`: this ticket's branch, served by the same throwaway profile after relinking it
  to the branch build. It adds the **Off-peak window** section: an enable switch, the window's start and end
  times, and its time zone.

The screenshots contain no Feishu content, credentials, host details or other private material.