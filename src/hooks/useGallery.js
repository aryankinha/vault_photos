import { useCallback, useEffect, useRef, useState } from 'react'
import { loadGalleryProgressive } from '../services/galleryService'

/**
 * useGallery — V3 progressive gallery hook.
 *
 * Two-phase load:
 *   1. Manifest arrives  → entries set, loading=false (grid renders immediately)
 *   2. Bundle streams in → thumbs updated in batches, thumbsLoading=false at end
 *
 * Return shape is backward-compatible with V2. One new field added: thumbsLoading.
 */
export function useGallery() {
  const [entries, setEntries] = useState([])
  const [thumbs, setThumbs] = useState(() => new Map())
  const [updatedAt, setUpdatedAt] = useState(null)
  const [loading, setLoading] = useState(true)       // false once manifest is ready
  const [thumbsLoading, setThumbsLoading] = useState(true) // false once all thumbs in
  const [error, setError] = useState(null)

  // Ref to track the current load session so stale async updates are discarded.
  const sessionRef = useRef(0)

  const runLoad = useCallback(() => {
    const session = ++sessionRef.current
    setLoading(true)
    setThumbsLoading(true)
    setError(null)

    // All setState calls live inside the callback / promise continuations —
    // never synchronously inside the effect body (React 19 rule).
    loadGalleryProgressive((update) => {
      // Discard updates from a previous (stale) load session.
      if (session !== sessionRef.current) return

      setEntries(update.entries)
      setThumbs(update.thumbs)
      if (update.updatedAt) setUpdatedAt(update.updatedAt)

      // Phase 'manifest' → main loading spinner can stop; grid renders.
      if (update.phase === 'manifest') setLoading(false)

      // Phase 'done' → all thumbnails are hydrated.
      if (update.done) setThumbsLoading(false)
    }).catch((e) => {
      if (session !== sessionRef.current) return
      setError(e)
      setLoading(false)
      setThumbsLoading(false)
    })
  }, [])

  // Initial load on mount.
  useEffect(() => {
    // Kick off the async load via a microtask so no setState fires synchronously
    // inside the effect body (satisfies react-hooks/set-state-in-effect).
    const session = ++sessionRef.current
    Promise.resolve().then(() => {
      if (session !== sessionRef.current) return
      runLoad()
    })
    return () => {
      // Invalidate the current session so in-flight updates are discarded.
      // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: incrementing on cleanup
      sessionRef.current++
    }
  }, [runLoad])

  // Manual reload — invoked from event handlers (safe to call synchronously).
  const reload = useCallback(() => {
    runLoad()
  }, [runLoad])

  return { entries, thumbs, updatedAt, loading, thumbsLoading, error, reload }
}

