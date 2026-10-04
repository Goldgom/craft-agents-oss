import { afterEach, describe, expect, it } from 'bun:test'
import { fetchTokenNestUsage } from './tokennest-usage'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

const summary = { request_count: 500, total_tokens: 12345, charged_amount_usd: 1.23 }
const pageResponse = (page: number, total = 500) => Response.json({ data: {
  total, page, page_size: 100,
  items: Array.from({ length: Math.min(100, total - (page - 1) * 100) }, (_, offset) => ({ request_id: `${page}-${offset}`, total_tokens: 2 })),
} })
const waitForAbort = (signal: AbortSignal) => new Promise<Response>((_resolve, reject) => {
  if (signal.aborted) reject(signal.reason)
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
})

describe('TokenNest usage time budget', () => {
  it('fetches summary and pages concurrently while preserving page order', async () => {
    let activePages = 0
    let maxActivePages = 0
    let summaryRequested = false
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      if (url.pathname.endsWith('/summary')) {
        summaryRequested = true
        await new Promise(resolve => setTimeout(resolve, 10))
        return Response.json({ data: summary })
      }
      expect(summaryRequested).toBe(true)
      const page = Number(url.searchParams.get('page'))
      maxActivePages = Math.max(maxActivePages, ++activePages)
      await new Promise(resolve => setTimeout(resolve, 6 - page))
      activePages -= 1
      return pageResponse(page)
    }) as typeof fetch
    const result = await fetchTokenNestUsage('access', 10, 20, new AbortController().signal)
    expect(maxActivePages).toBe(4)
    expect(result.summary.totalTokens).toBe(12345)
    expect(result.records).toHaveLength(500)
    expect(result.records.filter((_, index) => index % 100 === 0).map(record => record.requestId)).toEqual(['1-0', '2-0', '3-0', '4-0', '5-0'])
    expect(result.truncated).toBe(false)
  })

  it('keeps totals and completed pages when a later page reaches the deadline', async () => {
    const deadline = new AbortController()
    let cancelledPages = 0
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/summary')) return Response.json({ data: summary })
      const page = Number(url.searchParams.get('page'))
      if (page <= 2) return pageResponse(page)
      if (page === 5) setTimeout(() => deadline.abort(new DOMException('Timed out', 'TimeoutError')), 0)
      try { return await waitForAbort(init!.signal!) }
      finally { cancelledPages += 1 }
    }) as typeof fetch
    const result = await fetchTokenNestUsage('access', 10, 20, deadline.signal)
    expect(result.summary.totalTokens).toBe(12345)
    expect(result.records).toHaveLength(200)
    expect(result.truncated).toBe(true)
    expect(cancelledPages).toBe(3)
  })

  it('returns an available summary even when the first detail page times out', async () => {
    const deadline = new AbortController()
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes('/summary')) return Response.json({ data: summary })
      setTimeout(() => deadline.abort(new DOMException('Timed out', 'TimeoutError')), 0)
      return waitForAbort(init!.signal!)
    }) as typeof fetch
    const result = await fetchTokenNestUsage('access', 10, 20, deadline.signal)
    expect(result.summary.totalTokens).toBe(12345)
    expect(result.records).toEqual([])
    expect(result.truncated).toBe(true)
  })

  it('rejects an unavailable summary and cancels detail requests', async () => {
    const deadline = new AbortController()
    let detailSignal: AbortSignal | undefined
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes('/summary')) return waitForAbort(init!.signal!)
      detailSignal = init!.signal!
      setTimeout(() => deadline.abort(new DOMException('Timed out', 'TimeoutError')), 0)
      return waitForAbort(detailSignal)
    }) as typeof fetch
    await expect(fetchTokenNestUsage('access', 10, 20, deadline.signal)).rejects.toThrow()
    expect(detailSignal?.aborted).toBe(true)
  })

  it('propagates authentication errors so the handler can refresh credentials', async () => {
    let summarySignal: AbortSignal | undefined
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes('/summary')) {
        summarySignal = init!.signal!
        return waitForAbort(summarySignal)
      }
      return Response.json({ error: 'invalid_token' }, { status: 401 })
    }) as typeof fetch
    await expect(fetchTokenNestUsage('access', 10, 20, new AbortController().signal)).rejects.toMatchObject({ status: 401 })
    expect(summarySignal?.aborted).toBe(true)
  })

  it('caps details at 5,000 records without changing authoritative totals', async () => {
    const pages: number[] = []
    globalThis.fetch = (async input => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/summary')) return Response.json({ data: { ...summary, request_count: 6000 } })
      const page = Number(url.searchParams.get('page'))
      pages.push(page)
      return pageResponse(page, 6000)
    }) as typeof fetch
    const result = await fetchTokenNestUsage('access', 10, 20, new AbortController().signal)
    expect(result.records).toHaveLength(5000)
    expect(Math.max(...pages)).toBe(50)
    expect(result.summary.requestCount).toBe(6000)
    expect(result.truncated).toBe(true)
  })

  it('reports provider failures instead of presenting them as partial success', async () => {
    globalThis.fetch = (async input => String(input).includes('/summary')
      ? Response.json({ data: summary }) : Response.json({ error: 'unavailable' }, { status: 503 })) as typeof fetch
    await expect(fetchTokenNestUsage('access', 10, 20, new AbortController().signal)).rejects.toMatchObject({ status: 503 })
  })
})
