/**
 * Origin Private File System caches.
 *
 * The thumbnail bundle cache is decrypted session data and is cleared on lock
 * and at application startup. Full-resolution files are persisted only in
 * their encrypted HF wire format under files/<id>.enc, then decrypted with the
 * in-RAM key on each read.
 *
 * V4 adds:
 *   - LRU byte cap: the files/ directory is bounded by OPFS_BYTE_CAP bytes.
 *     When the cap is exceeded, least-recently-accessed entries are evicted.
 *   - Last-access metadata: every read updates the access timestamp so LRU
 *     eviction reflects actual usage, not just insertion order.
 *   - Quota awareness: getOPFSQuotaStatus() exposes navigator.storage.estimate
 *     data so the UI can warn when the origin is near its storage quota.
 *   - Optional bundle encryption: setOpfsBundle/getOpfsBundle accept an optional
 *     CryptoKey. When provided, the decrypted bundle bytes are encrypted before
     being written to OPFS, eliminating plaintext persistence of decrypted
     thumbnails on disk.
 */

import { decryptPacked } from '../crypto/decrypt.js'
import { encryptPacked } from '../crypto/encrypt.js'

const BUNDLE_FILENAME = 'thumbs.bundle.dec'
const FILES_DIR = 'files'
const METADATA_FILENAME = '.cache_metadata.json'
const LEGACY_PLAINTEXT_DIR = 'media'
const MEDIA_ID_PATTERN = /^[0-9a-f]{16}$/i

// Maximum total bytes for the files/ directory. 500 MB is well under typical
// origin quotas (60% of available disk) while still allowing a large gallery
// of full-resolution media to be cached.
const OPFS_BYTE_CAP = 500 * 1024 * 1024  // 500 MB

let legacyCleanupPromise = null

async function getRoot() {
  try {
    if (typeof navigator === 'undefined') return null
    if (typeof navigator.storage?.getDirectory !== 'function') return null
    const root = await navigator.storage.getDirectory()

    // Earlier V3 builds wrote plaintext media/<id>.dec files. Remove that
    // directory once per page lifetime before exposing the corrected cache.
    if (!legacyCleanupPromise) {
      legacyCleanupPromise = root
        .removeEntry(LEGACY_PLAINTEXT_DIR, { recursive: true })
        .catch(() => {})
    }
    await legacyCleanupPromise
    return root
  } catch {
    return null
  }
}

function validateId(id) {
  if (!MEDIA_ID_PATTERN.test(id)) throw new Error('Invalid media id')
}

function toArrayBuffer(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes
  if (ArrayBuffer.isView(bytes)) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  }
  throw new TypeError('Expected an ArrayBuffer or typed array')
}

// ---------------------------------------------------------------------------
// Metadata — tracks size and last-access time for each cached file.
// Stored as a JSON file inside OPFS so it survives across sessions.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CacheMetadata
 * @property {number} size — file size in bytes
 * @property {number} lastAccess — Unix epoch ms of last read
 */

/** @type {Map<string, CacheMetadata>|null} */
let metadataCache = null

async function getMetadata() {
  if (metadataCache) return metadataCache
  metadataCache = new Map()
  const root = await getRoot()
  if (!root) return metadataCache
  try {
    const handle = await root.getFileHandle(METADATA_FILENAME)
    const text = await (await handle.getFile()).text()
    const parsed = JSON.parse(text)
    for (const [id, info] of Object.entries(parsed)) {
      if (info && typeof info.size === 'number' && typeof info.lastAccess === 'number') {
        metadataCache.set(id, info)
      }
    }
  } catch {
    // Metadata file missing or corrupt — start fresh.
  }
  return metadataCache
}

async function setMetadata(metadata) {
  const root = await getRoot()
  if (!root) return false
  let writable
  try {
    const handle = await root.getFileHandle(METADATA_FILENAME, { create: true })
    writable = await handle.createWritable()
    const obj = {}
    for (const [id, info] of metadata) {
      obj[id] = info
    }
    await writable.write(JSON.stringify(obj))
    await writable.close()
    return true
  } catch {
    try { await writable?.abort() } catch { /* best effort */ }
    return false
  }
}

/**
 * Persist metadata after a mutation. Best-effort — never throws.
 */
async function persistMetadata(metadata) {
  try {
    await setMetadata(metadata)
  } catch {
    // Non-fatal.
  }
}

/**
 * Compute the total bytes used by the files/ directory.
 */
function computeTotalBytes(metadata) {
  let total = 0
  for (const info of metadata.values()) {
    total += info.size || 0
  }
  return total
}

/**
 * Evict least-recently-accessed files until the total bytes fit within
 * OPFS_BYTE_CAP. Returns the ids that were evicted.
 */
async function enforceByteCap(metadata) {
  const evicted = []
  let totalBytes = computeTotalBytes(metadata)
  if (totalBytes <= OPFS_BYTE_CAP) return evicted

  // Sort by lastAccess ascending (oldest first).
  const sorted = [...metadata.entries()].sort(
    ([, a], [, b]) => (a.lastAccess || 0) - (b.lastAccess || 0),
  )

  for (const [id] of sorted) {
    if (totalBytes <= OPFS_BYTE_CAP) break
    const info = metadata.get(id)
    if (!info) continue
    try {
      const root = await getRoot()
      if (!root) break
      const directory = await root.getDirectoryHandle(FILES_DIR)
      await directory.removeEntry(`${id}.enc`)
    } catch {
      // File might already be gone — continue eviction.
    }
    totalBytes -= info.size || 0
    metadata.delete(id)
    evicted.push(id)
  }

  await persistMetadata(metadata)
  return evicted
}

// ---------------------------------------------------------------------------
// Bundle cache
// ---------------------------------------------------------------------------

/**
 * Read the encrypted thumbnail bundle from OPFS.
 *
 * @param {CryptoKey} [key] — optional AES-GCM key. When provided, the stored
 *   bytes are decrypted (they were encrypted with the same key at write time).
 *   When omitted, the raw bytes are returned (legacy plaintext format).
 * @returns {Promise<ArrayBuffer|null>}
 */
export async function getOpfsBundle(key) {
  const root = await getRoot()
  if (!root) return null
  try {
    const handle = await root.getFileHandle(BUNDLE_FILENAME)
    const encrypted = await (await handle.getFile()).arrayBuffer()
    if (key) {
      const decrypted = await decryptPacked(encrypted, key)
      return decrypted instanceof ArrayBuffer
        ? decrypted
        : decrypted.buffer.slice(decrypted.byteOffset, decrypted.byteOffset + decrypted.byteLength)
    }
    return encrypted
  } catch {
    return null
  }
}

/**
 * Write the thumbnail bundle to OPFS.
 *
 * @param {ArrayBuffer|Uint8Array} bytes — decrypted bundle bytes
 * @param {CryptoKey} [key] — optional AES-GCM key. When provided, the bytes are
 *   encrypted before writing so decrypted thumbnails never touch disk in
 *   plaintext. When omitted, the bytes are written as-is (legacy behavior).
 * @returns {Promise<boolean>}
 */
export async function setOpfsBundle(bytes, key) {
  const root = await getRoot()
  if (!root) return false
  let writable
  try {
    const handle = await root.getFileHandle(BUNDLE_FILENAME, { create: true })
    writable = await handle.createWritable()
    const data = key
      ? new Uint8Array(await encryptPacked(toArrayBuffer(bytes), key))
      : toArrayBuffer(bytes)
    await writable.write(data)
    await writable.close()
    return true
  } catch {
    try { await writable?.abort() } catch { /* best effort */ }
    return false
  }
}

export async function clearOpfsBundle() {
  const root = await getRoot()
  if (!root) return
  try { await root.removeEntry(BUNDLE_FILENAME) } catch { /* cache miss */ }
}

// ---------------------------------------------------------------------------
// Full-resolution file cache (encrypted at rest)
// ---------------------------------------------------------------------------

export async function isOPFSSupported() {
  return Boolean(await getRoot())
}

export function isOpfsSupported() {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function'
  )
}

/**
 * Return decrypted bytes from an encrypted OPFS cache entry, or null on miss.
 * Authentication failures are allowed to throw so callers can discard the
 * corrupt entry and retry the trusted network copy.
 *
 * Updates the file's last-access timestamp in the metadata store.
 *
 * @param {string} id — 16-hex media entry id
 * @param {CryptoKey} key — AES-GCM decryption key
 * @returns {Promise<Uint8Array|null>}
 */
export async function getCachedFile(id, key) {
  validateId(id)
  const root = await getRoot()
  if (!root) return null

  try {
    const directory = await root.getDirectoryHandle(FILES_DIR)
    const handle = await directory.getFileHandle(`${id}.enc`)
    const encrypted = await (await handle.getFile()).arrayBuffer()
    const decrypted = await decryptPacked(encrypted, key)

    // Update last-access timestamp for LRU tracking.
    const metadata = await getMetadata()
    if (metadata.has(id)) {
      metadata.get(id).lastAccess = Date.now()
      await persistMetadata(metadata)
    }

    return decrypted
  } catch (error) {
    if (error?.name === 'NotFoundError') return null
    throw error
  }
}

/**
 * Persist an encrypted media file to the OPFS cache.
 *
 * Updates the metadata store and enforces the LRU byte cap.
 *
 * @param {string} id — 16-hex media entry id
 * @param {ArrayBuffer|Uint8Array} encryptedBytes — encrypted file bytes
 * @returns {Promise<boolean>}
 */
export async function setCachedFile(id, encryptedBytes) {
  validateId(id)
  const root = await getRoot()
  if (!root) return false
  let writable

  try {
    const directory = await root.getDirectoryHandle(FILES_DIR, { create: true })
    const handle = await directory.getFileHandle(`${id}.enc`, { create: true })
    writable = await handle.createWritable()
    const data = toArrayBuffer(encryptedBytes)
    await writable.write(data)
    await writable.close()

    // Update metadata and enforce byte cap.
    const metadata = await getMetadata()
    metadata.set(id, { size: data.byteLength, lastAccess: Date.now() })
    await enforceByteCap(metadata)

    return true
  } catch {
    try { await writable?.abort() } catch { /* best effort */ }
    return false
  }
}

/**
 * Remove a single encrypted file from the OPFS cache.
 * @param {string} id — 16-hex media entry id
 */
export async function deleteCachedFile(id) {
  validateId(id)
  const root = await getRoot()
  if (!root) return
  try {
    const directory = await root.getDirectoryHandle(FILES_DIR)
    await directory.removeEntry(`${id}.enc`)
  } catch { /* cache miss */ }

  const metadata = await getMetadata()
  if (metadata.has(id)) {
    metadata.delete(id)
    await persistMetadata(metadata)
  }
}

/**
 * Clear all encrypted files from the OPFS cache.
 * Also clears the metadata store.
 */
export async function clearOPFSCache() {
  const root = await getRoot()
  if (!root) return
  try {
    await root.removeEntry(FILES_DIR, { recursive: true })
  } catch { /* cache already empty */ }

  metadataCache = new Map()
  await persistMetadata(metadataCache)
}

/**
 * Return stats about the OPFS file cache.
 * @returns {Promise<{ count: number, totalBytes: number }>}
 */
export async function getOPFSCacheStats() {
  const metadata = await getMetadata()
  return {
    count: metadata.size,
    totalBytes: computeTotalBytes(metadata),
  }
}

/**
 * Return storage quota information for the origin.
 * Uses navigator.storage.estimate() when available.
 *
 * @returns {Promise<{ usage: number, quota: number, percentUsed: number }>}
 */
export async function getOPFSQuotaStatus() {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
      return { usage: 0, quota: 0, percentUsed: 0 }
    }
    const estimate = await navigator.storage.estimate()
    const usage = estimate.usage || 0
    const quota = estimate.quota || 0
    const percentUsed = quota > 0 ? usage / quota : 0
    return { usage, quota, percentUsed }
  } catch {
    return { usage: 0, quota: 0, percentUsed: 0 }
  }
}

/**
 * Invalidate the in-memory metadata cache. Called after external modifications
 * to the OPFS directory (e.g., after a legacy cleanup) to force a re-read.
 */
export function invalidateMetadataCache() {
  metadataCache = null
}
