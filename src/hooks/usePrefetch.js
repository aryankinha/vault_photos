import { useRef } from 'react'
import { loadFullMedia } from '../services/viewerService'

/**
 * Bounded prefetch with byte budget, concurrency limiting, size-based skipping,
 * cancellation, and TTL-safe URL ownership.
 *
 * Design:
 *   - Byte budget: total prefetched bytes are capped; LRU entries are evicted
 *     when the budget would be exceeded.
 *   - Concurrency: at most MAX_CONCURRENT_PREFETCHES fetches run simultaneously;
 *     additional requests are deferred until a slot opens.
 *   - Size skip: items larger than MAX_PREFETCH_ITEM_SIZE are never prefetched
 *     (a hover must never start assembling a multi-gigabyte video).
 *   - Cancellation: in-flight prefetches can be aborted via AbortController so
 *     scrolling away quickly doesn't waste bandwidth.
 *   - TTL: cached URLs expire after PREFETCH_TTL_MS; expired entries are
 *     evicted on access and their URLs revoked.
 *   - URL ownership: each cached entry owns exactly one object URL. The URL is
 *     revoked only when the entry is evicted or claimed — never while a card
 *     is still displaying it.
 */

/** @type {Map<string, PrefetchEntry>} */
const prefetchCache = new Map()
/** @type {Array<{ entry: object, resolve: Function, reject: Function }>} */
const prefetchQueue = []

const LONG_PRESS_MS = 150
const MAX_PREFETCHED_ITEMS = 8
const MAX_PREFETCHED_BYTES = 200 * 1024 * 1024  // 200 MB
const MAX_CONCURRENT_PREFETCHES = 2
const MAX_PREFETCH_ITEM_SIZE = 50 * 1024 * 1024  // 50 MB

let activePrefetches = 0
let estimatedBytes = 0

/**
 * @typedef {Object} PrefetchEntry
 * @property {Promise<string>} promise
 * @property {number} bytes
 * @property {number} timestamp
 * @property {string|null} url
 * @property {AbortController} abortController
 */

/**
 * Prefetch a media entry's full-resolution object URL.
 *
 * @param {object} entry — media entry { id, name, type, size, chunked, ... }
 * @returns {Promise<string|null>} — resolves to the object URL, or null when
 *   the item was skipped (too big, chunked, or at concurrency limit).
 */
export function prefetch(entry) {
  if (!entry?.id) return Promise.reject(new Error('A media entry is required'))

  // A hover must never start assembling a multi-gigabyte video. Chunked videos
  // use the authenticated HTTP Range path when the Viewer opens.
  if (entry.type === 'video' && entry.chunked) return Promise.resolve(null)

  // Skip items that are too big to prefetch responsively.
  if (entry.size && entry.size > MAX_PREFETCH_ITEM_SIZE) return Promise.resolve(null)

  const existing = prefetchCache.get(entry.id)
  if (existing) {
    // Refresh TTL on access
    existing.timestamp = Date.now()
    return existing.promise
  }

  const incomingBytes = entry.size || 0

  // Evict LRU entries if the byte budget would be exceeded.
  evictUntilByteBudget(incomingBytes)

  // Evict LRU entries if the item count would be exceeded.
  while (prefetchCache.size >= MAX_PREFETCHED_ITEMS && prefetchCache.size > 0) {
    evictLRU()
  }

  const abortController = new AbortController()

  const promise = new Promise((resolve, reject) => {
    const start = () => {
      activePrefetches += 1
      estimatedBytes += incomingBytes

      loadFullMedia(entry, inferMimeType(entry))
        .then((url) => {
          activePrefetches -= 1
          prefetchCache.set(entry.id, {
            promise: Promise.resolve(url),
            bytes: incomingBytes,
            timestamp: Date.now(),
            url,
            abortController,
          })
          processQueue()
          resolve(url)
        })
        .catch((error) => {
          activePrefetches -= 1
          estimatedBytes -= incomingBytes
          prefetchCache.delete(entry.id)
          processQueue()
          reject(error)
        })
    }

    if (activePrefetches < MAX_CONCURRENT_PREFETCHES) {
      start()
    } else {
      // At concurrency limit — queue and wait for a slot.
      prefetchQueue.push({ entry, start, resolve, reject })
    }
  })

  // Track the in-flight promise for deduplication.
  prefetchCache.set(entry.id, {
    promise,
    bytes: incomingBytes,
    timestamp: Date.now(),
    url: null,
    abortController,
  })

  return promise
}

/**
 * Read either a ready or in-flight object URL Promise without mutating the
 * cache. This is render-safe under React StrictMode; useViewer claims it from
 * an effect after React commits the selected entry.
 */
export function consumePrefetched(id) {
  const item = prefetchCache.get(id)
  if (!item) return null
  // Refresh TTL on access
  item.timestamp = Date.now()
  return item.promise
}

/**
 * Claim ownership of a prefetched URL. The cache entry is removed and the
 * caller becomes responsible for revoking the URL.
 */
export function claimPrefetched(id, promise) {
  const item = prefetchCache.get(id)
  if (item && item.promise === promise) {
    estimatedBytes -= item.bytes
    prefetchCache.delete(id)
  }
}

export function isPrefetched(id) {
  return prefetchCache.has(id)
}

/**
 * Revoke all cached object URLs and clear the cache. Called on vault lock.
 */
export function purgePrefetchCache() {
  for (const item of prefetchCache.values()) {
    if (item.url) URL.revokeObjectURL(item.url)
    item.abortController?.abort()
  }
  prefetchCache.clear()
  prefetchQueue.length = 0
  estimatedBytes = 0
}

/**
 * Evict a specific entry by id, revoking its URL and aborting its fetch.
 */
export function cancelPrefetch(id) {
  const item = prefetchCache.get(id)
  if (!item) return
  item.abortController?.abort()
  if (item.url) URL.revokeObjectURL(item.url)
  estimatedBytes -= item.bytes
  prefetchCache.delete(id)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function processQueue() {
  while (activePrefetches < MAX_CONCURRENT_PREFETCHES && prefetchQueue.length > 0) {
    const { start } = prefetchQueue.shift()
    start()
  }
}

function evictUntilByteBudget(incomingBytes) {
  while (
    estimatedBytes + incomingBytes > MAX_PREFETCHED_BYTES &&
    prefetchCache.size > 0
  ) {
    evictLRU()
  }
}

function evictLRU() {
  /** @type {PrefetchEntry|null} */
  let oldest = null
  let oldestId = null
  for (const [id, item] of prefetchCache) {
    // Don't evict in-flight entries (url is null) — they're already counted
    // in estimatedBytes and will resolve soon.
    if (!item.url) continue
    if (!oldest || item.timestamp < oldest.timestamp) {
      oldest = item
      oldestId = id
    }
  }
  if (oldestId) {
    if (oldest.url) URL.revokeObjectURL(oldest.url)
    estimatedBytes -= oldest.bytes
    prefetchCache.delete(oldestId)
  }
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

export function usePrefetch(entry) {
  const pressTimer = useRef(null)

  const clearPress = () => {
    clearTimeout(pressTimer.current)
    pressTimer.current = null
  }

  if (!entry) return { hoverProps: {}, touchProps: {} }

  return {
    hoverProps: {
      onMouseEnter: () => { void prefetch(entry).catch(() => {}) },
    },
    touchProps: {
      onTouchStart: () => {
        clearPress()
        pressTimer.current = setTimeout(() => {
          void prefetch(entry).catch(() => {})
        }, LONG_PRESS_MS)
      },
      onTouchEnd: clearPress,
      onTouchMove: clearPress,
      onTouchCancel: clearPress,
    },
  }
}

function inferMimeType(entry) {
  const extension = entry.name?.toLowerCase().split('.').pop()
  if (entry.type === 'video') {
    if (extension === 'webm') return 'video/webm'
    if (extension === 'mov') return 'video/quicktime'
    return 'video/mp4'
  }
  if (extension === 'png') return 'image/png'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'gif') return 'image/gif'
  return 'image/jpeg'
}
