/** Account amounts are major currency units; TokenNest recharge defaults to RMB yuan. */
export function formatCreditAmount(value: number, currency = 'CNY'): string {
  if (!Number.isFinite(value)) return '—'
  const amount = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value)
  if (currency.toUpperCase() === 'CNY' || currency.toUpperCase() === 'RMB') return `${amount} 元`
  if (currency.toUpperCase() === 'USD') return `$${amount} USD`
  return `${amount} ${currency}`
}

export function formatCreditBalance(balance?: { remaining?: number; display?: string; currency?: string }): string {
  if (balance?.remaining !== undefined) return formatCreditAmount(balance.remaining, balance.currency)
  return balance?.display || '—'
}
