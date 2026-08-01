/**
 * Money arrives as a numeric(18,2) string. Parse only here, at the point of display,
 * so no arithmetic ever happens on a float.
 */
export function formatMoney(amount: string | null, currency: string | null): string {
  if (amount === null) return '—'
  const value = Number(amount)
  if (Number.isNaN(value)) return amount

  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency ?? 'USD',
      currencyDisplay: 'narrowSymbol',
    }).format(value)
  } catch {
    // Intl throws on an unrecognised currency code; an extracted one may be junk.
    return `${value.toFixed(2)} ${currency ?? ''}`.trim()
  }
}

export function formatDate(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
}
