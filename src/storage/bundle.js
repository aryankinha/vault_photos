/**
 * Thumbnail bundle storage. The bundle is one encrypted blob containing all
 * thumbnails concatenated with a small binary header (see bundleSchema). Adding
 * a thumbnail means: download, decrypt, parse, compute the new entry's offset,
 * append, re-serialize, re-encrypt, re-upload. A missing bundle (first run)
 * behaves as an empty bundle.
 *
 * V3 adds page-level functions for paginated bundles. Existing single-bundle
 * functions are unchanged — old vaults continue to use them.
 */
import { decryptPacked } from '../crypto/decrypt'
import { encryptPacked } from '../crypto/encrypt'
import { getActiveKey } from '../crypto/keyDerivation'
import {
  appendBundleEntry,
  createEmptyBundle,
  parseBundle,
  parseBundlePage,
  serializeBundlePage,
} from '../schema/bundleSchema'
import * as worker from './workerClient'

// ---------------------------------------------------------------------------
// Existing exports — UNCHANGED
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// V3 — Paginated bundle page functions (added alongside existing exports)
// ---------------------------------------------------------------------------

/**
 * Fetch and decrypt a single bundle page by index.
 * Returns an array of BundleEntry objects (same shape as loadBundle()).
 * Returns an empty array when the page does not exist yet (HTTP 404) —
 * this is the normal state for old single-bundle vaults or pages not yet written.
 *
 * @param {number} pageIndex — zero-based page index
 * @returns {Promise<{ id: string, offset: number, length: number, bytes: Uint8Array }[]>}
 */
export async function loadBundlePage(pageIndex) {
  let buffer
  try {
    buffer = await worker.getBundlePage(pageIndex)
  } catch (error) {
    if (error.status === 404) return []
    throw error
  }

  const decrypted = await decryptPacked(buffer, getActiveKey())
  return parseBundlePage(decrypted)
}

/**
 * Serialize, encrypt, and upload a bundle page.
 *
 * @param {number} pageIndex — zero-based page index
 * @param {{ id: string, bytes: Uint8Array | ArrayBuffer }[]} entries — thumbnail entries for this page
 */
export async function saveBundlePage(pageIndex, entries) {
  const buffer = serializeBundlePage(entries)
  const encrypted = await encryptPacked(buffer, getActiveKey())
  await worker.uploadBundlePage(pageIndex, encrypted)
}

/**
 * Append a thumbnail to a specific bundle page and re-upload it.
 * Returns { thumb_offset, thumb_length } within the page's binary layout
 * for storage in the manifest entry's page_index + thumb_offset fields.
 *
 * @param {string} id — 16-hex media entry id
 * @param {Uint8Array} thumbBytes — decrypted JPEG thumbnail bytes
 * @param {number} pageIndex — which page to append to
 * @returns {Promise<{ thumb_offset: number, thumb_length: number }>}
 */
export async function appendThumbToPage(id, thumbBytes, pageIndex) {
  // Load existing entries for this page (empty if page doesn't exist yet).
  const existingEntries = await loadBundlePage(pageIndex)

  // Append the new entry to the page's entry list.
  const bytes = thumbBytes instanceof Uint8Array ? thumbBytes : new Uint8Array(thumbBytes)
  const newEntries = [...existingEntries, { id, bytes }]

  // Compute offset/length within the new page binary.
  // Offset = bytes consumed by existing entries + header (4 bytes) +
  //           N × (16-byte id + 4-byte length) for all entries before this one.
  const HEADER = 4
  const ENTRY_HEADER = 16 + 4  // id + length
  const thumb_offset = HEADER
    + existingEntries.reduce((acc, e) => acc + ENTRY_HEADER + e.bytes.byteLength, 0)
    + ENTRY_HEADER
  const thumb_length = bytes.byteLength

  // Serialize all entries (reuse serializeBundlePage — same binary format).
  const pageBuffer = serializeBundlePage(newEntries.map((e) => ({
    id: e.id,
    bytes: e.bytes instanceof Uint8Array ? e.bytes : new Uint8Array(e.bytes),
  })))

  // Encrypt and upload.
  const encrypted = await encryptPacked(pageBuffer, getActiveKey())
  await worker.uploadBundlePage(pageIndex, encrypted)

  return { thumb_offset, thumb_length }
}

