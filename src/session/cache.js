/**
 * Session cache. Holds only the *decrypted raw bytes* of the manifest and
 * thumbnail bundle so the gallery loads instantly after the first unlock in a
 * session. The encryption key is NEVER written here — only RAM.
 *
 * The cache is wiped on lock and there is no TTL; if the worker returns a
 * fresher copy the caller can overwrite via setManifestCache/setBundleCache.
 *
 * Storage strategy (V3):
 *   Manifest  → IndexedDB (small JSON, IDB is fine)
 *   Bundle    → OPFS first (fast binary I/O), IDB as fallback for older browsers
 *   Thumbs    → IndexedDB 'thumbCache' store (persistent across sessions)
 *
 * V2 adds a separate 'uploadQueue' object store for background sync. Each entry
 * is { id, encryptedBytes, entry } — the already-encrypted file bytes and the
 * manifest entry, persisted before the network upload begins so a service worker
 * can retry them if the tab closes mid-upload.
 *
 * V3 adds a 'thumbCache' object store for persistent thumbnail blobs. Decrypted
 * thumbnails survive across sessions so returning users see the gallery
 * in < 200 ms with zero network requests.
 *
 * Security note: decrypted thumbnails persist even when the vault is locked.
 * This is intentional — thumbnails are low-sensitivity previews on a personal
 * device. clearActiveKey() / locking the vault does NOT clear thumbCache.
 * Call clearThumbCache() explicitly if the user wants to remove them, or expose
 * a "Clear cache" toggle in a future settings page.
 */
import { openDB } from 'idb'
import { clearOpfsBundle, getOpfsBundle, setOpfsBundle } from '../storage/opfsCache'

const DB_NAME = 'vaultphotos-session'
// Bump version to 3 — adds the thumbCache store.
// Existing kv (v1) and uploadQueue (v2) data is preserved.
const DB_VERSION = 3
const STORE = 'kv'
const MANIFEST_KEY = 'manifest'
const BUNDLE_KEY = 'bundle'
const QUEUE_STORE = 'uploadQueue'
const THUMB_CACHE_STORE = 'thumbCache'

let dbPromise = null

function db() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(database, oldVersion) {
        // v1 → create the kv store (original)
        if (oldVersion < 1) {
          if (!database.objectStoreNames.contains(STORE)) {
            database.createObjectStore(STORE)
          }
        }
        // Support opening a DB that was created at v1 without the kv store
        // (shouldn't happen, but be defensive).
        if (!database.objectStoreNames.contains(STORE)) {
          database.createObjectStore(STORE)
        }
        // v2 → create the uploadQueue store keyed by file id
        if (oldVersion < 2) {
          if (!database.objectStoreNames.contains(QUEUE_STORE)) {
            database.createObjectStore(QUEUE_STORE, { keyPath: 'id' })
          }
        }
        if (!database.objectStoreNames.contains(QUEUE_STORE)) {
          database.createObjectStore(QUEUE_STORE, { keyPath: 'id' })
        }
        // v3 → create the thumbCache store keyed by media entry id
        if (oldVersion < 3) {
          if (!database.objectStoreNames.contains(THUMB_CACHE_STORE)) {
            database.createObjectStore(THUMB_CACHE_STORE, { keyPath: 'id' })
          }
        }
        if (!database.objectStoreNames.contains(THUMB_CACHE_STORE)) {
          database.createObjectStore(THUMB_CACHE_STORE, { keyPath: 'id' })
        }
      },
    })
  }
  return dbPromise
}

// ---------------------------------------------------------------------------
// Manifest — stays in IndexedDB (small JSON, IDB overhead is negligible)
// Signatures unchanged.
// ---------------------------------------------------------------------------

export async function getManifestCache() {
  return (await db()).get(STORE, MANIFEST_KEY)
}

export async function setManifestCache(bytes) {
  await (await db()).put(STORE, bytes, MANIFEST_KEY)
}

// ---------------------------------------------------------------------------
// Bundle — OPFS primary, IDB fallback (V3 upgrade)
// Signatures unchanged — callers see no difference.
// ---------------------------------------------------------------------------

/**
 * Read bundle bytes from cache.
 * Tries OPFS first (fast); falls back to IDB.
 * On an IDB hit after an OPFS miss, migrates the bytes to OPFS so the
 * next read is fast (transparent one-time migration from V2 → V3).
 *
 * @returns {Promise<ArrayBuffer|Uint8Array|undefined>}
 */
export async function getBundleCache() {
  // 1. Try OPFS — fastest path for modern browsers.
  const opfsData = await getOpfsBundle()
  if (opfsData !== null) return opfsData

  // 2. Fall back to IDB.
  const idbData = await (await db()).get(STORE, BUNDLE_KEY)

  // 3. Migrate IDB → OPFS so subsequent loads use the fast path.
  //    Fire-and-forget: migration failure is non-fatal.
  if (idbData) {
    void setOpfsBundle(idbData).then((ok) => {
      // Once migrated to OPFS, remove the IDB copy to free space.
      if (ok) return (db()).then((d) => d.delete(STORE, BUNDLE_KEY)).catch(() => {})
    })
  }

  return idbData
}

/**
 * Write bundle bytes to cache.
 * Writes to OPFS when available (fast binary I/O, no IDB serialisation).
 * Falls back to IDB on browsers that don't support OPFS.
 *
 * @param {ArrayBuffer|Uint8Array} bytes
 */
export async function setBundleCache(bytes) {
  const opfsOk = await setOpfsBundle(bytes)
  if (!opfsOk) {
    // OPFS not available — write to IDB as the only available store.
    await (await db()).put(STORE, bytes, BUNDLE_KEY)
  }
  // If OPFS succeeded, skip IDB to avoid double-writing.
  // clearCache() will wipe OPFS so nothing lingers after lock.
}

// ---------------------------------------------------------------------------
// Clear — wipes BOTH stores so the lock is complete
// Signature unchanged.
// ---------------------------------------------------------------------------

/**
 * Wipe all cached decrypted data (manifest in IDB + bundle in OPFS/IDB).
 * Called on vault lock and after every upload to invalidate stale data.
 * Does NOT clear thumbCache — see security note in module header.
 */
export async function clearCache() {
  // Clear IDB kv store (manifest + any legacy bundle entry).
  await (await db()).clear(STORE)
  // Clear OPFS bundle.
  await clearOpfsBundle()
}

// ---------------------------------------------------------------------------
// V3 — persistent thumbnail cache (across sessions)
// ---------------------------------------------------------------------------

/**
 * Retrieve a cached thumbnail blob by media entry id.
 *
 * @param {string} id — 16-hex media entry id
 * @returns {Promise<Blob|null>}
 */
export async function getCachedThumb(id) {
  const row = await (await db()).get(THUMB_CACHE_STORE, id)
  return row ? row.blob : null
}

/**
 * Persist a single thumbnail blob to the cache.
 *
 * @param {string} id — 16-hex media entry id
 * @param {Blob} blob — decrypted thumbnail JPEG as Blob
 */
export async function setCachedThumb(id, blob) {
  await (await db()).put(THUMB_CACHE_STORE, { id, blob, cachedAt: Date.now() })
}

/**
 * Batch-write multiple thumbnails in a single transaction.
 * Significantly more efficient than N individual setCachedThumb calls for
 * large galleries on first load.
 *
 * @param {{ id: string, blob: Blob }[]} entries
 */
export async function setCachedThumbs(entries) {
  if (!entries || entries.length === 0) return
  const database = await db()
  const tx = database.transaction(THUMB_CACHE_STORE, 'readwrite')
  await Promise.all([
    ...entries.map(({ id, blob }) =>
      tx.store.put({ id, blob, cachedAt: Date.now() }),
    ),
    tx.done,
  ])
}

/**
 * Remove a single thumbnail from the cache.
 * @param {string} id
 */
export async function deleteCachedThumb(id) {
  await (await db()).delete(THUMB_CACHE_STORE, id)
}

/**
 * Wipe the entire thumbnail cache.
 * Call this from a settings page if the user wants to free storage.
 */
export async function clearThumbCache() {
  await (await db()).clear(THUMB_CACHE_STORE)
}

/**
 * Return basic stats about the thumbnail cache.
 * @returns {Promise<{ count: number, estimatedBytes: number }>}
 */
export async function getThumbCacheStats() {
  const database = await db()
  const all = await database.getAll(THUMB_CACHE_STORE)
  let estimatedBytes = 0
  for (const row of all) {
    if (row.blob && typeof row.blob.size === 'number') {
      estimatedBytes += row.blob.size
    }
  }
  return { count: all.length, estimatedBytes }
}

// ---------------------------------------------------------------------------
// V2 — upload queue (for background sync / tab-close recovery)
// Signatures unchanged.
// ---------------------------------------------------------------------------

/**
 * Persist an already-encrypted upload to the queue so a service worker can
 * retry it if the tab closes before the network upload completes.
 *
 * @param {string} id — 16-hex file id
 * @param {Uint8Array} encryptedBytes
 * @param {object} entry — manifest entry object (without thumb_offset/thumb_length yet)
 */
export async function queueUpload(id, encryptedBytes, entry) {
  await (await db()).put(QUEUE_STORE, { id, encryptedBytes, entry })
}

/**
 * Remove a completed upload from the queue.
 * @param {string} id
 */
export async function dequeueUpload(id) {
  await (await db()).delete(QUEUE_STORE, id)
}

/**
 * Return all pending uploads in the queue.
 * @returns {Promise<{ id: string, encryptedBytes: Uint8Array, entry: object }[]>}
 */
export async function getUploadQueue() {
  return (await db()).getAll(QUEUE_STORE)
}

