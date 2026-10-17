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
 * V2 adds a separate 'uploadQueue' object store for recovery. Small files keep
 * already-encrypted bytes; chunked files keep completed LFS receipts. Both retain
 * the original media id so finalization retries are idempotent.
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
import { clearOpfsBundle, getOpfsBundle, setOpfsBundle } from '../storage/opfsCache.js'
import { getActiveKey } from '../crypto/keyDerivation.js'
import { decryptPacked } from '../crypto/decrypt.js'
import { encryptPacked } from '../crypto/encrypt.js'

const DB_NAME = 'vaultphotos-session'
// Bump version to 3 — adds the thumbCache store.
// Existing kv (v1) and uploadQueue (v2) data is preserved.
const DB_VERSION = 3
const STORE = 'kv'
const MANIFEST_KEY = 'manifest'
const BUNDLE_KEY = 'bundle'
const WORKER_URL_KEY = 'workerUrl'
const QUEUE_STORE = 'uploadQueue'
const THUMB_CACHE_STORE = 'thumbCache'
const BACKGROUND_ATTEMPT_LIMIT = 2

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

export async function setWorkerUrl(url) {
  await (await db()).put(STORE, url, WORKER_URL_KEY)
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
  const key = getActiveKey()
  // 1. Try OPFS — fastest path for modern browsers. When a session key exists
  //    the stored bytes are decrypted (encrypted at rest); legacy plaintext
  //    fails to decrypt and is treated as a cache miss.
  const opfsData = await getOpfsBundle(key)
  if (opfsData !== null) return opfsData

  // 2. Fall back to IDB.
  const idbData = await (await db()).get(STORE, BUNDLE_KEY)
  const decoded = idbData ? await decodeCachedBundle(idbData, key) : idbData

  // 3. Migrate IDB → OPFS so subsequent loads use the fast path.
  //    Fire-and-forget: migration failure is non-fatal.
  if (decoded) {
    void setOpfsBundle(decoded, key).then((ok) => {
      // Once migrated to OPFS, remove the IDB copy to free space.
      if (ok) return (db()).then((d) => d.delete(STORE, BUNDLE_KEY)).catch(() => {})
    })
  }

  return decoded
}

/**
 * Decrypt IDB-stored bundle bytes when a session key exists. Bytes written by
 * older versions (plaintext) fail decryption and are returned as-is.
 */
async function decodeCachedBundle(bytes, key) {
  if (!key) return bytes
  const buffer = bytes instanceof ArrayBuffer
    ? bytes
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  try {
    return await decryptPacked(buffer, key)
  } catch {
    return bytes
  }
}

/**
 * Write bundle bytes to cache.
 * Writes to OPFS when available (fast binary I/O, no IDB serialisation).
 * Falls back to IDB on browsers that don't support OPFS.
 *
 * @param {ArrayBuffer|Uint8Array} bytes
 */
export async function setBundleCache(bytes) {
  const key = getActiveKey()
  // Encrypt at rest whenever the vault key is available (OPFS path handles
  // this internally; the IDB fallback needs it explicitly).
  const opfsOk = await setOpfsBundle(bytes, key)
  if (!opfsOk) {
    // OPFS not available — write to IDB as the only available store.
    const stored = key
      ? await encryptPacked(toArrayBuffer(bytes), key)
      : toArrayBuffer(bytes)
    await (await db()).put(STORE, stored, BUNDLE_KEY)
  }
  // If OPFS succeeded, skip IDB to avoid double-writing.
  // clearCache() will wipe OPFS so nothing lingers after lock.
}

function toArrayBuffer(bytes) {
  return bytes instanceof ArrayBuffer
    ? bytes
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
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
  // Clear decrypted IDB entries while preserving the non-secret Worker URL
  // needed by Background Sync after a tab closes or a new document starts.
  const database = await db()
  await database.delete(STORE, MANIFEST_KEY)
  await database.delete(STORE, BUNDLE_KEY)
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
  // Decrypted thumbnails are stored in IndexedDB across sessions.
  // This is intentional for personal device UX — thumbnails are low-resolution
  // previews and the device itself is trusted. Full-resolution files are never
  // cached in plaintext. Use clearThumbCache() to remove these previews.
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

// Mid-session listeners so UI surfaces (pending count, interrupted banner)
// refresh as soon as queue rows appear/disappear instead of only on batch end.
const queueChangeListeners = new Set()

/**
 * Subscribe to upload-queue row changes (enqueue/dequeue/clear).
 * @param {() => void} listener
 * @returns {() => void} unsubscribe
 */
export function onUploadQueueChanged(listener) {
  queueChangeListeners.add(listener)
  return () => queueChangeListeners.delete(listener)
}

function notifyQueueChanged() {
  for (const listener of [...queueChangeListeners]) {
    try {
      listener()
    } catch {
      // A broken listener must not break persistence of queue rows.
    }
  }
}

/**
 * Persist an already-encrypted upload to the queue so a service worker can
 * retry it if the tab closes before the network upload completes.
 *
 * @param {string} id — 16-hex file id
 * @param {Uint8Array} encryptedBytes
 * @param {object} entry — manifest entry object (without thumb_offset/thumb_length yet)
 * @param {Blob} [thumbnail] — small recovery copy if the persistent thumb cache is unavailable
 * @param {string} [sha256] — ciphertext sha256 (X-Vault-SHA256 header)
 * @param {{ fileHash?: string, cryptoVersion?: 1|2 }} [options] — strong
 *   PLAINTEXT sha256 of the whole source file (source re-selection), and the
 *   ciphertext mode used for the retained bytes (2 = context-bound AAD)
 */
export async function queueUpload(id, encryptedBytes, entry, thumbnail, sha256, options = {}) {
  await (await db()).put(QUEUE_STORE, {
    id,
    encryptedBytes,
    entry,
    thumbnail,
    sha256,
    fileHash: options.fileHash ?? null,
    // Legacy rows stay legacy: only explicit v2 marks context-bound bytes.
    cryptoVersion: options.cryptoVersion === 2 ? 2 : undefined,
    backgroundAttempts: 0,
  })
  notifyQueueChanged()
}

/**
 * Persist a chunked upload row BEFORE any chunk upload (U1): a sparse
 * chunks array makes the row recoverable from the moment it exists, no matter
 * how many chunks landed before a tab/browser death.
 *
 * @param {string} id
 * @param {object} entry — manifest entry shape incl. chunked/chunk_size/chunk_count
 * @param {Blob} thumbnail
 * @param {number} chunkCount
 * @param {number} chunkSize
 */
export async function queueChunkedUploadPending(id, entry, thumbnail, chunkCount, chunkSize, chunkHashes = null, options = {}) {
  let hashes = chunkHashes
  let opts = options || {}
  if (chunkHashes && !Array.isArray(chunkHashes) && typeof chunkHashes === 'object') {
    opts = chunkHashes
    hashes = opts.chunkHashes ?? null
  }
  const normalizedHashes = Array.isArray(hashes)
    ? hashes.slice(0, chunkCount).concat(Array.from({ length: Math.max(0, chunkCount - hashes.length) }, () => null))
    : Array.from({ length: chunkCount }, () => null)
  const ready = opts.chunkHashesReady ?? (
    normalizedHashes.length === chunkCount &&
    normalizedHashes.every((value) => typeof value === 'string' && value.length > 0)
  )
  await (await db()).put(QUEUE_STORE, {
    id,
    entry,
    thumbnail,
    chunked: true,
    chunk_size: chunkSize,
    chunk_count: chunkCount,
    chunks: Array.from({ length: chunkCount }, () => null),
    chunkHashes: normalizedHashes,
    chunkHashesReady: Boolean(ready),
    // Chunk ciphertext mode: 2 = context-bound; absent = legacy. Chunks of a
    // row are always encrypted in one mode, so resume can never mix them.
    cryptoVersion: opts.cryptoVersion === 2 ? 2 : undefined,
    backgroundAttempts: BACKGROUND_ATTEMPT_LIMIT,
  })
  notifyQueueChanged()
}

export async function queueChunkedUpload(id, entry, thumbnail, chunks) {
  await (await db()).put(QUEUE_STORE, {
    id,
    entry,
    thumbnail,
    chunked: true,
    chunks,
    backgroundAttempts: BACKGROUND_ATTEMPT_LIMIT,
  })
  notifyQueueChanged()
}

/**
 * Merge one chunk receipt into a chunked row — atomically: one `readwrite` transaction covering the
 * get→merge→put, so two in-flight receipts can never race a lost update (U1).
 *
 * @param {string} id
 * @param {number} index — chunk index
 * @param {{ index: number, sha256: string, size: number }} receipt
 */
export async function markChunkUploaded(id, index, receipt) {
  const database = await db()
  const tx = database.transaction(QUEUE_STORE, 'readwrite')
  const row = await tx.store.get(id)
  if (!row) {
    // Row was cleared while its chunk was in flight — nothing to update.
    tx.store.delete(id)
    await tx.done
    return
  }
  const chunks = Array.from(row.chunks ?? [], (entry) => entry ?? null)
  chunks[index] = receipt
  await tx.store.put({ ...row, chunks })
  await tx.done
}

/**
 * Persist the PLAINTEXT sha256 of one chunk before the chunk upload starts,
 * so source re-selection can be verified strongly for chunk indexes that
 * never completed (U1). Same single readwrite transaction discipline.
 *
 * @param {string} id
 * @param {number} index
 * @param {string} hash — plaintext chunk sha256 hex
 */
export async function saveChunkPlaintextHash(id, index, hash) {
  const database = await db()
  const tx = database.transaction(QUEUE_STORE, 'readwrite')
  const row = await tx.store.get(id)
  if (!row) {
    tx.store.delete(id)
    await tx.done
    return
  }
  const chunkHashes = Array.from(row.chunkHashes ?? [], (entry) => entry ?? null)
  chunkHashes[index] = hash
  await tx.store.put({ ...row, chunkHashes })
  await tx.done
}

/**
 * Persist the receipt of a completed whole-file upload so background sync
 * does not re-PUT it and the in-RAM copy can be released (U4).
 * Signature matches the SW's markQueueItemUploaded contract: `uploaded` is
 * the raw receipt { sha256, size }.
 *
 * @param {string} id
 * @param {object} uploaded — { sha256, size } (parsed upload receipt)
 */
export async function markQueuedUploadUploaded(id, uploaded) {
  const database = await db()
  const tx = database.transaction(QUEUE_STORE, 'readwrite')
  const row = await tx.store.get(id)
  if (row) await tx.store.put({ ...row, uploaded })
  await tx.done
}

/**
 * Remove a completed upload from the queue.
 * @param {string} id
 */
export async function dequeueUpload(id) {
  await (await db()).delete(QUEUE_STORE, id)
  notifyQueueChanged()
}

/**
 * Return all pending uploads in the queue.
 * @returns {Promise<{ id: string, encryptedBytes: Uint8Array, entry: object }[]>}
 */
export async function getUploadQueue() {
  return (await db()).getAll(QUEUE_STORE)
}

export async function getQueuedUpload(id) {
  return (await db()).get(QUEUE_STORE, id)
}

export async function clearUploadQueue(ids) {
  const database = await db()
  const tx = database.transaction(QUEUE_STORE, 'readwrite')
  const targets = ids?.length ? ids : await tx.store.getAllKeys()
  await Promise.all([
    ...targets.map((id) => tx.store.delete(id)),
    tx.done,
  ])

  if (typeof navigator !== 'undefined') {
    navigator.serviceWorker?.controller?.postMessage({
      type: 'vault-cancel-uploads',
      ids: targets,
    })
  }

  notifyQueueChanged()
}

export async function registerUploadSync() {
  try {
    if (!('serviceWorker' in navigator)) return false
    const registration = await navigator.serviceWorker.ready
    if (!registration.sync) return false
    await registration.sync.register('vault-upload-queue')
    return true
  } catch {
    return false
  }
}
