import { fetchTokenNestUsageRecords, fetchTokenNestUsageSummary, type TokenNestUsageRecord } from '@craft-agent/shared/auth'

/** Keep authoritative totals even when the detail scan reaches the RPC's time budget. */
export async function fetchTokenNestUsage(
  accessToken: string,
  startTimestamp: number,
  endTimestamp: number,
  deadline: AbortSignal,
) {
  const controller = new AbortController()
  const signal = AbortSignal.any([deadline, controller.signal])
  const records: TokenNestUsageRecord[] = []
  let total = 0
  const fetchPage = async (page: number) => {
    try {
      return await fetchTokenNestUsageRecords(accessToken, { startTimestamp, endTimestamp, page, pageSize: 100, signal })
    } catch (error) {
      // Only a deadline permits partial charts. Auth and provider failures must remain visible.
      if (deadline.aborted) return null
      throw error
    }
  }
  const collectRecords = async () => {
    const first = await fetchPage(1)
    if (!first) return
    total = first.total
    records.push(...first.items)
    const maxPages = Math.min(50, Math.ceil(total / 100))
    for (let page = 2; page <= maxPages && !signal.aborted; page += 4) {
      const pages = await Promise.all(Array.from({ length: Math.min(4, maxPages - page + 1) }, (_, offset) => fetchPage(page + offset)))
      // Preserve provider page order so recent records stay newest first.
      for (const result of pages) if (result) records.push(...result.items)
      if (pages.some(result => !result || result.items.length === 0)) break
    }
  }
  try {
    const [summary] = await Promise.all([
      fetchTokenNestUsageSummary(accessToken, startTimestamp, endTimestamp, signal),
      collectRecords(),
    ])
    return { summary, records, truncated: records.length < Math.max(total, summary.requestCount) }
  } finally {
    controller.abort()
  }
}
