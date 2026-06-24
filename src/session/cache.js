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
 *
 * V2 adds a separate 'uploadQueue' object store for background sync. Each entry
 * is { id, encryptedBytes, entry } — the already-encrypted file bytes and the
 * manifest entry, persisted before the network upload begins so a service worker
 * can retry them if the tab closes mid-upload.
 */
import { openDB } from 'idb'
import { clearOpfsBundle, getOpfsBundle, setOpfsBundle } from '../storage/opfsCache'

const DB_NAME = 'vaultphotos-session'
// Bump version to 2 so the upgrade callback can create the new store.
const DB_VERSION = 2
const STORE = 'kv'
const MANIFEST_KEY = 'manifest'
const BUNDLE_KEY = 'bundle'
const QUEUE_STORE = 'uploadQueue'

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
 */
export async function clearCache() {
  // Clear IDB kv store (manifest + any legacy bundle entry).
  await (await db()).clear(STORE)
  // Clear OPFS bundle.
  await clearOpfsBundle()
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
