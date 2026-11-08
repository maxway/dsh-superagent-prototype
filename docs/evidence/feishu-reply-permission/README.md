# Feishu execution and read-only reply permissions: before and after

Scenario: **Superagent → 设置 → 评估 → 策略**, the Feishu part of the Policy and its admission
table, in two isolated non-production candidates at a 1440 × 900 Chromium window (the captured content
area is 1424 × 805), light theme, Chinese UI. Both candidates have the same state: one Feishu chat
`oc_team` receiving every message, Alice (`ou_alice`) on the allowed list, no Policy rules, and the
chat's unlisted-addressed cell starting at **忽略**. Feishu is off in both candidates; no production
state, credentials, bot CLI or chat content is used.

- `before-policy-feishu-admission.png` — baseline `main` @ `12a0559`. The allowed list is labelled
  **能发起工作的飞书用户**, and an unlisted sender's message in a chat can only be an explicit request,
  an inferred candidate or ignored.
- `after-policy-feishu-admission.png` — this change. The allowed list is labelled
  **能发起执行（修改、提交 PR 等）的飞书用户**. The same chat's unlisted-addressed cell now offers
  **只读答疑** and is set to it and saved: anyone there, a person, bot or agent, may ask a read-only
  question that is answered after read-only investigation without executing. The footnote explains the
  two permissions.

The only intended difference is this change. The before build shows the same page and interaction
except that selecting a read-only reply is impossible; the after capture selects it in that cell and
saves. The test instance showed the save toast and a save bar while saving; the capture waits for them
to clear. No private Feishu content or credentials appear in the images.