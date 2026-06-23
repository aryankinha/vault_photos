import { useCallback, useEffect, useState } from 'react'
import { loadGallery } from '../services/galleryService'

export function useGallery() {
  const [entries, setEntries] = useState([])
  const [thumbs, setThumbs] = useState(() => new Map())
  const [updatedAt, setUpdatedAt] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Initial load on mount. All setState calls live in promise continuations so
  // nothing runs synchronously inside the effect body.
  useEffect(() => {
    let cancelled = false
    loadGallery()
      .then((result) => {
        if (cancelled) return
        setEntries(result.entries)
        setThumbs(result.thumbs)
        setUpdatedAt(result.updatedAt)
      })
      .catch((e) => {
        if (!cancelled) setError(e)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Manual reload (retry button). Invoked from event handlers, so synchronous
  // setState resets here are fine.
  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await loadGallery()
      setEntries(result.entries)
      setThumbs(result.thumbs)
      setUpdatedAt(result.updatedAt)
    } catch (e) {
      setError(e)
    } finally {
      setLoading(false)
    }
  }, [])

  return { entries, thumbs, updatedAt, loading, error, reload }
}
