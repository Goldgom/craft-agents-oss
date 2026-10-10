import type { PeakValleySchedule } from '@craft-agent/shared/utils/peak-valley'

export const DEEPSEEK_PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'

// State Council notice: https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
const calendars = new Map<number, string[]>([[2026, `
2026-01-01 2026-01-02 2026-01-03
2026-02-15 2026-02-16 2026-02-17 2026-02-18 2026-02-19 2026-02-20 2026-02-21 2026-02-22 2026-02-23
2026-04-04 2026-04-05 2026-04-06
2026-05-01 2026-05-02 2026-05-03 2026-05-04 2026-05-05
2026-06-19 2026-06-20 2026-06-21
2026-09-25 2026-09-26 2026-09-27
2026-10-01 2026-10-02 2026-10-03 2026-10-04 2026-10-05 2026-10-06 2026-10-07
`.trim().split(/\s+/)]])

export function parseDeepSeekPricingPage(html: string, year: number, holidays: string[]) {
  const text = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|#160);/g, ' ').replace(/\s+/g, ' ')
  if (!/空闲时段价格为高峰时段价格的一半/.test(text)
    || !/北京时间周一至周五\s*[（(]不含中国法定节假日[）)]\s*9:00\s*[-–—]\s*12:00\s*[、,，]\s*14:00\s*[-–—]\s*18:00/.test(text)
    || !/周末及中国法定节假日全天均为空闲时段/.test(text)) {
    throw new Error('DeepSeek official pricing rule is unavailable or has changed')
  }
  const models = [...new Set(text.match(/\bdeepseek-[a-z0-9]+(?:-[a-z0-9]+)*\b/g) ?? [])]
  if (!models.length) throw new Error('DeepSeek official pricing models are unavailable')
  const schedule: PeakValleySchedule = {
    mode: 'china_business_hours', timezone: 'Asia/Shanghai', multiplier: 0.5,
    holiday_year: year, holidays, source_url: DEEPSEEK_PRICING_URL,
  }
  return { success: true, data: models.map(model_name => ({ model_name, peak_valley_pricing: schedule })) }
}

async function getChineseHolidays(year: number): Promise<string[]> {
  const cached = calendars.get(year)
  if (cached) return cached
  const response = await fetch(`https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`, {
    credentials: 'omit', signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Chinese holiday calendar unavailable: HTTP ${response.status}`)
  const calendar = await response.json() as { year?: unknown; papers?: unknown; days?: unknown }
  if (calendar.year !== year || !Array.isArray(calendar.papers)
    || !calendar.papers.some(paper => typeof paper === 'string' && paper.startsWith('https://www.gov.cn/'))
    || !Array.isArray(calendar.days) || !calendar.days.length || calendar.days.length > 100) throw new Error('Invalid Chinese holiday calendar')
  const holidays: string[] = []
  for (const day of calendar.days) {
    if (!day || typeof day !== 'object' || typeof day.date !== 'string' || typeof day.isOffDay !== 'boolean'
      || !/^\d{4}-\d{2}-\d{2}$/.test(day.date) || Number(day.date.slice(0, 4)) !== year
      || !Number.isFinite(Date.parse(day.date)) || new Date(day.date).toISOString().slice(0, 10) !== day.date) throw new Error('Invalid Chinese holiday date')
    if (day.isOffDay) holidays.push(day.date)
  }
  if (!holidays.length) throw new Error('Chinese holiday calendar is empty')
  calendars.set(year, holidays)
  return holidays
}

/** Read the provider's public rule directly; no user credentials are involved. */
export async function fetchDeepSeekPricing() {
  const year = new Date(Date.now() + 8 * 60 * 60_000).getUTCFullYear()
  const [response, holidays] = await Promise.all([
    fetch(DEEPSEEK_PRICING_URL, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10_000) }),
    getChineseHolidays(year),
  ])
  if (!response.ok) throw new Error(`DeepSeek pricing unavailable: HTTP ${response.status}`)
  if (Number(response.headers.get('content-length')) > 512_000) throw new Error('DeepSeek pricing page is too large')
  const html = await response.text()
  if (html.length > 512_000) throw new Error('DeepSeek pricing page is too large')
  return parseDeepSeekPricingPage(html, year, holidays)
}
