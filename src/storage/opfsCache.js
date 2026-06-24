/**
 * opfsCache.js — Origin Private File System cache for decrypted vault data.
 *
 * OPFS is a browser-native private file system that provides:
 *   - Significantly faster reads/writes for large binary blobs vs. IndexedDB
 *   - No practical storage size limit (vs. IDB quota)
 *   - Byte-level file access without serialisation overhead
 *   - Origin isolation (completely private to this app)
 *
 * Security: stores DECRYPTED bytes — same security level as the IDB cache.
 * The AES key is NEVER stored here. All files are wiped on vault lock
 * (clearOpfsBundle is called from cache.clearCache).
 *
 * Availability: Chrome 86+, Firefox 111+, Safari 15.2+.
 * Falls back gracefully to returning null / no-op on unsupported browsers.
 *
 * File layout (all under the OPFS root):
 *   thumbs.bundle.dec   — decrypted bundle binary (all thumbnails concatenated)
 */

const BUNDLE_FILENAME = 'thumbs.bundle.dec'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Return the OPFS root DirectoryHandle, or null if unsupported / denied.
 * Result is NOT cached — each call to the public API gets a fresh handle.
 * (getDirectory() is synchronous after the first call on most implementations.)
 *
 * @returns {Promise<FileSystemDirectoryHandle|null>}
 */
async function getRoot() {
  try {
    if (typeof navigator === 'undefined') return null
    if (typeof navigator.storage?.getDirectory !== 'function') return null
    return await navigator.storage.getDirectory()
  } catch {
    // Permission denied, private-mode Firefox, or unsupported — silent fail.
    return null
  }
}

/**
 * Normalise input to an ArrayBuffer ready to write.
 * Handles both ArrayBuffer and Uint8Array (including non-zero-offset views).
 *
 * @param {ArrayBuffer|Uint8Array} bytes
 * @returns {ArrayBuffer}
 */
function toArrayBuffer(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes
  // Uint8Array with non-zero byteOffset needs a slice to get a clean buffer.
  if (bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  }
  return bytes.buffer
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the decrypted bundle from OPFS.
 *
 * @returns {Promise<ArrayBuffer|null>} — bundle bytes, or null on miss/error
 */
export async function getOpfsBundle() {
  const root = await getRoot()
  if (!root) return null
  try {
    const fh = await root.getFileHandle(BUNDLE_FILENAME)
    const file = await fh.getFile()
    return await file.arrayBuffer()
  } catch {
    // File not found (first run) or read error — treated as cache miss.
    return null
  }
}

/**
 * Write decrypted bundle bytes to OPFS.
 *
 * @param {ArrayBuffer|Uint8Array} bytes
 * @returns {Promise<boolean>} — true if write succeeded, false otherwise
 */
export async function setOpfsBundle(bytes) {
  const root = await getRoot()
  if (!root) return false
  let writable = null
  try {
    const fh = await root.getFileHandle(BUNDLE_FILENAME, { create: true })
    writable = await fh.createWritable()
    await writable.write(toArrayBuffer(bytes))
    await writable.close()
    writable = null // already closed
    return true
  } catch {
    // Close without committing if write failed mid-way.
    if (writable) {
      try { await writable.abort() } catch { /* ignore */ }
    }
    return false
  }
}

/**
 * Delete the bundle file from OPFS (called on vault lock).
 *
 * @returns {Promise<void>}
 */
export async function clearOpfsBundle() {
  const root = await getRoot()
  if (!root) return
  try {
    await root.removeEntry(BUNDLE_FILENAME)
  } catch {
    // File may not exist yet — not an error.
  }
}

/**
 * Returns true if OPFS is available in the current browser/context.
 * Useful for UI feature detection without actually reading files.
 *
 * @returns {boolean}
 */
export function isOpfsSupported() {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function'
  )
}
