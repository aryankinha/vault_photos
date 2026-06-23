/**
 * Thumbnail bundle storage. The bundle is one encrypted blob containing all
 * thumbnails concatenated with a small binary header (see bundleSchema). Adding
 * a thumbnail means: download, decrypt, parse, compute the new entry's offset,
 * append, re-serialize, re-encrypt, re-upload. A missing bundle (first run)
 * behaves as an empty bundle.
 */
import { decryptPacked } from '../crypto/decrypt'
import { encryptPacked } from '../crypto/encrypt'
import { getActiveKey } from '../crypto/keyDerivation'
import {
  appendBundleEntry,
  createEmptyBundle,
  parseBundle,
} from '../schema/bundleSchema'
import * as worker from './workerClient'

export async function loadBundle() {
  let buffer
  try {
    buffer = await worker.getBundle()
  } catch (error) {
    if (error.status === 404) return []
    throw error
  }

  const decrypted = await decryptPacked(buffer, getActiveKey())
  return parseBundle(decrypted)
}

export async function saveBundle(bundleBuffer) {
  const encrypted = await encryptPacked(bundleBuffer, getActiveKey())
  await worker.uploadBundle(encrypted)
}

/**
 * Append a thumbnail for the given id and persist the whole bundle. Returns the
 * { thumb_offset, thumb_length } the caller should store on the manifest entry.
 */
export async function appendThumb(id, thumbBytes) {
  const bundleBuffer = await loadRawBundleBuffer()
  const entry = { id, bytes: thumbBytes }
  const result = appendBundleEntry(bundleBuffer, entry)
  await saveBundle(result.bundle)
  return { thumb_offset: result.thumb_offset, thumb_length: result.thumb_length }
}

/**
 * Decode the current bundle into a Map<id, Blob> keyed by file id.
 */
export async function loadThumbMap() {
  const entries = await loadBundle()
  const map = new Map()
  for (const entry of entries) {
    map.set(entry.id, new Blob([entry.bytes], { type: 'image/jpeg' }))
  }
  return map
}

/**
 * Fetch + decrypt the raw bundle buffer, or an empty bundle on first run. Kept
 * separate from loadBundle() so appendThumb() can preserve byte offsets without
 * re-parsing/re-serializing through the entry list.
 */
async function loadRawBundleBuffer() {
  try {
    const buffer = await worker.getBundle()
    return await decryptPacked(buffer, getActiveKey())
  } catch (error) {
    if (error.status === 404) return createEmptyBundle()
    throw error
  }
}
