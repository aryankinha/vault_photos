const MONTH_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  year: 'numeric',
})

/**
 * Group entries by the month they were taken. Returns an ordered list of
 * { key, label, entries } with the most recent month first.
 */
export function groupByMonth(entries) {
  const buckets = new Map()

  for (const entry of entries) {
    const date = new Date(entry.date_taken)
    if (Number.isNaN(date.getTime())) continue
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(entry)
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([key, groupEntries]) => {
      const [year, month] = key.split('-').map(Number)
      const label = MONTH_FORMATTER.format(new Date(year, month - 1, 1))
      return { key, label, entries: groupEntries }
    })
}
