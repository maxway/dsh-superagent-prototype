/** Normalizes GitLab issues, merge requests, notes/discussions and pipeline changes into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'gitlab'
/** A GitLab issue and a merge request have separate iid sequences, so the Thread key names both. */
export type GitlabKind = 'issue' | 'mr'
export const gitlabThread = (kind: GitlabKind, iid: number): string => `${SOURCE}:${kind}:${iid}`
export const gitlabChannel = (kind: GitlabKind, iid: number, url?: string): ChannelRef =>
  ({ source: SOURCE, thread: gitlabThread(kind, iid), address: { kind, iid: String(iid), ...(url ? { url } : {}) } })
export const gitlabPage = (host: string, repository: string, kind: GitlabKind, iid: number): string =>
  `${host}/${repository}/-/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}`
export const GitlabUserSchema = z.looseObject({ id: z.number(), username: z.string(), name: z.string().nullish(), bot: z.boolean().nullish() })
export type GitlabUser = z.infer<typeof GitlabUserSchema>
/** A GitLab note; a diff note carries `position` and a discussion reply carries no `type`. */
export const NoteSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), author: GitlabUserSchema, created_at: z.string(), updated_at: z.string().nullish(),
  system: z.boolean().nullish(), type: z.string().nullish(), noteable_type: z.string().nullish(), noteable_iid: z.number().nullish(),
  position: z.looseObject({ new_path: z.string().nullish(), new_line: z.number().nullish(), old_line: z.number().nullish(),
    head_sha: z.string().nullish() }).nullish(),
})
export type GitlabNote = z.infer<typeof NoteSchema>
export const IssueSchema = z.looseObject({
  iid: z.number(), title: z.string(), description: z.string().nullish(), state: z.string(), created_at: z.string(),
  updated_at: z.string(), web_url: z.string(), author: GitlabUserSchema,
})
export type GitlabIssue = z.infer<typeof IssueSchema>
export const MergeRequestSchema = z.looseObject({
  iid: z.number(), title: z.string(), description: z.string().nullish(), state: z.string(), created_at: z.string(),
  updated_at: z.string(), merged_at: z.string().nullish(), closed_at: z.string().nullish(), web_url: z.string(), author: GitlabUserSchema,
  source_branch: z.string(), target_branch: z.string().nullish(), sha: z.string().nullish(), source_project_id: z.number().nullish(),
  head_pipeline: z.looseObject({ id: z.number().nullish(), status: z.string().nullish(), web_url: z.string().nullish() }).nullish(),
  detailed_merge_status: z.string().nullish(), merge_status: z.string().nullish(), draft: z.boolean().nullish(),
  work_in_progress: z.boolean().nullish(),
})
export type GitlabMergeRequest = z.infer<typeof MergeRequestSchema>
export const DiscussionSchema = z.looseObject({ id: z.string(), notes: z.array(NoteSchema) })
/** True when GitLab reports a regular user rather than a bot or project/group access token identity. */
export const isHumanUser = (user: GitlabUser): boolean => user.bot !== true
export const mentions = (text: string, username: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@.])@${escapeRegExp(username)}(?![a-zA-Z0-9_.-])`, 'i').test(text)
const author = (user: GitlabUser, agent: string) => ({ actor: { source: SOURCE, id: user.username },
  human: isHumanUser(user) && !sameName(user.username, agent) })
function noteText(note: GitlabNote): string {
  const position = note.position
  const place = position?.new_path ? `${position.new_path}${position.new_line != null ? `:${position.new_line}` : ''}` : ''
  return [place, note.body ?? ''].filter(Boolean).join('\n\n')
}
/** Builds the Trigger of one issue or merge request description; the Agent's own description produces none. */
export function issueTrigger(issue: GitlabIssue, agent: string): Trigger {
  const body = issue.description ?? ''
  return { id: key('gitlab-issue', String(issue.iid)), source: SOURCE, threads: [{ source: SOURCE, id: gitlabThread('issue', issue.iid) }],
    ...author(issue.author, agent), at: issue.created_at, text: `${issue.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}), channel: gitlabChannel('issue', issue.iid, issue.web_url),
    url: issue.web_url, meta: { kind: 'issue', iid: issue.iid, author: issue.author.username, title: issue.title } }
}
/** Builds the Trigger of one merge request description; the Agent's own description produces none. */
export function mergeRequestTrigger(mr: GitlabMergeRequest, agent: string): Trigger {
  const body = mr.description ?? ''
  return { id: key('gitlab-mr', String(mr.iid)), source: SOURCE, threads: [{ source: SOURCE, id: gitlabThread('mr', mr.iid) }],
    ...author(mr.author, agent), at: mr.created_at, text: `${mr.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}), channel: gitlabChannel('mr', mr.iid, mr.web_url),
    url: mr.web_url, meta: { kind: 'mr', iid: mr.iid, author: mr.author.username, sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch ?? undefined, title: mr.title } }
}
/** Builds the Trigger of one note; the caller drops system notes and the Agent's own notes before calling this. */
export function noteTrigger(note: GitlabNote, ref: { kind: GitlabKind; iid: number; url?: string; author?: string; discussionId?: string }, agent: string): Trigger {
  const at = note.updated_at ?? note.created_at
  const id = key('gitlab-note', ref.kind, String(ref.iid), String(note.id), at)
  const url = ref.url ? `${ref.url}#note_${note.id}` : undefined
  return { id, source: SOURCE, threads: [{ source: SOURCE, id: gitlabThread(ref.kind, ref.iid) }], ...author(note.author, agent), at,
    text: noteText(note), ...(mentions(note.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(ref.kind, ref.iid, url), ...(url ? { url } : {}),
    meta: { kind: ref.kind, iid: ref.iid, noteId: note.id, ...(ref.discussionId ? { discussionId: ref.discussionId } : {}),
      ...(ref.author ? { author: ref.author } : {}), ...note.position?.new_path ? { path: note.position.new_path,
        line: note.position.new_line ?? note.position.old_line ?? null } : {}, ...note.type ? { noteType: note.type } : {} } }
}
/** Statuses that count as a failed pipeline; `canceled` and `manual` are not failures by themselves. */
export const FAILED_PIPELINE = new Set(['failed'])
export const RUNNING_PIPELINE = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'scheduled'])
export function pipelineSummary(status: string, where: string, read: string): string {
  const line = FAILED_PIPELINE.has(status) ? `CI failed on ${where}: pipeline ${status}`
    : RUNNING_PIPELINE.has(status) ? `CI ${status} on ${where}`
      : `CI passed on ${where}: pipeline ${status}`
  return `${line}\nRead ${read} for the pipeline and its jobs.`
}
/** Builds a trigger for a default-branch pipeline transition; it has no person to reply to, so it has no channel. */
export function branchPipelineTrigger(host: string, repository: string, branch: string, sha: string, revision: number, status: string, url: string): Trigger {
  return { id: key('gitlab-ci', `branch:${branch}`, String(revision)), source: SOURCE, threads: [{ source: SOURCE, id: `ci:${branch}` }],
    actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(), text: pipelineSummary(status, `${repository}@${branch}`, `gitlab/commits/${sha}/checks`),
    url, meta: { ci: true, branch, sha, revision, status } }
}
export function mergeRequestPipelineTrigger(mr: GitlabMergeRequest, revision: number, status: string, url: string): Trigger {
  return { id: key('gitlab-ci', 'mr', String(mr.iid), String(revision)), source: SOURCE, threads: [{ source: SOURCE, id: gitlabThread('mr', mr.iid) }],
    actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(), text: pipelineSummary(status, `MR !${mr.iid}`, `gitlab/mrs/${mr.iid}/checks`),
    channel: gitlabChannel('mr', mr.iid, mr.web_url), url, meta: { kind: 'mr', iid: mr.iid, ci: true, revision, status } }
}