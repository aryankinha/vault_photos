/**
 * Manifest storage. Handles fetch → decrypt → parse and serialize → encrypt →
 * upload round-trips against the worker. A missing manifest (HTTP 404 on first
 * run) returns an empty manifest instead of throwing, so the gallery can render
 * an empty state on a brand-new vault.
 *
 * V3 adds gzip compression around the manifest JSON:
 *   save:  JSON.stringify → gzip (CompressionStream) → encryptPacked → upload
 *   load:  download → decryptPacked → decompress (try) → JSON.parse
 *            ↳ if decompress throws (old V1/V2 manifest) → raw UTF-8 decode
 *
 * A 3000-entry manifest shrinks from ~3 MB of raw JSON to ~180 KB gzipped,
 * saving bandwidth and decrypt time on every vault open.
 *
 * Availability: CompressionStream / DecompressionStream are available in all
 * modern browsers (Chrome 80+, Firefox 113+, Safari 16.4+).
 */
import { decryptPacked } from '../crypto/decrypt'
import { encryptPacked } from '../crypto/encrypt'
import { getActiveKey } from '../crypto/keyDerivation'
import {
  createEmptyManifest,
  parseManifest,
  serializeManifest,
} from '../schema/manifestSchema'
import * as worker from './workerClient'

// ---------------------------------------------------------------------------
// Public API — signatures unchanged
// ---------------------------------------------------------------------------

export async function loadManifest() {
  let buffer
  try {
    buffer = await worker.getManifest()
  } catch (error) {
    if (error.status === 404) return createEmptyManifest()
    throw error
  }

  const decrypted = await decryptPacked(buffer, getActiveKey())
  return parseManifestBytes(decrypted)
}

export async function saveManifest(manifest) {
  const text = serializeManifest(manifest)
  const compressed = await compress(text)
  const encrypted = await encryptPacked(compressed, getActiveKey())
  await worker.uploadManifest(encrypted)
}

/**
 * Append a new media entry and persist. Returns the updated manifest. The
 * caller is responsible for computing thumb_offset/thumb_length before calling.
 */
export async function addEntry(entry) {
  const manifest = await loadManifest()
  manifest.files.push(entry)
  manifest.updated_at = new Date().toISOString()
  await saveManifest(manifest)
  return manifest
}

/**
 * Serialize and compress a manifest to bytes — for callers that encrypt and
 * upload the manifest themselves (e.g., uploadService batch commit path).
 *
 * @param {object} manifest
 * @returns {Promise<Uint8Array>} — gzip-compressed JSON bytes ready to encrypt
 */
export async function serializeManifestCompressed(manifest) {
  const text = serializeManifest(manifest)
  const compressed = await compress(text)
  return new Uint8Array(compressed)
}

// ---------------------------------------------------------------------------
// Internal — compression helpers
// ---------------------------------------------------------------------------

/**
 * Gzip-compress a string into an ArrayBuffer.
 * Uses the native CompressionStream API — no library, zero bundle overhead.
 *
 * @param {string} str
 * @returns {Promise<ArrayBuffer>}
 */
async function compress(str) {
  const bytes = new TextEncoder().encode(str)
  const cs = new CompressionStream('gzip')
  const writer = cs.writable.getWriter()
  writer.write(bytes)
  writer.close()
  return collectStream(cs.readable)
}

/**
 * Decompress a gzip ArrayBuffer/Uint8Array to a string.
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Promise<string>}
 */
async function decompress(buffer) {
  const ds = new DecompressionStream('gzip')
  const writer = ds.writable.getWriter()
  writer.write(buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer)
  writer.close()
  const decompressed = await collectStream(ds.readable)
  return new TextDecoder().decode(decompressed)
}

/**
 * Collect all chunks from a ReadableStream into a single ArrayBuffer.
 *
 * @param {ReadableStream<Uint8Array>} readable
 * @returns {Promise<ArrayBuffer>}
 */
async function collectStream(readable) {
  const reader = readable.getReader()
  const chunks = []
  let totalLength = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    totalLength += value.byteLength
  }

  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result.buffer
}

/**
 * Parse decrypted manifest bytes.
 * Attempts gzip decompression first (V3+ manifests).
 * Falls back to raw UTF-8 decode (V1/V2 uncompressed manifests).
 *
 * @param {ArrayBuffer} decrypted
 * @returns {object} parsed manifest
 */
async function parseManifestBytes(decrypted) {
  // V3+ path: attempt gzip decompression.
  try {
    const text = await decompress(decrypted)
    return parseManifest(text)
  } catch {
    // Decompression failed — not a gzip stream (old V1/V2 manifest).
    // Fall back to raw UTF-8 JSON.
    const text = new TextDecoder().decode(decrypted)
    return parseManifest(text)
  }
}

