/** Daily off-peak window in which deferred Tickets may start their Assignments (see docs/003). */
import { z } from 'zod'

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/
/** Minutes since local midnight for an `HH:MM` clock time. */
const clockMinutes = (value: string): number => {
  const [hour, minute] = value.split(':').map(Number)
  return hour! * 60 + minute!
}
/** Whether `value` names a time zone the runtime's `Intl` data knows, such as `Asia/Shanghai` or `UTC`. */
export function isTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true } catch { return false }
}
/**
 * A daily window, in `timezone`, in which the Executor may start Assignments of Tickets marked off-peak.
 * It is off by default: a deployment enables it for the period its computing costs least, such as a cloud's valley price.
 */
export const OffPeakWindowSchema = z.object({
  enabled: z.boolean().default(false),
  /** Local clock time the window opens, inclusive. */
  start: z.string().regex(CLOCK, 'Use HH:MM, such as 22:00').default('22:00'),
  /** Local clock time the window closes, exclusive. */
  end: z.string().regex(CLOCK, 'Use HH:MM, such as 08:00').default('08:00'),
  timezone: z.string().trim().min(1).refine(isTimeZone, 'An IANA time zone, such as Asia/Shanghai').default('Asia/Shanghai'),
}).strict().refine(window => window.start !== window.end, 'The start and end must differ; use a 24-hour window by disabling the setting')
export type OffPeakWindow = z.infer<typeof OffPeakWindowSchema>

/** Local minutes since midnight at `at`, as `timezone` reads them. */
function localMinutes(window: Pick<OffPeakWindow, 'timezone'>, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: window.timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(at))
  const value = (type: 'hour' | 'minute'): number => Number(parts.find(part => part.type === type)?.value ?? 0)
  return value('hour') * 60 + value('minute')
}
/**
 * Whether a new Ticket from `source` is deferred when the routing decision leaves the choice open: a Feishu
 * request starts immediately unless it is clearly deferrable, while GitLab and GitHub work defaults to the
 * window unless it is clearly urgent. The routing tool lets an explicit `off_peak` override this default.
 */
export function offPeakByDefault(source: string): boolean {
  return source === 'github' || source === 'gitlab'
}
/** Whether `at` falls inside the window's daily period; an overnight window wraps past midnight. A disabled window is never inside. */
export function insideOffPeak(window: OffPeakWindow, at: number): boolean {
  if (!window.enabled) return false
  const start = clockMinutes(window.start), end = clockMinutes(window.end), now = localMinutes(window, at)
  return start < end ? now >= start && now < end : now >= start || now < end
}
/**
 * How long `at` must wait for the window to open, in milliseconds: 0 when the window is disabled or open now.
 * The caller re-checks after waiting, so a daylight-saving step at the edge of a window only costs another wait.
 */
export function offPeakWait(window: OffPeakWindow, at: number): number {
  if (!window.enabled || insideOffPeak(window, at)) return 0
  const start = clockMinutes(window.start), now = localMinutes(window, at)
  return ((start - now + 1440) % 1440) * 60_000
}