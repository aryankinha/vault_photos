import { useRef } from 'react'
import { loadFullMedia } from '../services/viewerService'

/** @type {Map<string, Promise<string>>} */
const prefetchCache = new Map()
const LONG_PRESS_MS = 150
const MAX_PREFETCHED_ITEMS = 8

export function prefetch(entry) {
  if (!entry?.id) return Promise.reject(new Error('A media entry is required'))
  // A hover must never start assembling a multi-gigabyte video. Chunked videos
  // use the authenticated HTTP Range path when the Viewer opens.
  if (entry.type === 'video' && entry.chunked) return Promise.resolve(null)
  const existing = prefetchCache.get(entry.id)
  if (existing) return existing

  evictOverflow()

  const promise = loadFullMedia(entry, inferMimeType(entry)).catch((error) => {
    if (prefetchCache.get(entry.id) === promise) prefetchCache.delete(entry.id)
    throw error
  })
  prefetchCache.set(entry.id, promise)
  return promise
}

/**
 * Read either a ready or in-flight object URL Promise without mutating the
 * cache. This is render-safe under React StrictMode; useViewer claims it from
 * an effect after React commits the selected entry.
 */
export function consumePrefetched(id) {
  return prefetchCache.get(id) || null
}

export function claimPrefetched(id, promise) {
  if (prefetchCache.get(id) === promise) prefetchCache.delete(id)
}

export function isPrefetched(id) {
  return prefetchCache.has(id)
}

export function purgePrefetchCache() {
  for (const promise of prefetchCache.values()) {
    promise.then((url) => URL.revokeObjectURL(url)).catch(() => {})
  }
  prefetchCache.clear()
}

function evictOverflow() {
  while (prefetchCache.size >= MAX_PREFETCHED_ITEMS) {
    const oldest = prefetchCache.entries().next().value
    if (!oldest) return
    const [id, promise] = oldest
    prefetchCache.delete(id)
    promise.then((url) => URL.revokeObjectURL(url)).catch(() => {})
  }
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
