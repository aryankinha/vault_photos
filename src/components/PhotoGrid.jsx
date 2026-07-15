import { useEffect, useMemo, useRef, useState } from 'react'
import { groupByMonth } from '../utils/dateGroup'
import { DateGroup } from './DateGroup'
import { PhotoCard } from './PhotoCard'

const visibilityCallbacks = new WeakMap()
let sharedObserver = null

function observeNearViewport(element, callback) {
  if (typeof IntersectionObserver === 'undefined') {
    Promise.resolve().then(() => callback(true))
    return () => {}
  }

  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver((observations) => {
      for (const observation of observations) {
        visibilityCallbacks.get(observation.target)?.(observation.isIntersecting)
      }
    }, {
      // Keep roughly three screens above and below alive. Object URLs outside
      // this window are revoked so very large libraries do not exhaust memory.
      rootMargin: '300% 0px',
      threshold: 0,
    })
  }

  visibilityCallbacks.set(element, callback)
  sharedObserver.observe(element)
  return () => {
    visibilityCallbacks.delete(element)
    sharedObserver?.unobserve(element)
  }
}

export function PhotoGrid({ entries, thumbs, optimisticStates, onRetry }) {
  const groups = useMemo(() => groupByMonth(entries), [entries])
  if (entries.length === 0) return null

  return (
    <div className="mx-auto max-w-6xl px-3 py-4">
      {groups.map((group) => (
        <DateGroup key={group.key} label={group.label}>
          <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
            {group.entries.map((entry) => (
              <LazyPhotoCard
                key={entry.id}
                entry={entry}
                thumbBlob={thumbs.get(entry.id)}
                uploadState={optimisticStates?.get(entry.id)}
                onRetry={onRetry}
              />
            ))}
          </div>
        </DateGroup>
      ))}
    </div>
  )
}

function LazyPhotoCard({ entry, thumbBlob, uploadState, onRetry }) {
  const containerRef = useRef(null)
  const urlRef = useRef(null)
  const [thumbUrl, setThumbUrl] = useState(null)

  useEffect(() => {
    const element = containerRef.current
    if (!element) return undefined

    const releaseUrl = () => {
      if (!urlRef.current) return
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
      setThumbUrl(null)
    }

    const unobserve = observeNearViewport(element, (isNear) => {
      if (isNear && thumbBlob && !urlRef.current) {
        urlRef.current = URL.createObjectURL(thumbBlob)
        setThumbUrl(urlRef.current)
      } else if (!isNear) {
        releaseUrl()
      }
    })

    return () => {
      unobserve()
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }, [thumbBlob])

  return (
    <div ref={containerRef} className="aspect-square min-w-0">
      <PhotoCard
        entry={entry}
        thumbUrl={thumbUrl}
        uploadState={uploadState}
        onRetry={onRetry}
      />
    </div>
  )
}
