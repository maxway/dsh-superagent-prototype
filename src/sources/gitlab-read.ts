/** Read-only GitLab conversation, merge request, pipeline and repository inspection for assessments and workers. */
import { z } from 'zod'
import type { ThreadFact } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'
import { DiscussionSchema, IssueSchema, MergeRequestSchema, NoteSchema, gitlabPage, isHumanUser, type GitlabKind } from './gitlab-trigger.ts'

/** The numeric project id of the active GitLab deployment, as an API path prefix. */
export function projectPath(commands: Commands): string {
  const project = commands.deployment.gitlab
  if (!project) throw new Error('This deployment has no GitLab project')
  return `projects/${project.projectId}`
}
function message(note: z.infer<typeof NoteSchema>, url?: string): ContextMessage {
  const position = note.position
  return { id: String(note.id), from: note.author.username, at: note.created_at, text: note.body ?? '',
    ...!isHumanUser(note.author) ? { bot: true as const } : {}, ...url ? { url: `${url}#note_${note.id}` } : {},
    ...position?.new_path ? { path: position.new_path, ...position.new_line != null ? { line: position.new_line } : {} } : {} }
}
function notesUrl(commands: Commands, kind: GitlabKind, iid: number): string {
  return `${projectPath(commands)}/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}/notes`
}
async function notesPage(commands: Commands, kind: GitlabKind, iid: number, page: number) {
  const listed = await commands.glabApi(z.array(z.unknown()), `${notesUrl(commands, kind, iid)}?sort=asc&order_by=created_at&per_page=100&page=${page}`)
  const notes = listed.flatMap(value => { const parsed = NoteSchema.safeParse(value); return parsed.success && !parsed.data.system ? [parsed.data] : [] })
  return { notes, more: listed.length === 100 }
}
/** Reads an issue or merge request description, a page of its notes, one discussion, or a pipeline snapshot. */
export async function readGitlab(commands: Commands, resource: string): Promise<unknown> {
  const checks = /^gitlab\/mrs\/([1-9]\d*)\/checks$/.exec(resource)
  if (checks) return readMergeRequestChecks(commands, Number(checks[1]))
  const match = /^gitlab\/(issues|mrs)\/([1-9]\d*)(?:\/(comments|discussions|checks)(?:\/([^/]+))?)?$/.exec(resource)
  if (!match) throw new Error('Use gitlab/issues/<iid>, gitlab/mrs/<iid>, or append /comments/<page>, /discussions/<discussion-id> or /checks')
  const [, listed, iid, section, page = '1'] = match
  const kind: GitlabKind = listed === 'issues' ? 'issue' : 'mr'
  const number = Number(iid)
  const path = `${projectPath(commands)}/${kind === 'mr' ? 'merge_requests' : 'issues'}/${number}`
  if (!section) {
    const item = kind === 'mr' ? await commands.glabApi(MergeRequestSchema, path) : await commands.glabApi(IssueSchema, path)
    const title = item.title, body = 'description' in item ? item.description ?? '' : ''
    const branches = 'source_branch' in item ? { head: item.source_branch, ...item.target_branch ? { base: item.target_branch } : {} } : {}
    const merged = 'merged_at' in item && item.merged_at ? { merged: true } : {}
    return { number, title, state: item.state, ...merged, ...branches, id: String(number), from: item.author.username, at: item.created_at,
      text: body, url: item.web_url, ...!isHumanUser(item.author) ? { bot: true } : {} }
  }
  if (section === 'checks') {
    if (kind !== 'mr') throw new Error('Checks require a merge request')
    if (match[4]) throw new Error('Checks do not take a page number')
    return readMergeRequestChecks(commands, number)
  }
  if (section === 'discussions') {
    if (kind !== 'mr') throw new Error('Discussions require a merge request')
    if (!match[4]) throw new Error('Name the discussion: gitlab/mrs/<iid>/discussions/<discussion-id>')
    const discussion = await commands.glabApi(DiscussionSchema, `${path}/discussions/${encodeURIComponent(match[4])}`)
    const messages = discussion.notes.filter(note => !note.system).map(note => message(note, gitlabPage(hostOf(commands), commands.deployment.repository, kind, number)))
    return { messages, body: { messages } }
  }
  const pageNumber = Number(page)
  const { notes, more } = await notesPage(commands, kind, number, pageNumber)
  const messages = notes.map(note => message(note, gitlabPage(hostOf(commands), commands.deployment.repository, kind, number)))
  return { messages, ...more ? { next_resource: `gitlab/${listed}/${number}/${section}/${pageNumber + 1}` } : {} }
}
const PipelineSchema = z.looseObject({ id: z.number(), status: z.string(), web_url: z.string().nullish(), sha: z.string().nullish() })
export interface GitlabChecks { pipeline: z.infer<typeof PipelineSchema> | undefined; mr: z.infer<typeof MergeRequestSchema> }
/** Reads a merge request's head pipeline without emitting a trigger. */
export async function readMergeRequestChecks(commands: Commands, iid: number): Promise<GitlabChecks> {
  const mr = await commands.glabApi(MergeRequestSchema, `${projectPath(commands)}/merge_requests/${iid}`)
  const head = mr.head_pipeline
  const pipeline = head?.id ? await commands.glabApi(PipelineSchema, `${projectPath(commands)}/pipelines/${head.id}`) : undefined
  return { pipeline, mr }
}
/** A compact fact for a merge request card; a running pipeline has no problem, a failed one does. */
export function pipelineFact(status: string | undefined): ThreadFact {
  if (!status) return { label: 'CI', value: { zh: '未运行', en: 'not run' } }
  if (status === 'failed') return { label: { zh: 'CI 失败', en: 'CI failed' }, value: status, problem: true }
  if (['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'scheduled'].includes(status)) return { label: { zh: 'CI 进行中', en: 'CI running' }, value: status }
  return { label: 'CI', value: status }
}
/** Reads a non-hidden file or directory from the project's default branch; hidden entries and `node_modules` are rejected. */
export async function readGitlabRepositoryPath(commands: Commands, path: string, kind: 'file' | 'directory'): Promise<string> {
  const project = commands.deployment.gitlab
  if (!project) throw new Error('This deployment has no GitLab project')
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('Only non-hidden repository source paths are available')
  const prefix = projectPath(commands)
  const ref = encodeURIComponent(project.defaultBranch)
  if (kind === 'file') return commands.glabApi(`${prefix}/repository/files/${encodeURIComponent(parts.join('/'))}/raw?ref=${ref}`)
  const entries = await commands.glabApi(z.array(z.looseObject({ name: z.string(), type: z.string().nullish() })),
    `${prefix}/repository/tree?path=${encodeURIComponent(parts.join('/'))}&ref=${ref}&per_page=100`)
  return entries.map(entry => entry.name).filter(name => !name.startsWith('.') && name !== 'node_modules').sort().join('\n')
}
/**
 * Context reader for a GitLab Trigger: pages the issue or merge request's notes, and treats the description as the
 * first message of the first page. A pipeline trigger has no conversation, so its Trigger is its context.
 */
export const gitlabThreadContext: ThreadContext<unknown> = {
  messageId: trigger => trigger.meta.ci === true ? trigger.id
    : trigger.meta.noteId !== undefined ? String(trigger.meta.noteId) : `${trigger.meta.kind === 'mr' ? 'mr' : 'issue'}-${trigger.meta.iid}`,
  read: async (commands, trigger, part, cursor) => {
    if (trigger.meta.ci === true) {
      const messages = [{ id: trigger.id, from: 'CI', at: trigger.at, text: trigger.text, bot: true as const }]
      return { messages, body: { status: 'pipeline', messages }, status: 'pipeline' }
    }
    const kind: GitlabKind = trigger.meta.kind === 'mr' ? 'mr' : 'issue'
    const iid = Number(trigger.meta.iid)
    if (!iid) throw new Error('The GitLab Trigger names no issue or merge request')
    const page = cursor ? Number(cursor) : 1
    const offset = part === 'root' || part === 'parent' ? 1 : page
    const { notes, more } = await notesPage(commands, kind, iid, offset)
    const messages = notes.map(note => message(note, gitlabPage(hostOf(commands), commands.deployment.repository, kind, iid)))
    if (offset === 1) {
      const item = kind === 'mr'
        ? await commands.glabApi(MergeRequestSchema, `${projectPath(commands)}/merge_requests/${iid}`)
        : await commands.glabApi(IssueSchema, `${projectPath(commands)}/issues/${iid}`)
      const description = { id: `${kind}-${iid}`, from: item.author.username, at: item.created_at, text: `${item.title}\n\n${item.description ?? ''}`,
        url: item.web_url, ...!isHumanUser(item.author) ? { bot: true as const } : {} }
      messages.unshift(description)
    }
    return { messages, ...more ? { next: String(offset + 1) } : {}, body: { messages } }
  },
}
function hostOf(commands: Commands): string {
  return commands.deployment.gitlab?.host ?? `https://${commands.deployment.git.host}`
}