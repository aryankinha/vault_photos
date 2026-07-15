/**
 * Origin Private File System caches.
 *
 * The thumbnail bundle cache is decrypted session data and is cleared on lock
 * and at application startup. Full-resolution files are persisted only in
 * their encrypted HF wire format under files/<id>.enc, then decrypted with the
 * in-RAM key on each read.
 */

import { decryptPacked } from '../crypto/decrypt'

const BUNDLE_FILENAME = 'thumbs.bundle.dec'
const FILES_DIR = 'files'
const LEGACY_PLAINTEXT_DIR = 'media'
const MEDIA_ID_PATTERN = /^[0-9a-f]{16}$/i

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

export async function getOpfsBundle() {
  const root = await getRoot()
  if (!root) return null
  try {
    const handle = await root.getFileHandle(BUNDLE_FILENAME)
    return (await handle.getFile()).arrayBuffer()
  } catch {
    return null
  }
}

export async function setOpfsBundle(bytes) {
  const root = await getRoot()
  if (!root) return false
  let writable
  try {
    const handle = await root.getFileHandle(BUNDLE_FILENAME, { create: true })
    writable = await handle.createWritable()
    await writable.write(toArrayBuffer(bytes))
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
 */
export async function getCachedFile(id, key) {
  validateId(id)
  const root = await getRoot()
  if (!root) return null

  try {
    const directory = await root.getDirectoryHandle(FILES_DIR)
    const handle = await directory.getFileHandle(`${id}.enc`)
    const encrypted = await (await handle.getFile()).arrayBuffer()
    return decryptPacked(encrypted, key)
  } catch (error) {
    if (error?.name === 'NotFoundError') return null
    throw error
  }
}

export async function setCachedFile(id, encryptedBytes) {
  validateId(id)
  const root = await getRoot()
  if (!root) return false
  let writable

  try {
    const directory = await root.getDirectoryHandle(FILES_DIR, { create: true })
    const handle = await directory.getFileHandle(`${id}.enc`, { create: true })
    writable = await handle.createWritable()
    await writable.write(toArrayBuffer(encryptedBytes))
    await writable.close()
    return true
  } catch {
    try { await writable?.abort() } catch { /* best effort */ }
    return false
  }
}

export async function deleteCachedFile(id) {
  validateId(id)
  const root = await getRoot()
  if (!root) return
  try {
    const directory = await root.getDirectoryHandle(FILES_DIR)
    await directory.removeEntry(`${id}.enc`)
  } catch { /* cache miss */ }
}

export async function clearOPFSCache() {
  const root = await getRoot()
  if (!root) return
  try {
    await root.removeEntry(FILES_DIR, { recursive: true })
  } catch { /* cache already empty */ }
}

export async function getOPFSCacheStats() {
  const root = await getRoot()
  if (!root) return { count: 0, totalBytes: 0 }

  try {
    const directory = await root.getDirectoryHandle(FILES_DIR)
    let count = 0
    let totalBytes = 0
    for await (const [, handle] of directory.entries()) {
      if (handle.kind !== 'file') continue
      const file = await handle.getFile()
      count += 1
      totalBytes += file.size
    }
    return { count, totalBytes }
  } catch {
    return { count: 0, totalBytes: 0 }
  }
}
