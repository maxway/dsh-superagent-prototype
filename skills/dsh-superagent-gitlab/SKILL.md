---
name: dsh-superagent-gitlab
description: Read GitLab issues, merge requests and discussions, and deliver work with glab.
---

This deployment uses GitLab as its Git host: `DSH_SUPERAGENT_GITLAB_*` in the execution environment names the project, account and commit email, and `gh` is not the agent's CLI here. Use `glab` for every GitLab operation. Never push to another account or repository.

Workers use `orchestrator_read` for repository context: `gitlab/issues/<iid>` or `gitlab/mrs/<iid>` for the description; `gitlab/issues/<iid>/comments/1` or `gitlab/mrs/<iid>/comments/1` for notes; `gitlab/mrs/<iid>/discussions/<discussion-id>` for a diff discussion; `gitlab/mrs/<iid>/checks` for the head pipeline. A page names `next_resource` while another may follow.

Deliver through a merge request:
- Work on a branch whose last path segment is `$DSH_SUPERAGENT_NAME`, for example `agent/$DSH_SUPERAGENT_NAME`; commit as the author the Delivery requirements name, otherwise as `$DSH_SUPERAGENT_GITLAB_ACCOUNT` with `$DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL`.
- Push with `git push -u origin <branch>`; `glab` supplies the credential helper.
- Open the MR with `glab mr create --source-branch <branch> --target-branch <base> --title <title> --description <text> --yes`. Record the returned MR iid with `orchestrator_report` as `pr_number`, which binds it to the ticket. On a later report use the same `pr_number`.
- Reply in the original discussion with `glab mr note <iid> --message <text>` or `glab issue note <iid> --message <text>`. Do not use the GitHub CLI or GitHub API.
- For a diff discussion, read it from `gitlab/mrs/<iid>/discussions/<discussion-id>` and reply with `glab api "projects/<project path with / written as %2F>/merge_requests/<iid>/discussions/<discussion-id>/notes" --method POST --raw-field body=<text>`, using the project path from `$DSH_SUPERAGENT_GITLAB_PROJECT`. Resolve it by updating the discussion: `glab api "projects/<project path>/merge_requests/<iid>/discussions/<discussion-id>?resolved=true" --method PUT`.
- A pipeline that fails is reported as `gitlab/mrs/<iid>/checks`; read its jobs with `glab ci view <pipeline-id>` before changing code.

Before substantial work on a new human request or review comment, call `orchestrator_ack` with its original trigger ID and a brief request-specific `text`. Do not acknowledge bots or pipeline notices. Answer and resolve discussions as the Communication section says. A person merges every merge request unless the Delivery requirements name a merge command; never merge on behalf of a reviewer.