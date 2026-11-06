# Windows stage 2: visual evidence

Scenario: Superagent panel → Settings → Sources, GitHub card with **高级** open, in the same throwaway DSH
profile, the same 1440×900 Chromium window, the same light theme and the same setup-pending state copy. Both
captures show the same interaction (open the panel, Settings, Sources, Advanced) and are cropped to the GitHub
card, so the only difference is the revision under test.

- `before-github-source.png`: the baseline, `main` at `1f5ca6f`, served by a throwaway DSH profile that links a
  build of that revision.
- `after-github-source.png`: this ticket's branch, served by the same throwaway profile after relinking it to
  the branch build. It adds **智能体账号的配置目录** (`configDir`) under the advanced section: the
  `GH_CONFIG_DIR` the plugin and its workers inherit, empty for the documented agent directory.

The screenshots contain no Feishu content, credentials, host details or other private material.
