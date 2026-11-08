# Feishu execution and read-only reply permissions: before and after

Scenario: **Superagent → 设置 → 评估 → 策略**, the Feishu part of the Policy and its admission
table, in two isolated non-production candidates at a 1440 × 900 Chromium window (the captured content
area is 1424 × 805), light theme, Chinese UI. Each candidate had its own profile, state directory and
port under a temporary DSH home, with an identically seeded state: one Feishu chat `oc_team` receiving
every message, Alice (`ou_alice`) on the allowed list, no Policy rules, and the chat's
unlisted-addressed cell starting at **忽略**. The Feishu Source is off in both candidates; no
production state, credentials, bot CLI or chat content is used. The baseline linked a detached
`12a0559` worktree; the candidate linked this branch's worktree.

- `before-policy-feishu-admission.png` — baseline `main` @ `12a0559`. The allowed list is labelled
  **能发起工作的飞书用户**, and an unlisted sender's message in a chat can only be an explicit request,
  an inferred candidate or ignored.
- `after-policy-feishu-admission.png` — this change. The allowed list is labelled
  **能发起执行（修改、提交 PR 等）的飞书用户**. The same group chat's unlisted-addressed cell now offers
  **只读答疑** and is set to it and saved: anyone there, a person, bot or agent, may ask a read-only
  question that is answered after read-only investigation without executing. The footnote explains the
  two permissions and that direct messages stay limited to listed senders; the direct row shows
  **忽略** and its cell offers no read-only reply.

The only intended difference is this change. The before build shows the same page except that a
read-only reply is not offered; the after capture shows that group cell saved as **只读答疑**, with the
direct row still **忽略** and without a read-only reply choice. The test instances were seeded with the
same state; any save toast or save bar was cleared before the capture. No private Feishu content or
credentials appear in the images.