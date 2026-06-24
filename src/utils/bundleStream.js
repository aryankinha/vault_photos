/**
 * bundleStream.js — Progressive bundle parser.
 *
 * Parses a decrypted bundle buffer (same binary layout as bundleSchema.js) and
 * yields entries one at a time so callers can hydrate thumbnails in batches
 * without waiting for the whole bundle to be parsed.
 *
 * Binary layout (matches bundleSchema.js exactly — NEVER modify this):
 *   [4 bytes]  uint32 big-endian — entry count N
 *   per entry:
 *     [16 bytes] file id as UTF-8 hex ASCII
 *     [4 bytes]  uint32 big-endian — thumbnail byte length L
 *     [L bytes]  raw JPEG bytes
 *
 * Usage:
 *   for (const entry of streamBundleEntries(decryptedBuffer)) {
 *     thumbMap.set(entry.id, new Blob([entry.bytes], { type: 'image/jpeg' }))
 *   }
 */

const HEADER_BYTES = 4
const ID_BYTES = 16
const LENGTH_BYTES = 4
const textDecoder = new TextDecoder()

/**
 * Generator: yields `{ id: string, bytes: Uint8Array }` for each bundle entry.
 *
 * @param {ArrayBuffer|Uint8Array} buffer — decrypted bundle binary
 * @yields {{ id: string, bytes: Uint8Array }}
 */
export function* streamBundleEntries(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)

  if (bytes.byteLength < HEADER_BYTES) return // empty / corrupt — yield nothing

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = view.getUint32(0, false)
  let cursor = HEADER_BYTES

  for (let i = 0; i < count; i++) {
    if (cursor + ID_BYTES + LENGTH_BYTES > bytes.byteLength) break // truncated

    const id = textDecoder.decode(bytes.slice(cursor, cursor + ID_BYTES))
    cursor += ID_BYTES

    const length = view.getUint32(cursor, false)
    cursor += LENGTH_BYTES

    if (cursor + length > bytes.byteLength) break // truncated thumbnail

    const thumbBytes = bytes.slice(cursor, cursor + length)
    cursor += length

    yield { id, bytes: thumbBytes }
  }
}

/**
 * Parse all entries from a bundle buffer into a Map<id, Blob>.
 * Thin wrapper around streamBundleEntries for callers that want everything.
 *
 * @param {ArrayBuffer|Uint8Array} buffer — decrypted bundle binary
 * @returns {Map<string, Blob>}
 */
export function bundleToThumbMap(buffer) {
  const map = new Map()
  for (const entry of streamBundleEntries(buffer)) {
    map.set(entry.id, new Blob([entry.bytes], { type: 'image/jpeg' }))
  }
  return map
}
