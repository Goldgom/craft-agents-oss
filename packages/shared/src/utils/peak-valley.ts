/** Public pricing schedules used by both gateway and direct-provider badges. */
export interface PeakValleySchedule {
  mode?: 'daily' | 'china_business_hours'
  timezone: string
  start?: string
  end?: string
  multiplier: number
  holiday_year?: number
  holidays?: string[]
  source_url?: string
}

export function parsePeakValleySchedule(value: unknown): PeakValleySchedule | undefined {
  if (!value || typeof value !== 'object') return undefined
  const schedule = value as Record<string, unknown>
  const { timezone, multiplier, mode } = schedule
  if (typeof timezone !== 'string' || !timezone || timezone === 'Local'
    || typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 1) return undefined
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }) } catch { return undefined }
  if (mode === 'china_business_hours') {
    if (timezone !== 'Asia/Shanghai' || multiplier !== 0.5) return undefined
    const holidayYear = schedule.holiday_year
    const holidays = schedule.holidays ?? []
    if (holidayYear !== undefined && (typeof holidayYear !== 'number' || !Number.isInteger(holidayYear) || holidayYear < 2024 || holidayYear > 2100)) return undefined
    if (!Array.isArray(holidays) || holidays.length > 100 || !holidays.every(date => typeof date === 'string'
      && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number(date.slice(0, 4)) === holidayYear
      && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date)) return undefined
    const result: PeakValleySchedule = { mode, timezone, multiplier, holidays }
    if (holidayYear !== undefined) result.holiday_year = Number(holidayYear)
    if (typeof schedule.source_url === 'string') result.source_url = schedule.source_url
    return result
  }
  if (mode !== undefined && mode !== '' && mode !== 'daily') return undefined
  const { start, end } = schedule
  const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/
  if (typeof start !== 'string' || typeof end !== 'string' || !clock.test(start) || !clock.test(end) || start === end) return undefined
  return { timezone, start, end, multiplier }
}

const formatters = new Map<string, Intl.DateTimeFormat>()

export function getPeakValleyPeriod(schedule: PeakValleySchedule, at: number): 'peak' | 'off-peak' {
  let formatter = formatters.get(schedule.timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: schedule.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    })
    formatters.set(schedule.timezone, formatter)
  }
  const values = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]))
  const clock = `${values.hour}:${values.minute}`
  if (schedule.mode === 'china_business_hours') {
    const date = `${values.year}-${values.month}-${values.day}`
    if (values.weekday === 'Sat' || values.weekday === 'Sun'
      || schedule.holiday_year !== Number(values.year) || schedule.holidays?.includes(date)) return 'off-peak'
    return ((clock >= '09:00' && clock < '12:00') || (clock >= '14:00' && clock < '18:00')) ? 'peak' : 'off-peak'
  }
  if (!schedule.start || !schedule.end) return 'peak'
  const offPeak = schedule.start < schedule.end
    ? clock >= schedule.start && clock < schedule.end
    : clock >= schedule.start || clock < schedule.end
  return offPeak ? 'off-peak' : 'peak'
}
