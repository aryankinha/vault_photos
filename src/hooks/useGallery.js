import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadGalleryPage, loadGalleryProgressive } from '../services/galleryService'


/**
 * useGallery — V3 progressive gallery hook.
 *
 * Two-phase load with persistent IDB thumb cache:
 *   1. Manifest + cached thumbs arrive → entries set, loading=false (grid renders immediately)
 *      If ALL thumbs are cached → done immediately (no network required)
 *   2. Missing thumbs stream in from bundle → thumbs updated in batches, thumbsLoading=false
 *
 * Phase 5 adds:
 *   loadPage(n)    — demand-load a bundle page (called by IntersectionObserver)
 *   loadingPage    — true while a demand page fetch is in-flight
 *   totalPages     — total number of pages from manifest (1 for old single-bundle vaults)
 *   loadedPages    — Set of page indices already loaded
 *
 * Return shape is backward-compatible with V2. New fields are additive.
 */
export function useGallery({
  optimisticEntries = [],
  optimisticThumbs = new Map(),
} = {}) {
  const [entries, setEntries] = useState([])
  const [thumbs, setThumbs] = useState(() => new Map())
  const [updatedAt, setUpdatedAt] = useState(null)
  const [loading, setLoading] = useState(true)         // false once manifest is ready
  const [thumbsLoading, setThumbsLoading] = useState(true) // false once all thumbs in
  const [loadingPage, setLoadingPage] = useState(false) // true during demand page fetch
  const [totalPages, setTotalPages] = useState(1)
  const [loadedPages, setLoadedPages] = useState(() => new Set())
  const [pageError, setPageError] = useState(null)
  const [error, setError] = useState(null)

  // Ref to track the current load session so stale async updates are discarded.
  const sessionRef = useRef(0)
  const loadingPagesRef = useRef(new Set())

  const runLoad = useCallback(() => {
    const session = ++sessionRef.current
    setLoading(true)
    setThumbsLoading(true)
    setLoadedPages(new Set())
    loadingPagesRef.current.clear()
    setLoadingPage(false)
    setPageError(null)
    setError(null)

    loadGalleryProgressive((update) => {
      if (session !== sessionRef.current) return

      setEntries(update.entries)
      setThumbs(update.thumbs)
      if (update.updatedAt) setUpdatedAt(update.updatedAt)

      // Phase 'manifest' → main loading spinner can stop; grid renders.
      if (update.phase === 'manifest') {
        setLoading(false)
        setTotalPages(update.totalPages ?? 1)
      }

      if (update.loadedPages) setLoadedPages(new Set(update.loadedPages))

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
    const session = ++sessionRef.current
    Promise.resolve().then(() => {
      if (session !== sessionRef.current) return
      runLoad()
    })
    return () => {
      // Invalidate the current session so in-flight updates are discarded.
      // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
      sessionRef.current++
    }
  }, [runLoad])

  // Manual reload — invoked from event handlers.
  const reload = useCallback(() => {
    runLoad()
  }, [runLoad])

  /**
   * Demand-load a bundle page. Called by Gallery's IntersectionObserver when
   * the user scrolls near page N's content area.
   *
   * @param {number} pageIndex — zero-based page index
   */
  const loadPage = useCallback(async (pageIndex) => {
    const session = sessionRef.current
    const taskKey = `${session}:${pageIndex}`
    if (loadingPagesRef.current.has(taskKey)) return

    loadingPagesRef.current.add(taskKey)
    setLoadingPage(true)
    setPageError(null)
    try {
      // Collect the entry ids for this page (entries with matching page_index).
      // Old V1/V2 entries have page_index === undefined → treated as page 0.
      const entryIds = entries
        .filter((e) => (e.page_index ?? 0) === pageIndex)
        .map((e) => e.id)

      const { thumbs: pageThumbMap, pageLoaded } = await loadGalleryPage(pageIndex, entryIds)
      if (session !== sessionRef.current) return

      if (pageThumbMap.size > 0) {
        setThumbs((prev) => new Map([...prev, ...pageThumbMap]))
      }
      // Only mark the page as loaded when the fetch genuinely returned data.
      // A phantom-complete page (0 entries returned but missing ids exist) is
      // NOT marked loaded — the sentinel stays so scrolling back can retry.
      if (pageLoaded) {
        setLoadedPages((prev) => new Set(prev).add(pageIndex))
      }
    } catch (e) {
      if (session === sessionRef.current) setPageError(e)
      if (import.meta.env.DEV) {
        console.warn(`[useGallery] loadPage(${pageIndex}) failed:`, e)
      }
      // Non-fatal — page just won't have thumbnails; user can scroll back
    } finally {
      loadingPagesRef.current.delete(taskKey)
      setLoadingPage(loadingPagesRef.current.size > 0)
    }
  }, [entries])

  // ---------------------------------------------------------------------------
  // Merge optimistic entries while their atomic storage commit is in flight.
  // ---------------------------------------------------------------------------

  const allEntries = useMemo(() => {
    if (!optimisticEntries || optimisticEntries.length === 0) return entries
    const realIds = new Set(entries.map((e) => e.id))
    const pending = optimisticEntries.filter((e) => !realIds.has(e.id))
    if (pending.length === 0) return entries
    // Pending entries at the top, sorted by date_taken descending within that set.
    return [
      ...pending.sort((a, b) => b.date_taken.localeCompare(a.date_taken)),
      ...entries,
    ]
  }, [entries, optimisticEntries])

  const allThumbs = useMemo(() => {
    if (!optimisticThumbs || optimisticThumbs.size === 0) return thumbs
    return new Map([...thumbs, ...optimisticThumbs])
  }, [thumbs, optimisticThumbs])

  return {
    entries: allEntries,
    thumbs: allThumbs,
    updatedAt,
    loading,
    thumbsLoading,
    loadingPage,
    pageError,
    totalPages,
    loadedPages,
    loadPage,
    error,
    reload,
  }
}
