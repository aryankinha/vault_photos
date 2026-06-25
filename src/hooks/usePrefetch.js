/**
 * usePrefetch — Phase 8: Prefetch on Hover / Long Press
 *
 * Architecture
 * ───────────────────────────────────────────────────────
 * A module-level singleton keeps two maps:
 *
 *   inflightMap  — entry.id → Promise<string>   (in-flight decryptions)
 *   resolvedMap  — entry.id → string (object URL) (already decrypted)
 *
 * Why module-level?
 *   The prefetch cache must outlive individual component instances so that a
 *   URL built in Gallery is immediately consumable in Viewer without a second
 *   decrypt round-trip.
 *
 * Object-URL lifecycle
 *   • URLs in resolvedMap are created by URL.createObjectURL() and MUST be
 *     revoked when the vault locks (call purgePrefetchCache()).
 *   • Viewer reads the URL from resolvedMap and takes ownership; after that it
 *     revokes on its own cleanup.  We delete the entry from resolvedMap so it
 *     is not double-revoked.
 *
 * Long-press support (mobile)
 *   usePrefetch() returns a pair of touch handlers that fire after a 200 ms
 *   press — short enough to feel instant, long enough to ignore scroll taps.
 *
 * Concurrency
 *   Multiple hover events for the same id are collapsed: the existing promise
 *   is returned and the second caller simply attaches a .then() to it.
 *
 * Backward compatibility
 *   loadFullMedia() already handles both regular and chunked entries, so the
 *   prefetcher supports both transparently.
 */

import { loadFullMedia } from '../services/viewerService'

// ─── Singleton state ──────────────────────────────────────────────────────────

/** @type {Map<string, Promise<string>>} */
const inflightMap = new Map()

/** @type {Map<string, string>} */
const resolvedMap = new Map()

// ─── Public helpers ───────────────────────────────────────────────────────────

/**
 * Start prefetching `entry` if not already cached or in-flight.
 *
 * @param {object} entry  — manifest entry with at least `id`, `type`, `name`
 * @returns {Promise<string>}  object URL (resolves when decryption is done)
 */
export function prefetch(entry) {
  const { id } = entry
  if (!id) return Promise.reject(new Error('entry.id is required'))

  // Already resolved — return immediately
  if (resolvedMap.has(id)) return Promise.resolve(resolvedMap.get(id))

  // Already in-flight — coalesce
  if (inflightMap.has(id)) return inflightMap.get(id)

  const mimeType = inferMimeType(entry)

  const promise = loadFullMedia(entry, mimeType)
    .then((url) => {
      resolvedMap.set(id, url)
      inflightMap.delete(id)
      return url
    })
    .catch((err) => {
      // Remove from inflight so a retry is possible on the next hover
      inflightMap.delete(id)
      throw err
    })

  inflightMap.set(id, promise)
  return promise
}

/**
 * Synchronously retrieve a prefetched object URL and remove it from the cache
 * (caller takes ownership and is responsible for revoking it).
 *
 * @param {string} id
 * @returns {string|null}
 */
export function consumePrefetched(id) {
  if (!resolvedMap.has(id)) return null
  const url = resolvedMap.get(id)
  resolvedMap.delete(id)
  return url
}

/**
 * Check whether a prefetched URL is ready for a given id.
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isPrefetched(id) {
  return resolvedMap.has(id)
}

/**
 * Revoke all object URLs and clear all state.  Call when the vault locks so
 * decrypted bytes are wiped from memory.
 */
export function purgePrefetchCache() {
  for (const url of resolvedMap.values()) {
    try { URL.revokeObjectURL(url) } catch { /* ignore */ }
  }
  resolvedMap.clear()
  inflightMap.clear()
}

// ─── React hook ───────────────────────────────────────────────────────────────

const LONG_PRESS_MS = 200

/**
 * Returns `{ hoverProps, touchProps }` to spread onto a card element.
 * Both trigger `prefetch(entry)` when the user shows intent to open an item.
 *
 * @param {object|null} entry — manifest entry, or null to disable
 * @returns {{ hoverProps: object, touchProps: object }}
 */
export function usePrefetch(entry) {
  if (!entry) return { hoverProps: {}, touchProps: {} }

  function handleMouseEnter() {
    prefetch(entry).catch(() => { /* suppress — will be retried on open */ })
  }

  let pressTimer = null

  function handleTouchStart() {
    clearTimeout(pressTimer)
    pressTimer = setTimeout(() => {
      prefetch(entry).catch(() => { /* suppress */ })
    }, LONG_PRESS_MS)
  }

  function handleTouchEnd() {
    clearTimeout(pressTimer)
  }

  return {
    hoverProps: { onMouseEnter: handleMouseEnter },
    touchProps: {
      onTouchStart: handleTouchStart,
      onTouchEnd: handleTouchEnd,
      onTouchCancel: handleTouchEnd,
    },
  }
}

// ─── Private ─────────────────────────────────────────────────────────────────

function inferMimeType(entry) {
  if (entry?.type === 'video') {
    const ext = entry.name?.toLowerCase().split('.').pop()
    if (ext === 'mp4') return 'video/mp4'
    if (ext === 'webm') return 'video/webm'
    if (ext === 'mov') return 'video/quicktime'
    return 'video/mp4'
  }
  if (entry?.type === 'image') {
    const ext = entry.name?.toLowerCase().split('.').pop()
    if (ext === 'png') return 'image/png'
    if (ext === 'webp') return 'image/webp'
    if (ext === 'gif') return 'image/gif'
    return 'image/jpeg'
  }
  return 'application/octet-stream'
}
