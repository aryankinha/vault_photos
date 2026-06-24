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
 * Phase 6 will add optimistic entry merging (entries appear in gallery during upload).
 * The hook already accepts optimisticEntries + optimisticThumbs from UploadContext so
 * Phase 6 wiring is a drop-in. For now those come from the context stub (empty).
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
  const [error, setError] = useState(null)

  // Ref to track the current load session so stale async updates are discarded.
  const sessionRef = useRef(0)

  const runLoad = useCallback(() => {
    const session = ++sessionRef.current
    setLoading(true)
    setThumbsLoading(true)
    setLoadedPages(new Set())
    setError(null)

    loadGalleryProgressive((update) => {
      if (session !== sessionRef.current) return

      setEntries(update.entries)
      setThumbs(update.thumbs)
      if (update.updatedAt) setUpdatedAt(update.updatedAt)

      // Phase 'manifest' → main loading spinner can stop; grid renders.
      if (update.phase === 'manifest') {
        setLoading(false)
        // Derive total pages from manifest bundle_pages field (default 1 for old vaults).
        // We reach into update.entries to find max page_index; bundle_pages is the source
        // of truth when present. For now derive from entries since we don't expose the
        // raw manifest here. Phase 6 can expose bundle_pages explicitly if needed.
        const maxPageIndex = update.entries.reduce(
          (max, e) => Math.max(max, e.page_index ?? 0),
          0,
        )
        setTotalPages(maxPageIndex + 1)
        // Mark page 0 as loaded (progressive loader always loads page 0 via thumbs.bundle).
        setLoadedPages(new Set([0]))
      }

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
    setLoadedPages((prev) => {
      if (prev.has(pageIndex)) return prev   // already loaded or loading
      return new Set(prev).add(pageIndex)    // mark loading immediately to prevent double-fetch
    })

    setLoadingPage(true)
    try {
      // Collect the entry ids for this page (entries with matching page_index).
      // Old V1/V2 entries have page_index === undefined → treated as page 0.
      const entryIds = entries
        .filter((e) => (e.page_index ?? 0) === pageIndex)
        .map((e) => e.id)

      if (entryIds.length === 0) return  // no entries on this page

      const pageThumbMap = await loadGalleryPage(pageIndex, entryIds)

      if (pageThumbMap.size > 0) {
        setThumbs((prev) => new Map([...prev, ...pageThumbMap]))
      }
    } catch (e) {
      console.warn(`[useGallery] loadPage(${pageIndex}) failed:`, e)
      // Non-fatal — page just won't have thumbnails; user can scroll back
    } finally {
      setLoadingPage(false)
    }
  }, [entries])

  // ---------------------------------------------------------------------------
  // Merge optimistic entries (Phase 6 wiring — additive, no-op until Phase 6)
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
    totalPages,
    loadedPages,
    loadPage,
    error,
    reload,
  }
}
