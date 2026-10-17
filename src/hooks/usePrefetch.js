import { useRef } from 'react'
import { loadFullMedia } from '../services/viewerService'

const prefetchCache = new Map()
const LONG_PRESS_MS = 150
const MAX_ITEMS = 8
const MAX_BYTES = 200 * 1024 * 1024
const MAX_ITEM_BYTES = 50 * 1024 * 1024
const TTL_MS = 60_000
let active = 0

export function prefetch(entry) {
  if (!entry?.id || entry.chunked || entry.size > MAX_ITEM_BYTES) return Promise.resolve(null)
  for (const [id, item] of prefetchCache) {
    if (item.url && Date.now() - item.timestamp > TTL_MS) cancelPrefetch(id)
  }
  const existing = prefetchCache.get(entry.id)
  if (existing) return existing.promise
  // Hovering is optional; never queue unbounded work or spin waiting for an
  // in-flight entry to become evictable on this same JavaScript thread.
  if (active >= 2) return Promise.resolve(null)
  const bytes = entry.size || 0
  const total = () => [...prefetchCache.values()].reduce((sum, item) => sum + item.bytes, 0)
  while (prefetchCache.size >= MAX_ITEMS || total() + bytes > MAX_BYTES) {
    const candidate = [...prefetchCache].filter(([, item]) => item.url)
      .sort((a, b) => a[1].timestamp - b[1].timestamp)[0]
    if (!candidate) return Promise.resolve(null)
    cancelPrefetch(candidate[0])
  }
  const controller = new AbortController()
  const item = { bytes, timestamp: Date.now(), controller, url: null, promise: null, claimed: false }
  active += 1
  item.promise = loadFullMedia(entry, inferMimeType(entry), { signal: controller.signal })
    .then((url) => {
      if (controller.signal.aborted) {
        URL.revokeObjectURL(url)
        return null
      }
      if (!item.claimed && prefetchCache.get(entry.id) === item) item.url = url
      return url
    }).catch((error) => {
      if (prefetchCache.get(entry.id) === item) prefetchCache.delete(entry.id)
      if (controller.signal.aborted) return null
      throw error
    }).finally(() => { active -= 1 })
  prefetchCache.set(entry.id, item)
  return item.promise
}

export function consumePrefetched(id) {
  const item = prefetchCache.get(id)
  if (!item) return null
  if (Date.now() - item.timestamp > TTL_MS && item.url) {
    cancelPrefetch(id)
    return null
  }
  return item.promise
}

export function claimPrefetched(id, promise) {
  const item = prefetchCache.get(id)
  if (item?.promise === promise) {
    item.claimed = true
    prefetchCache.delete(id)
  }
}

export function isPrefetched(id) { return prefetchCache.has(id) }
export function cancelPrefetch(id) {
  const item = prefetchCache.get(id)
  if (!item) return
  item.controller.abort()
  if (item.url) URL.revokeObjectURL(item.url)
  prefetchCache.delete(id)
}
export function purgePrefetchCache() {
  for (const id of [...prefetchCache.keys()]) cancelPrefetch(id)
}

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
