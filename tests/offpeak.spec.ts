/** The off-peak window schema and the daily time arithmetic the Executor uses to hold launches. */
import { expect, it } from 'vitest'
import { OffPeakWindowSchema, insideOffPeak, isTimeZone, offPeakWait, type OffPeakWindow } from '../src/offpeak.ts'
import { SettingsSchema } from '../src/policy.ts'

/** Parse a window with the schema defaults and the overrides given. */
const window = (overrides: Record<string, unknown> = {}): OffPeakWindow => OffPeakWindowSchema.parse({ enabled: true, ...overrides })
/** The epoch of a wall-clock time in Asia/Shanghai (UTC+8). */
const shanghai = (time: string): number => Date.parse(`2026-01-01T${time}:00+08:00`)

it('defaults to a disabled 22:00-08:00 Asia/Shanghai window, and the Executor settings carry it', () => {
  expect(OffPeakWindowSchema.parse({})).toEqual({ enabled: false, start: '22:00', end: '08:00', timezone: 'Asia/Shanghai' })
  expect(SettingsSchema.parse({}).executor.offPeak).toEqual({ enabled: false, start: '22:00', end: '08:00', timezone: 'Asia/Shanghai' })
  // A stored executor block from before the field existed takes the defaults when it is parsed again.
  expect(SettingsSchema.parse({ executor: { maxWorkers: 4 } }).executor).toMatchObject({ maxWorkers: 4,
    offPeak: { enabled: false, start: '22:00', end: '08:00', timezone: 'Asia/Shanghai' } })
})

it('keeps a daytime window start inclusive and end exclusive', () => {
  const day = window({ start: '09:00', end: '17:00' })
  expect(insideOffPeak(day, shanghai('08:59'))).toBe(false)
  expect(insideOffPeak(day, shanghai('09:00'))).toBe(true)
  expect(insideOffPeak(day, shanghai('16:59'))).toBe(true)
  expect(insideOffPeak(day, shanghai('17:00'))).toBe(false)
  expect(offPeakWait(day, shanghai('08:59'))).toBe(60_000)
  expect(offPeakWait(day, shanghai('09:00'))).toBe(0)
  expect(offPeakWait(day, shanghai('17:00'))).toBe(16 * 3_600_000)
})

it('wraps an overnight window past midnight and waits for the next opening', () => {
  const night = window()
  expect(insideOffPeak(night, shanghai('12:00'))).toBe(false)
  expect(insideOffPeak(night, shanghai('21:59'))).toBe(false)
  expect(insideOffPeak(night, shanghai('22:00'))).toBe(true)
  expect(insideOffPeak(night, shanghai('23:30'))).toBe(true)
  expect(insideOffPeak(night, shanghai('00:00'))).toBe(true)
  expect(insideOffPeak(night, shanghai('07:59'))).toBe(true)
  expect(insideOffPeak(night, shanghai('08:00'))).toBe(false)
  expect(offPeakWait(night, shanghai('12:00'))).toBe(10 * 3_600_000)
  expect(offPeakWait(night, shanghai('21:59'))).toBe(60_000)
  expect(offPeakWait(night, shanghai('23:30'))).toBe(0)
  expect(offPeakWait(night, shanghai('07:59'))).toBe(0)
  expect(offPeakWait(night, shanghai('08:00'))).toBe(14 * 3_600_000)
})

it('reads the clock in the configured time zone, not the host time zone', () => {
  const utc = window({ start: '00:00', end: '01:00', timezone: 'UTC' })
  expect(insideOffPeak(utc, Date.parse('2026-01-01T00:30:00Z'))).toBe(true)
  const shanghaiWindow = window({ start: '00:00', end: '01:00' })
  expect(insideOffPeak(shanghaiWindow, Date.parse('2026-01-01T00:30:00Z'))).toBe(false)
  expect(offPeakWait(shanghaiWindow, Date.parse('2026-01-01T00:30:00Z'))).toBe(15.5 * 3_600_000)
  expect(isTimeZone('UTC')).toBe(true)
  expect(isTimeZone('Asia/Shanghai')).toBe(true)
  expect(isTimeZone('Mars/Olympus')).toBe(false)
})

it('never holds a launch while the window is disabled', () => {
  const disabled = window({ enabled: false })
  expect(insideOffPeak(disabled, shanghai('12:00'))).toBe(false)
  expect(offPeakWait(disabled, shanghai('12:00'))).toBe(0)
})

it('rejects a malformed clock, an empty or 24-hour window, an unknown time zone, and unknown fields', () => {
  for (const value of [{ start: '24:00' }, { start: '9:00' }, { end: '08:60' }, { timezone: 'Mars/Olympus' },
    { start: '09:00', end: '09:00' }, { extra: true }])
    expect(OffPeakWindowSchema.safeParse({ enabled: true, ...value }).success).toBe(false)
})