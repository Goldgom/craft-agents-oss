import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { LlmConnection } from '@craft-agent/shared/config/llm-connections'
import {
  getPeakValleyPeriod, getPricingSnapshot, parsePeakValleyPricing, subscribePricing, getModelPricingSource,
} from '../tokennest-pricing'

const schedule = { timezone: 'Asia/Shanghai', start: '00:30', end: '08:30', multiplier: 0.5 }
const catalog = { success: true, data: [{ model_name: 'deepseek-flash', peak_valley_pricing: schedule }] }
const connection: LlmConnection = {
  slug: 'tokennest', name: 'TokenNest', providerType: 'pi_compat', authType: 'api_key',
  baseUrl: 'https://openai.goldgom.top/v1', createdAt: 0,
}

afterEach(() => { mock.restore() })

describe('Live DeepSeek pricing periods', () => {
  test.each([
    ['2026-10-08T16:29:59Z', 'peak'],
    ['2026-10-08T16:30:00Z', 'off-peak'],
    ['2026-10-09T00:29:59Z', 'off-peak'],
    ['2026-10-09T00:30:00Z', 'peak'],
  ] as const)('Shanghai boundary at %s is %s', (time, expected) => {
    expect(getPeakValleyPeriod(schedule, Date.parse(time))).toBe(expected)
  })

  test('supports overnight schedules from the server', () => {
    const overnight = { ...schedule, start: '22:00', end: '06:00' }
    expect(getPeakValleyPeriod(overnight, Date.parse('2026-10-08T14:00:00Z'))).toBe('off-peak')
    expect(getPeakValleyPeriod(overnight, Date.parse('2026-10-08T22:00:00Z'))).toBe('peak')
    expect(getPeakValleyPeriod(overnight, Date.parse('2026-10-09T04:00:00Z'))).toBe('peak')
  })

  test('only annotates DeepSeek on the actual TokenNest connection', () => {
    expect(getModelPricingSource(connection, 'deepseek-flash')).toBe('tokennest')
    expect(getModelPricingSource({ ...connection, baseUrl: undefined, authType: 'oauth', oauthProvider: 'tokennest' }, 'pi/deepseek-v4-pro')).toBe('tokennest')
    expect(getModelPricingSource(connection, 'gpt-6-sol')).toBeUndefined()
    expect(getModelPricingSource({ ...connection, baseUrl: 'https://api.deepseek.com/v1' }, 'deepseek-flash')).toBe('deepseek')
    expect(getModelPricingSource({ ...connection, baseUrl: undefined, providerType: 'pi', piAuthProvider: 'deepseek' }, 'deepseek-v4-pro')).toBe('deepseek')
    expect(getModelPricingSource({ ...connection, baseUrl: 'https://third-party.example/v1' }, 'deepseek-flash')).toBeUndefined()
    expect(getModelPricingSource(null, 'deepseek-flash')).toBeUndefined()
  })

  test('uses exact opted-in model IDs and rejects unusable schedules', () => {
    const data = [
      ...catalog.data,
      { model_name: 'deepseek-v4-flash' },
      ...[
        { timezone: 'Invalid/Zone' }, { start: '24:00' }, { end: '00:30' },
        { multiplier: 0 }, { multiplier: 2 }, { multiplier: NaN },
      ].map((invalid, index) => ({ model_name: `invalid-${index}`, peak_valley_pricing: { ...schedule, ...invalid } })),
    ]
    expect(parsePeakValleyPricing({ success: true, data })).toEqual({ 'deepseek-flash': schedule })
    expect(() => parsePeakValleyPricing({ success: false, data })).toThrow()
    expect(() => parsePeakValleyPricing({ success: true })).toThrow()
  })

  test('shares live catalog requests and hides stale badges on refresh failure', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const events = new EventTarget()
    const getPricing = mock(async () => catalog)
    Object.assign(events, { electronAPI: { getModelPeakValleyPricing: getPricing } })
    Object.defineProperty(globalThis, 'window', { configurable: true, value: events })
    const clock = spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-09T00:29:00Z'))
    let resolveUpdate: (() => void) | undefined
    const nextUpdate = () => new Promise<void>(resolve => { resolveUpdate = resolve })
    const loaded = nextUpdate()
    const unsubscribe = subscribePricing(() => {
      if (getPricingSnapshot().schedules['deepseek-flash']) resolveUpdate?.()
    })
    const unsubscribeSecond = subscribePricing(() => {})
    try {
      await loaded
      expect(getPricing).toHaveBeenCalledTimes(1)
      expect(getPricing).toHaveBeenCalledWith('tokennest')
      expect(getPeakValleyPeriod(schedule, getPricingSnapshot().at)).toBe('off-peak')
      clock.mockReturnValue(Date.parse('2026-10-09T00:30:00Z'))
      events.dispatchEvent(new Event('focus'))
      expect(getPeakValleyPeriod(schedule, getPricingSnapshot().at)).toBe('peak')
      expect(getPricing).toHaveBeenCalledTimes(1)
      clock.mockReturnValue(Date.parse('2026-10-09T00:36:00Z'))
      getPricing.mockRejectedValue(new Error('Network unavailable'))
      const failed = nextUpdate()
      const unsubscribeFailure = subscribePricing(() => {
        if (!getPricingSnapshot().schedules['deepseek-flash']) resolveUpdate?.()
      })
      events.dispatchEvent(new Event('focus'))
      await failed
      unsubscribeFailure()
      expect(getPricingSnapshot().schedules).toEqual({})
      expect(getPricing).toHaveBeenCalledTimes(2)
    } finally {
      unsubscribe()
      unsubscribeSecond()
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  })

  test.each([
    ['2026-10-09T08:59:59+08:00', 'off-peak'],
    ['2026-10-09T09:00:00+08:00', 'peak'],
    ['2026-10-09T11:59:59+08:00', 'peak'],
    ['2026-10-09T12:00:00+08:00', 'off-peak'],
    ['2026-10-09T13:59:59+08:00', 'off-peak'],
    ['2026-10-09T14:00:00+08:00', 'peak'],
    ['2026-10-09T17:59:59+08:00', 'peak'],
    ['2026-10-09T18:00:00+08:00', 'off-peak'],
    ['2026-10-10T10:00:00+08:00', 'off-peak'],
    ['2026-10-11T15:00:00+08:00', 'off-peak'],
    ['2026-10-01T10:00:00+08:00', 'off-peak'],
    ['2026-10-07T15:00:00+08:00', 'off-peak'],
    ['2026-10-08T10:00:00+08:00', 'peak'],
    ['2026-09-25T15:00:00+08:00', 'off-peak'],
    ['2028-10-09T10:00:00+08:00', 'off-peak'],
  ] as const)('DeepSeek business period at %s is %s', (time, expected) => {
    const businessSchedule = { mode: 'china_business_hours' as const, timezone: 'Asia/Shanghai', multiplier: 0.5,
      holiday_year: 2026, holidays: ['2026-10-01', '2026-10-07', '2026-09-25'] }
    expect(getPeakValleyPeriod(businessSchedule, Date.parse(time))).toBe(expected)
  })

  test('accepts the business schedule contract and rejects an invalid holiday calendar', () => {
    const business = { mode: 'china_business_hours' as const, timezone: 'Asia/Shanghai', multiplier: 0.5,
      holiday_year: 2026, holidays: ['2026-10-01'] }
    expect(parsePeakValleyPricing({ success: true, data: [{ model_name: 'deepseek-flash', peak_valley_pricing: business }] }))
      .toEqual({ 'deepseek-flash': business })
    for (const invalid of [{ timezone: 'UTC' }, { multiplier: 0.25 }, { holidays: ['2026-02-30'] },
      { holidays: ['2027-10-01'] }, { holiday_year: '2026' }, { mode: 'unknown' }]) {
      expect(parsePeakValleyPricing({ success: true, data: [{ model_name: 'deepseek-flash', peak_valley_pricing: { ...business, ...invalid } }] })).toEqual({})
    }
  })
})
