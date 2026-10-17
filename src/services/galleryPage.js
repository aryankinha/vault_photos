/**
 * Pure page-ordering helpers for the gallery service.
 *
 * These functions are extracted from galleryService.js so they can be unit
 * tested in Node.js without pulling in the full module dependency graph
 * (which uses Vite-style extensionless imports).
 */

/**
 * Determine which bundle page to load first. Pages are numbered sequentially
 * as they are created during upload, so page 0 holds the oldest entries and
 * the highest page index holds the newest. Because the gallery displays
 * entries sorted by date_taken descending (newest first), we must load the
 * page containing the newest uncached entry first — otherwise the user sees
 * a wall of old placeholders before new content arrives.
 *
 * @param {object[]} entries — manifest entries sorted newest-first
 * @param {Map<string, Blob>} thumbs — currently cached thumbnails
 * @returns {number} zero-based page index to load first
 */
export function computeInitialPage(entries, thumbs) {
  for (const entry of entries) {
    if (!thumbs || !thumbs.has(entry.id)) {
      return entry.page_index ?? 0
    }
  }
  return 0
}

/**
 * Determine the next page to load in display order. Instead of loading pages
 * numerically (0, 1, 2…) we walk the newest-first entry list and return the
 * page of the first entry that is not yet visible (no cached thumb, not on a
 * loaded page, not optimistic). This ensures pages are hydrated in the order
 * the user actually sees them.
 *
 * @param {object[]} entries — manifest entries sorted newest-first
 * @param {number} totalPages — total number of bundle pages
 * @param {Set<number>} loadedPages — pages already loaded
 * @param {Map<string, Blob>} [thumbs] — cached thumbnails
 * @param {Map<string, object>} [optimisticStates] — optimistic upload states
 * @returns {number|null} next page index, or null when all pages are loaded
 */
export function computeNextPage(entries, totalPages, loadedPages, thumbs, optimisticStates) {
  for (const entry of entries) {
    const pageIndex = entry.page_index ?? 0
    if (loadedPages.has(pageIndex)) continue
    if (thumbs && thumbs.has(entry.id)) continue
    if (optimisticStates && optimisticStates.has(entry.id)) continue
    return pageIndex
  }
  // All entries are visible or loaded; check for any remaining unloaded pages.
  for (let p = 0; p < totalPages; p++) {
    if (!loadedPages.has(p)) return p
  }
  return null
}

/**
 * Determine whether a page load should be marked as complete. Returns false
 * when the page fetch returned no entries but there are still missing ids —
 * the caller must NOT mark this page as loaded so the sentinel can retry.
 *
 * @param {number} pageEntryCount — number of entries returned by the fetch
 * @param {number} missingIdCount — number of ids that were not in the cache
 * @returns {boolean} true if the page should be marked as loaded
 */
export function shouldMarkPageLoaded(pageEntryCount, missingIdCount) {
  if (pageEntryCount === 0 && missingIdCount > 0) return false
  return true
}
