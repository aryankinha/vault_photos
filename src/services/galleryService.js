/**
 * Gallery orchestration: load manifest + bundle, decrypt, sort by date taken,
 * and hand back entries paired with their thumbnail blobs. Uses the session
 * cache to skip the network on warm loads within the same unlocked session.
 *
 * V3 adds loadGalleryProgressive() — a two-phase loader with persistent IDB thumb cache:
 *   Phase 1 (manifest):  entries available immediately, thumbs = IDB-cached blobs
 *   Phase 2 (thumbs):    missing thumbs fetched from bundle, written back to IDB
 *
 * V3 also adds loadGalleryPage() — loads a single bundle page on demand (called
 * by the gallery IntersectionObserver as the user scrolls).
 */
import { parseBundle, serializeBundleEntries } from '../schema/bundleSchema'
import { streamBundleEntries } from '../utils/bundleStream'
import { decryptPackedOffThread } from '../crypto/decrypt'
import {
  getBundleCache,
  getCachedThumb,
  getManifestCache,
  setBundleCache,
  setCachedThumbs,
  setManifestCache,
} from '../session/cache'
import { loadBundle } from '../storage/bundle'
import { loadBundlePage } from '../storage/bundle'
import { loadManifest } from '../storage/manifest'
import * as workerClient from '../storage/workerClient'

// Number of thumbnails to hydrate per event-loop tick during progressive load.
const THUMB_BATCH_SIZE = 8

// ---------------------------------------------------------------------------
// V2 — original all-at-once loader (UNCHANGED — used by reload and fallback)
// ---------------------------------------------------------------------------

export async function loadGallery() {
  const manifest = await loadManifestWithCache()
  const thumbs = await loadThumbMapWithCache()

  const entries = [...manifest.files].sort((a, b) => {
    return b.date_taken.localeCompare(a.date_taken)
  })

  return { entries, thumbs, updatedAt: manifest.updated_at }
}

// ---------------------------------------------------------------------------
// V3 — progressive two-phase loader with persistent thumb cache
// ---------------------------------------------------------------------------

/**
 * Load the gallery in two phases, using the persistent IDB thumb cache.
 *
 * Phase 1 — manifest + IDB-cached thumbs (fast — no network on warm load):
 *   onUpdate({ entries, thumbs: Map(cached), updatedAt, phase: 'manifest', done: false })
 *   If ALL thumbs are cached: done: true is emitted immediately, no phase 2.
 *
 * Phase 2 — missing thumbs fetched from bundle (network):
 *   onUpdate({ entries, thumbs: growing Map, updatedAt, phase: 'thumbs', done: false })
 *   …repeated every THUMB_BATCH_SIZE thumbnails…
 *   onUpdate({ entries, thumbs: full Map, updatedAt, phase: 'done', done: true })
 *
 * @param {(update: GalleryUpdate) => void} onUpdate
 * @returns {Promise<{ entries, thumbs, updatedAt }>}
 */
export async function loadGalleryProgressive(onUpdate) {
  // ── Phase 1: manifest ───────────────────────────────────────────────────
  const manifest = await loadManifestWithCache()
  const entries = [...manifest.files].sort((a, b) =>
    b.date_taken.localeCompare(a.date_taken),
  )
  const updatedAt = manifest.updated_at

  // ── Phase 1b: populate thumbs from persistent IDB cache ─────────────────
  // Check IDB for every entry simultaneously (parallel reads are fast in IDB).
  const cachedResults = await Promise.all(
    entries.map((e) => getCachedThumb(e.id).catch(() => null)),
  )

  const thumbs = new Map()
  const uncachedEntries = []

  for (let i = 0; i < entries.length; i++) {
    const blob = cachedResults[i]
    if (blob) {
      thumbs.set(entries[i].id, blob)
    } else {
      uncachedEntries.push(entries[i])
    }
  }

  // Emit Phase 1 update — grid renders immediately with all cached thumbs.
  const allCached = uncachedEntries.length === 0
  onUpdate({ entries, thumbs: new Map(thumbs), updatedAt, phase: 'manifest', done: allCached })

  if (allCached) {
    // Complete warm load — zero network, zero crypto, < 200ms total.
    return { entries, thumbs, updatedAt }
  }

  // ── Phase 2: fetch missing thumbs from bundle (off-thread decrypt) ───────
  let decryptedBundleBytes = null

  // Check OPFS/IDB bundle cache first (already decrypted bytes — no crypto needed).
  const cached = await getBundleCache()
  if (cached) {
    try {
      decryptedBundleBytes = cached instanceof ArrayBuffer
        ? new Uint8Array(cached)
        : cached
    } catch {
      decryptedBundleBytes = null
    }
  }

  if (!decryptedBundleBytes) {
    let encryptedBuffer
    try {
      encryptedBuffer = await workerClient.getBundle()
    } catch (e) {
      if (e.status === 404) {
        onUpdate({ entries, thumbs: new Map(thumbs), updatedAt, phase: 'done', done: true })
        return { entries, thumbs, updatedAt }
      }
      throw e
    }

    // Decrypt off the main thread using the crypto worker pool.
    const decrypted = await decryptPackedOffThread(new Uint8Array(encryptedBuffer))
    decryptedBundleBytes = new Uint8Array(decrypted)

    // Write-through to cache for the next load (best-effort).
    void persistBundleBytes(decryptedBundleBytes)
  }

  // Build a Set of uncached ids for O(1) lookup during iteration.
  const uncachedIds = new Set(uncachedEntries.map((e) => e.id))

  // ── Hydrate missing thumbnails in batches ─────────────────────────────────
  let batchCount = 0
  const newlyDecrypted = []   // { id, blob } — for batch IDB write at end

  for (const entry of streamBundleEntries(decryptedBundleBytes)) {
    if (!uncachedIds.has(entry.id)) continue  // already in cache, skip

    const blob = new Blob([entry.bytes], { type: 'image/jpeg' })
    thumbs.set(entry.id, blob)
    newlyDecrypted.push({ id: entry.id, blob })
    batchCount++

    if (batchCount % THUMB_BATCH_SIZE === 0) {
      onUpdate({ entries, thumbs: new Map(thumbs), updatedAt, phase: 'thumbs', done: false })
      await yieldToMain()
    }
  }

  // Persist all newly decrypted thumbs to IDB in one batch (fire-and-forget).
  if (newlyDecrypted.length > 0) {
    void setCachedThumbs(newlyDecrypted).catch(() => {})
  }

  onUpdate({ entries, thumbs: new Map(thumbs), updatedAt, phase: 'done', done: true })
  return { entries, thumbs, updatedAt }
}

// ---------------------------------------------------------------------------
// V3 — demand-driven page loader (called by IntersectionObserver in Gallery)
// ---------------------------------------------------------------------------

/**
 * Load a single bundle page by index and return a Map<id, Blob> for that page.
 * Checks the IDB thumb cache first — entries already cached are not re-fetched.
 * Newly loaded thumbs are written back to IDB in the background.
 *
 * Called by useGallery.loadPage(n) when the user scrolls near page N's content.
 *
 * @param {number} pageIndex — zero-based page index
 * @param {string[]} entryIds — ids of entries on this page (from manifest)
 * @returns {Promise<Map<string, Blob>>}
 */
export async function loadGalleryPage(pageIndex, entryIds) {
  const result = new Map()
  if (!entryIds || entryIds.length === 0) return result

  // Check IDB cache for all ids on this page in parallel.
  const cachedResults = await Promise.all(
    entryIds.map((id) => getCachedThumb(id).catch(() => null)),
  )

  const missingIds = new Set()
  for (let i = 0; i < entryIds.length; i++) {
    if (cachedResults[i]) {
      result.set(entryIds[i], cachedResults[i])
    } else {
      missingIds.add(entryIds[i])
    }
  }

  if (missingIds.size === 0) return result  // all from cache

  // Fetch the bundle page from HF (404 = page not written yet = return what we have).
  const pageEntries = await loadBundlePage(pageIndex)
  const newlyDecrypted = []

  for (const entry of pageEntries) {
    if (!missingIds.has(entry.id)) continue
    const blob = new Blob([entry.bytes], { type: 'image/jpeg' })
    result.set(entry.id, blob)
    newlyDecrypted.push({ id: entry.id, blob })
  }

  // Write newly loaded thumbs to IDB cache (fire-and-forget).
  if (newlyDecrypted.length > 0) {
    void setCachedThumbs(newlyDecrypted).catch(() => {})
  }

  return result
}

// ---------------------------------------------------------------------------
// Shared private helpers
// ---------------------------------------------------------------------------

/**
 * Try the cached decrypted manifest bytes first; fall back to the network.
 * The cache is written through on every successful load.
 */
async function loadManifestWithCache() {
  const cached = await getManifestCache()
  if (cached) {
    try {
      return parseJsonManifest(cached)
    } catch {
      // Stale/corrupt cache — fall through to network.
    }
  }

  const manifest = await loadManifest()
  void persistManifest(manifest)
  return manifest
}

async function loadThumbMapWithCache() {
  const cached = await getBundleCache()
  if (cached) {
    try {
      return entriesToThumbMap(parseBundle(cached))
    } catch {
      // Stale/corrupt cache — fall through to network.
    }
  }

  const entries = await loadBundle()
  void persistBundle(entries)
  return entriesToThumbMap(entries)
}

function parseJsonManifest(bytes) {
  const text = new TextDecoder().decode(bytes)
  return JSON.parse(text)
}

function entriesToThumbMap(entries) {
  const map = new Map()
  for (const entry of entries) {
    map.set(entry.id, new Blob([entry.bytes], { type: 'image/jpeg' }))
  }
  return map
}

async function persistManifest(manifest) {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(manifest))
    await setManifestCache(bytes)
  } catch {
    // Cache writes are best-effort; never fail the gallery load over them.
  }
}

async function persistBundle(entries) {
  try {
    // Re-serialize the parsed entries into the same binary layout for cache.
    await setBundleCache(serializeBundleEntries(entries))
  } catch {
    // Best-effort.
  }
}

/**
 * Persist already-decrypted bundle bytes directly to IndexedDB.
 * Avoids the re-serialize → re-parse round-trip that persistBundle() does.
 */
async function persistBundleBytes(bytes) {
  try {
    await setBundleCache(bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  } catch {
    // Best-effort.
  }
}

/**
 * Yield to the browser's main thread to allow a paint before the next batch.
 * Uses scheduler.yield() when available (Chrome 115+), falls back to
 * setTimeout(0) elsewhere.
 */
function yieldToMain() {
  if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
    return scheduler.yield()
  }
  return new Promise((resolve) => setTimeout(resolve, 0))
}

// Re-exported for the lock flow and for callers that need to invalidate cache.
export { clearCache } from '../session/cache'

