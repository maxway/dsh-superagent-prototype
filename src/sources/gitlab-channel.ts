/** GitLab outbound channel: posts issue and merge request notes under the agent account. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { gitlabPage, type GitlabKind } from './gitlab-trigger.ts'

const NoteSchema = z.looseObject({ id: z.number(), body: z.string().nullish(), author: z.looseObject({ username: z.string() }) })
/** A note target that no longer exists is gone; GitLab reports 404 for both a deleted target and lost access. */
const gone = (error: unknown): boolean => error instanceof CliError && (error.code === 404 || error.code === 410)
/** Posts a note with an embedded HTML marker so retries do not create duplicate comments. */
export async function sendGitlab(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const project = commands.deployment.gitlab
  if (!project) throw new Error('The GitLab Source has no working project')
  const kind = message.channel.address.kind === 'mr' ? 'mr' : 'issue'
  const iid = Number(message.channel.address.iid)
  if (!iid) throw new Error('Missing GitLab reply target')
  const path = `${projectPath(commands)}/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}/notes`
  try {
    const marker = `<!-- dsh-superagent:${message.id} -->`
    const recent = await commands.glabApi(z.array(z.unknown()), `${path}?sort=desc&order_by=created_at&per_page=100`)
    const mine = recent.some(value => {
      const note = NoteSchema.safeParse(value)
      return note.success && sameName(note.data.author.username, commands.deployment.git.login) && (note.data.body ?? '').includes(marker)
    })
    if (mine) return 'sent'
    await commands.glabApi(z.unknown(), path, '--method', 'POST', '--raw-field', `body=${message.text}\n\n${marker}`)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
function projectPath(commands: SourceContext['commands']): string {
  const project = commands.deployment.gitlab
  if (!project) throw new Error('The GitLab Source has no working project')
  return `projects/${project.projectId}`
}
export function gitlabLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const kind: GitlabKind = address.kind === 'mr' ? 'mr' : 'issue'
  const iid = Number(address.iid)
  const host = links.gitlab?.host
  const url = address.url ?? (host && links.repository ? gitlabPage(host, links.repository, kind, iid) : '')
  return { url, label: kind === 'mr' ? { zh: `GitLab !${iid}`, en: `GitLab !${iid}` } : { zh: `GitLab #${iid}`, en: `GitLab #${iid}` } }
}