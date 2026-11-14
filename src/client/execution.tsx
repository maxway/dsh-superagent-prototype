/** Execution status view (active Tickets and pause control) and Execution settings group (Executor capacity and workspace environment). */
import { useRef, useState } from 'react'
import { TICKET_FILTERS, type TicketFilter } from '../app/api.ts'
import { LIMITS } from '../limits.ts'
import { usePoll, type SettingsView, type SourceView, type StateView } from './api.ts'
import { DisclosureRow, Icon, InfoTip, Input, Pill, Switch } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { usePanel } from './provider.tsx'
import { TicketLine } from './rows.tsx'
import { ConfigHistory, Field, Fields, ModelField, numberOf, useBlockDraft, useSettings } from './settings-kit.tsx'
import { localized } from './text.ts'
import { ConfirmButton, Hint, LabelValue, LoadMore, LoadState, Section, StatusHead } from './widgets.tsx'

export function ExecutionStatus({ filter: current, state, reload }: {
  filter: TicketFilter; state: StateView; reload: () => Promise<void>
}) {
  const { t, call, navigate } = usePanel()
  const [limit, setLimit] = useState(20)
  const { data, error, reload: reloadTickets } = usePoll(() => call('GET tickets', { query: { state: current, limit } }), [current, limit])
  // A missing or stale Watchdog heartbeat is a warning: silence is not proof that the observer is alive.
  const pulse = usePoll(() => call('GET watchdog', { query: { stale_minutes: 30 } }), [])
  const lastRun = pulse.data?.lastRun
  const heartbeatStale = !lastRun || lastRun.ageMinutes > (pulse.data?.staleMinutes ?? 30) * 2
  const heartbeat = lastRun ? t(heartbeatStale ? 'watchdogHeartbeatStale' : 'watchdogHeartbeat', { minutes: lastRun.ageMinutes })
    : t('watchdogNoHeartbeat')
  const install = pulse.data?.install
  const updatedAt = install?.at && Number.isFinite(Date.parse(install.at))
    ? new Date(install.at).toLocaleString(t('lang') === 'en' ? 'en-US' : 'zh-CN', { dateStyle: 'short', timeStyle: 'short' })
    : undefined
  const { paused, load: { maxWorkers } } = state
  // Pausing uses its own block revision so toggling pause does not invalidate an open Execution settings draft.
  const pause = async () => { await call('POST executor/pause', { body: { paused: !paused } }); await reload() }
  const status = state.setup.problem ? { tone: 'warning', label: t('executorWaitingSetup') } : paused ? { tone: 'warning',
    label: t('processingPaused') }
    : { tone: 'ongoing', label: t('executorRunning') }
  const action = paused ? 'resumeProcessing' : 'pauseProcessing'
  return <>
    <StatusHead hint={t('executionStatusIntro')} settings="execution" />
    <div className="dt-row-meta dt-status-line">
      <span className="dt-status-text" data-state={status.tone}>{status.label}</span>
      {!state.setup.problem && <>
        <LabelValue label={t('executingLabel')}
          value={`${state.load.running} / ${maxWorkers}`} /><LabelValue label={t('queuedLabel')} value={state.load.queued} />
      </>}
      <ConfirmButton variant="outline" icon={paused ? 'play' : 'pause'} label={t(action)} title={t(action)} message={t(paused
        ? 'resumeProcessingConfirm' : 'pauseProcessingConfirm')}
        onConfirm={pause} />
    </div>
    <div className="dt-row-meta dt-watchdog-heartbeat">
      <LabelValue label={t('superagentVersion')} value={state.version} />
      <LabelValue label={t('watchdogVersion')} value={lastRun?.version ?? t('watchdogVersionUnknown')} />
      <span className="dt-status-text" data-state={heartbeatStale ? 'warning' : 'ongoing'}>{heartbeat}</span>
    </div>
    <div className="dt-row-meta dt-watchdog-install">
      {install ? <>
        <LabelValue label={t('watchdogCurrent')} value={install.current ?? t('watchdogNone')} />
        <LabelValue label={t('watchdogPrevious')} value={install.previous ?? t('watchdogNone')} />
        <LabelValue label={t('watchdogCandidate')} value={install.candidate ?? t('watchdogNone')} />
        <LabelValue label={t('watchdogLastUpdate')} value={updatedAt ?? t('watchdogNoUpdate')} />
        {install.ok === false && <span className="dt-status-text" data-state="warning">{t('watchdogUpdateFailed')}</span>}
      </> : <span className="dt-hint">{t('watchdogInstallUnconfigured')}</span>}
    </div>
    <div className="dt-filters">
      {TICKET_FILTERS.map(value => <Pill key={value} active={current === value}
        onClick={() => { setLimit(20); navigate({ page: 'execution', query: value === 'open' ? {} : { filter: value } },
          true) }}>{t(`ticketFilter.${value}`)}</Pill>)}
    </div>
    {current === 'idle' && <Hint>{t('idleHint')}</Hint>}
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="dt-list">{data.items.map(ticket => ticket.stage === 'person'
      ? <TicketLine key={ticket.id} ticket={ticket} question
        onChanged={reloadTickets} /> : <TicketLine key={ticket.id} ticket={ticket} />)}</ul> : <Hint>{t('none')}</Hint>)}
    {data?.next_offset != null && <LoadMore onMore={() => setLimit(limit + 20)} />}
  </>
}

const firstSentence = (text: string): string => /^[^。；;.]*(?:[。；;]|\.(?=\s|$))?/.exec(text)?.[0] ?? text
/** Common time zones offered as datalist suggestions for the off-peak window; any IANA name is accepted. */
const TIME_ZONES = ['UTC', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Tokyo', 'Europe/London', 'America/New_York', 'America/Los_Angeles']
function EnvironmentVariables({ groups, sources,
  onPick }: { groups: SettingsView['environment']['variables']; sources: SourceView[]; onPick: (key: string) => void }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const owner = (id: string) => id === 'executor' ? t('term.executor') : localized(t, sources.find(source => source.id === id)?.title ?? id)
  const count = groups.reduce((sum, group) => sum + group.variables.length, 0)
  return <DisclosureRow icon={<Icon name="hash" />} title={<>{t('environmentVariables')} <span className="dt-count">{count}</span></>}
    open={open} onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      <Hint>{t('environmentPick')}</Hint>
      <table className="dt-table">
        <thead><tr><th>{t('environmentKey')}</th><th>{t('environmentDescription')}</th><th>{t('environmentOwner')}</th></tr></thead>
        <tbody>{groups.flatMap(group => group.variables.map(variable => <tr key={variable.key}>
          <td><button type="button" className="dt-textlink dt-mono" onClick={() => onPick(variable.key)}>{variable.key}</button></td>
          <td title={localized(t, variable.description)}>{firstSentence(localized(t, variable.description))}</td>
          <td>{owner(group.owner)}{!group.enabled && <span className="dt-hint"> · {t('sourceOff')}</span>}</td>
        </tr>))}</tbody>
      </table>
    </div>
  </DisclosureRow>
}
export function ExecutionSettings() {
  const { t } = usePanel()
  const { blocks, environment, sources } = useSettings().settings
  // Keep raw user text (such as separators between blocked commands) in the draft and parse only on save.
  const executor = blocks.executor.value
  const saved = { ...executor, maxWorkers: String(executor.maxWorkers), blockedCommands: executor.blockedCommands.join(' ') }
  const draft = useBlockDraft('executor', saved, blocks.executor.revision,
    value => ({ ...value, maxWorkers: numberOf(value.maxWorkers), blockedCommands: value.blockedCommands.split(/[\s,]+/).filter(Boolean) }))
  const value = draft.value
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  const editOffPeak = (next: Partial<typeof value.offPeak>) => edit({ offPeak: { ...value.offPeak, ...next } })
  const prepare = useRef<HTMLTextAreaElement>(null)
  const insert = (key: string) => {
    const field = prepare.current
    const at = field?.selectionStart ?? value.prepare.length, to = field?.selectionEnd ?? at
    edit({ prepare: `${value.prepare.slice(0, at)}"$${key}"${value.prepare.slice(to)}` })
    requestAnimationFrame(() => { field?.focus(); const caret = at + key.length + 3; field?.setSelectionRange(caret, caret) })
  }
  return <div className="dt-form">
    <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
      <Fields disabled={draft.busy}>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('term.executor')}<InfoTip text={t('executorIntro')} /></h2>
          <Section title={t('executorModel')} hint={t('executorModelHint')}><ModelField id="dt-worker-model" value={value.model}
            onChange={model => edit({ model })} /></Section>
          {(['low', 'high', 'expert'] as const).map(tier => <Section key={tier} title={t(tier === 'low' ? 'tierModelLow' : tier === 'high' ? 'tierModelHigh' : 'tierModelExpert')} hint={t('tierModelHint')}>
            <ModelField id={`dt-worker-${tier}-model`} value={value.tierModels[tier]} inherited={t('tierModelHint')}
              onChange={model => edit({ tierModels: { ...value.tierModels, [tier]: model } })} />
          </Section>)}
          <Field label={t('maxWorkers')} hint={t('maxWorkersHint')}>
            <Input type="number" min={LIMITS.maxWorkers.min} max={LIMITS.maxWorkers.max} required value={value.maxWorkers}
              onChange={event => edit({ maxWorkers: event.target.value })} />
          </Field>
          <Section title={t('offPeak')} hint={t('offPeakHint')}>
            <div className="dt-switch-row">
              <div className="dt-field-head">{t('offPeakEnabled')}<InfoTip text={t('offPeakEnabledHint')} /></div>
              <Switch checked={value.offPeak.enabled} onChange={enabled => editOffPeak({ enabled })} label={t('offPeakEnabled')} />
            </div>
            <div className="dt-grid3">
              <Field label={t('offPeakStart')} hint={t('offPeakStartHint')}>
                <Input type="time" required value={value.offPeak.start} onChange={event => editOffPeak({ start: event.target.value })} />
              </Field>
              <Field label={t('offPeakEnd')} hint={t('offPeakEndHint')}>
                <Input type="time" required value={value.offPeak.end} onChange={event => editOffPeak({ end: event.target.value })} />
              </Field>
              <Field label={t('offPeakTimezone')} hint={t('offPeakTimezoneHint')}>
                <Input className="dt-mono" list="dt-offpeak-timezones" spellCheck={false} required value={value.offPeak.timezone}
                  onChange={event => editOffPeak({ timezone: event.target.value })} />
              </Field>
            </div>
            <datalist id="dt-offpeak-timezones">{TIME_ZONES.map(zone => <option key={zone} value={zone} />)}</datalist>
          </Section>
        </div>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('term.environment')}<InfoTip text={t('environmentIntro')} /></h2>
          <Field label={t('executionDirectory')} hint={t('executionDirectoryHint')} note={value.directory ? undefined
            : t('executionDirectoryDefault', { root: environment.root })}>
            <Input className="dt-mono" value={value.directory} placeholder={t('executionDirectoryEmpty')} spellCheck={false}
              onChange={event => edit({ directory: event.target.value })} />
          </Field>
          <Field label={t('managedRepository')} hint={t('managedRepositoryHint')}>
            <Input className="dt-mono" value={value.managedRepository} spellCheck={false}
              onChange={event => edit({ managedRepository: event.target.value })} />
          </Field>
          <Field label={t('prepareCommand')} hint={t('prepareCommandHint')}>
            <textarea ref={prepare} className="dt-textarea dt-mono" rows={3} maxLength={LIMITS.prepareCommand} spellCheck={false}
              placeholder={t('prepareCommandEmpty')} value={value.prepare}
              onChange={event => edit({ prepare: event.target.value })} />
          </Field>
          <EnvironmentVariables groups={environment.variables} sources={sources} onPick={insert} />
          <Field label={t('blockedCommands')} hint={t('blockedCommandsHint')}>
            <Input className="dt-mono" value={value.blockedCommands} placeholder={t('blockedCommandsNone')} spellCheck={false}
              onChange={event => edit({ blockedCommands: event.target.value })} />
          </Field>
        </div>
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
    <ConfigHistory blocks={['executor', 'pause']} />
  </div>
}
