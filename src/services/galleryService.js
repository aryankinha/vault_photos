/**
 * Gallery orchestration: load manifest + bundle, decrypt, sort by date taken,
 * and hand back entries paired with their thumbnail blobs. Uses the session
 * cache to skip the network on warm loads within the same unlocked session.
 */
import { parseBundle, serializeBundleEntries } from '../schema/bundleSchema'
import {
  getBundleCache,
  getManifestCache,
  setBundleCache,
  setManifestCache,
} from '../session/cache'
import { loadBundle } from '../storage/bundle'
import { loadManifest } from '../storage/manifest'

export async function loadGallery() {
  const manifest = await loadManifestWithCache()
  const thumbs = await loadThumbMapWithCache()

  const entries = [...manifest.files].sort((a, b) => {
    return b.date_taken.localeCompare(a.date_taken)
  })

  return { entries, thumbs, updatedAt: manifest.updated_at }
}

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

// Re-exported for the lock flow and for callers that need to invalidate cache.
export { clearCache } from '../session/cache'
