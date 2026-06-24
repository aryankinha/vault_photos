/**
 * Gallery orchestration: load manifest + bundle, decrypt, sort by date taken,
 * and hand back entries paired with their thumbnail blobs. Uses the session
 * cache to skip the network on warm loads within the same unlocked session.
 *
 * V3 adds loadGalleryProgressive() — a two-phase loader:
 *   Phase 1 (manifest):  entries available immediately, thumbs = empty Map
 *   Phase 2 (thumbs):    bundle decrypts off-thread; thumbs hydrated in batches
 */
import { parseBundle, serializeBundleEntries } from '../schema/bundleSchema'
import { streamBundleEntries } from '../utils/bundleStream'
import { decryptPackedOffThread } from '../crypto/decrypt'
import {
  getBundleCache,
  getManifestCache,
  setBundleCache,
  setManifestCache,
} from '../session/cache'
import { loadBundle } from '../storage/bundle'
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
// V3 — progressive two-phase loader
// ---------------------------------------------------------------------------

/**
 * Load the gallery in two phases and stream updates to the caller.
 *
 * Phase 1 — manifest only (fast: small file):
 *   onUpdate({ entries, thumbs: new Map(), updatedAt, phase: 'manifest', done: false })
 *
 * Phase 2 — bundle decrypted off-thread + parsed in batches:
 *   onUpdate({ entries, thumbs: growing Map, updatedAt, phase: 'thumbs', done: false })
 *   …repeated every THUMB_BATCH_SIZE thumbnails…
 *   onUpdate({ entries, thumbs: full Map, updatedAt, phase: 'done', done: true })
 *
 * @param {(update: GalleryUpdate) => void} onUpdate — called on every phase transition
 * @returns {Promise<{ entries: object[], thumbs: Map<string,Blob>, updatedAt: string }>}
 *          Resolves once all thumbnails are hydrated (or when there are none).
 */
export async function loadGalleryProgressive(onUpdate) {
  // ── Phase 1: manifest ───────────────────────────────────────────────────
  const manifest = await loadManifestWithCache()
  const entries = [...manifest.files].sort((a, b) =>
    b.date_taken.localeCompare(a.date_taken),
  )
  const updatedAt = manifest.updated_at

  // Emit immediately — gallery grid can render with skeleton thumbnails.
  onUpdate({ entries, thumbs: new Map(), updatedAt, phase: 'manifest', done: false })

  // ── Phase 2: bundle (off-thread decrypt → progressive parse) ────────────
  let decryptedBundleBytes = null

  // Check IndexedDB cache first (already decrypted bytes — no crypto needed).
  const cached = await getBundleCache()
  if (cached) {
    try {
      // Cache stores the serialized (decrypted) bundle binary.
      decryptedBundleBytes = cached instanceof ArrayBuffer
        ? new Uint8Array(cached)
        : cached
    } catch {
      // Corrupt cache — fall through to network.
      decryptedBundleBytes = null
    }
  }

  if (!decryptedBundleBytes) {
    // Download the encrypted bundle.
    let encryptedBuffer
    try {
      encryptedBuffer = await workerClient.getBundle()
    } catch (e) {
      if (e.status === 404) {
        // First run / empty vault — no bundle yet.
        onUpdate({ entries, thumbs: new Map(), updatedAt, phase: 'done', done: true })
        return { entries, thumbs: new Map(), updatedAt }
      }
      throw e
    }

    // Decrypt off the main thread using the crypto worker pool.
    const decrypted = await decryptPackedOffThread(new Uint8Array(encryptedBuffer))
    decryptedBundleBytes = new Uint8Array(decrypted)

    // Write-through to cache for the next load (best-effort).
    void persistBundleBytes(decryptedBundleBytes)
  }

  // ── Hydrate thumbnails in batches ────────────────────────────────────────
  const thumbs = new Map()
  let batchCount = 0

  for (const entry of streamBundleEntries(decryptedBundleBytes)) {
    thumbs.set(entry.id, new Blob([entry.bytes], { type: 'image/jpeg' }))
    batchCount++

    if (batchCount % THUMB_BATCH_SIZE === 0) {
      // Emit a copy of the current map so React sees a new reference.
      onUpdate({ entries, thumbs: new Map(thumbs), updatedAt, phase: 'thumbs', done: false })
      // Yield to the event loop so the browser can paint the new batch.
      await yieldToMain()
    }
  }

  // Final emit — all thumbnails hydrated.
  onUpdate({ entries, thumbs: new Map(thumbs), updatedAt, phase: 'done', done: true })
  return { entries, thumbs, updatedAt }
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
