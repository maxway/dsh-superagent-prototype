/** The explicit switch between Git hosts: which open Tickets the old host leaves behind, and the confirmation that accepts it. */
import { key, type Ticket } from '../core/index.ts'
import type { GitProvider } from '../deployment.ts'
import type { Settings } from '../policy.ts'

/** The Source kinds that can be the deployment's one active Git host, in a stable order. */
export const GIT_SOURCES = ['github', 'gitlab'] as const
export const isGitSource = (id: string): id is GitProvider => id === 'github' || id === 'gitlab'

/**
 * A Ticket belongs to the old host while it is open under that host: it was accepted there, it has no binding because it
 * predates bindings, or it follows a Thread of that host such as its pull request's. One already bound to a third host is
 * already unable to resume and does not hold up this switch.
 */
export const hostTickets = (tickets: readonly Ticket[], provider: GitProvider): Ticket[] => tickets.filter(ticket =>
  ticket.git?.provider === provider || !ticket.git || (ticket.follows ?? []).some(follow => follow.thread.startsWith(`${provider}:`)))

/** A fingerprint of the exact blocking set, so a confirmation cannot stand for a list that changed after it was shown. */
export const switchFingerprint = (provider: GitProvider, tickets: readonly Ticket[]): string =>
  key('git-host-switch', provider, ...tickets.map(ticket => ticket.id).sort())

/**
 * Refusal of a switch to `provider` until the person confirms the old host's open Tickets, or stops them first. The HTTP
 * layer returns its tickets and fingerprint, which the confirmation sends back.
 */
export class SourceSwitchConfirm extends Error {
  constructor(readonly provider: GitProvider, readonly tickets: readonly Ticket[], readonly fingerprint: string) {
    super(`${tickets.length} open ticket${tickets.length === 1 ? '' : 's'} belong to the ${provider} Git host. They cannot resume on another `
      + 'host: stop them first, or confirm the switch and keep them stopped.')
  }
}

/** The settings with exactly `provider` enabled among the Git Sources; every other Source keeps its own switch. */
export function switchSettings(settings: Settings, provider: GitProvider): Settings {
  const sources = Object.fromEntries(Object.entries(settings.sources).map(([id, source]) =>
    [id, isGitSource(id) ? { ...source, enabled: id === provider } : source]))
  // A plugin-only installation has no saved block for its Git Source yet; switching to it saves one with enabled on.
  sources[provider] = { enabled: true, config: {}, ...sources[provider] }
  return { ...settings, sources }
}