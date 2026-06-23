import { useEffect, useMemo, useRef } from 'react'
import { groupByMonth } from '../utils/dateGroup'
import { DateGroup } from './DateGroup'
import { PhotoCard } from './PhotoCard'

/**
 * Scrollable gallery grid. Builds object URLs for thumbnails once per thumbs
 * change and revokes the previous batch on the next pass to avoid leaks.
 */
export function PhotoGrid({ entries, thumbs }) {
  const groups = useMemo(() => groupByMonth(entries), [entries])

  const thumbUrls = useMemo(() => {
    const map = new Map()
    for (const entry of entries) {
      const blob = thumbs.get(entry.id)
      if (blob) map.set(entry.id, URL.createObjectURL(blob))
    }
    return map
  }, [thumbs, entries])

  // Track the current URL set so we can revoke it when it changes or unmounts.
  const previousUrls = useRef(new Map())
  useEffect(() => {
    const prev = previousUrls.current
    previousUrls.current = thumbUrls
    return () => {
      for (const url of prev.values()) URL.revokeObjectURL(url)
    }
  }, [thumbUrls])

  if (entries.length === 0) return null

  return (
    <div className="mx-auto max-w-6xl px-3 py-4">
      {groups.map((group) => (
        <DateGroup key={group.key} label={group.label}>
          <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
            {group.entries.map((entry) => (
              <PhotoCard
                key={entry.id}
                entry={entry}
                thumbUrl={thumbUrls.get(entry.id)}
              />
            ))}
          </div>
        </DateGroup>
      ))}
    </div>
  )
}
