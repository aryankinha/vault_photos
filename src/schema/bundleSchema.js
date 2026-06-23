const HEADER_BYTES = 4
const ID_BYTES = 16
const LENGTH_BYTES = 4
const ENTRY_HEADER_BYTES = ID_BYTES + LENGTH_BYTES
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function createEmptyBundle() {
  return serializeBundleEntries([])
}

export function parseBundle(buffer) {
  const bytes = toUint8Array(buffer)
  if (bytes.byteLength < HEADER_BYTES) {
    throw new Error('Bundle is too short')
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = view.getUint32(0, false)
  const entries = []
  let cursor = HEADER_BYTES

  for (let index = 0; index < count; index += 1) {
    if (cursor + ENTRY_HEADER_BYTES > bytes.byteLength) {
      throw new Error('Bundle entry header is truncated')
    }

    const idBytes = bytes.slice(cursor, cursor + ID_BYTES)
    const id = textDecoder.decode(idBytes)
    cursor += ID_BYTES

    const length = view.getUint32(cursor, false)
    cursor += LENGTH_BYTES

    if (cursor + length > bytes.byteLength) {
      throw new Error('Bundle thumbnail bytes are truncated')
    }

    entries.push({
      id,
      offset: cursor,
      length,
      bytes: bytes.slice(cursor, cursor + length),
    })
    cursor += length
  }

  if (cursor !== bytes.byteLength) {
    throw new Error('Bundle has trailing bytes')
  }

  return entries
}

export function serializeBundleEntries(entries) {
  const totalLength = HEADER_BYTES + entries.reduce((sum, entry) => {
    return sum + ENTRY_HEADER_BYTES + toUint8Array(entry.bytes).byteLength
  }, 0)
  const output = new Uint8Array(totalLength)
  const view = new DataView(output.buffer)

  view.setUint32(0, entries.length, false)
  let cursor = HEADER_BYTES

  for (const entry of entries) {
    if (!/^[0-9a-f]{16}$/i.test(entry.id)) {
      throw new Error('Bundle entry id must be a 16 character hex string')
    }

    const idBytes = textEncoder.encode(entry.id)
    if (idBytes.byteLength !== ID_BYTES) {
      throw new Error('Bundle entry id must encode to 16 bytes')
    }

    const thumbBytes = toUint8Array(entry.bytes)
    output.set(idBytes, cursor)
    cursor += ID_BYTES
    view.setUint32(cursor, thumbBytes.byteLength, false)
    cursor += LENGTH_BYTES
    output.set(thumbBytes, cursor)
    cursor += thumbBytes.byteLength
  }

  return output.buffer
}

export function appendBundleEntry(bundleBuffer, entry) {
  const entries = parseBundle(bundleBuffer)
  const nextOffset = bundleBuffer.byteLength + ENTRY_HEADER_BYTES
  const bytes = toUint8Array(entry.bytes)
  const nextEntries = [...entries, { id: entry.id, bytes }]

  return {
    bundle: serializeBundleEntries(nextEntries),
    thumb_offset: nextOffset,
    thumb_length: bytes.byteLength,
  }
}

function toUint8Array(buffer) {
  if (buffer instanceof Uint8Array) return buffer
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer)
  throw new Error('Expected ArrayBuffer or Uint8Array')
}
