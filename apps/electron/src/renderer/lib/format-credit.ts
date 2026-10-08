/** Format account credit with the product's RMB display unit. */
export function formatCreditAmount(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `¥${new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value)}`
}

export function formatCreditBalance(balance?: { remaining?: number; display?: string }): string {
  if (balance?.remaining !== undefined) return formatCreditAmount(balance.remaining)
  return balance?.display || '—'
}
