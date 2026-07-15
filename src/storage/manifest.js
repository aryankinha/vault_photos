/**
 * Manifest storage. Handles fetch → decrypt → parse and serialize → encrypt →
 * upload round-trips against the worker. First-run creation is handled by the
 * atomic /initialize-vault route, so a missing manifest here is an integrity
 * error and is never silently converted into an empty vault.
 *
 * V3 adds gzip compression around the manifest JSON:
 *   save:  JSON.stringify → gzip (CompressionStream) → encryptPacked → upload
 *   load:  download → decryptPacked → decompress (try) → JSON.parse
 *            ↳ if decompress throws (old V1/V2 manifest) → raw UTF-8 decode
 *
 * Browsers without CompressionStream write the backward-compatible plain JSON
 * form. A gzip manifest requires DecompressionStream support to open.
 */
import { decryptPacked } from '../crypto/decrypt'
import { encryptPacked } from '../crypto/encrypt'
import { getActiveKey } from '../crypto/keyDerivation'
import { encodeManifest, parseManifestBytes } from './manifestCodec'
import * as worker from './workerClient'

// ---------------------------------------------------------------------------
// Public API — signatures unchanged
// ---------------------------------------------------------------------------

export async function loadManifest() {
  const buffer = await worker.getManifest()
  const decrypted = await decryptPacked(buffer, getActiveKey())
  return parseManifestBytes(decrypted)
}

export async function saveManifest(manifest) {
  const compressed = await encodeManifest(manifest)
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
  const compressed = await encodeManifest(manifest)
  return new Uint8Array(compressed)
}

export { parseManifestBytes } from './manifestCodec'
