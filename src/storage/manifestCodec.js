import { parseManifest, serializeManifest } from '../schema/manifestSchema.js'

export async function encodeManifest(manifest) {
  const bytes = new TextEncoder().encode(serializeManifest(manifest))
  if (typeof CompressionStream === 'undefined') return bytes.buffer

  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new CompressionStream('gzip'))
  return new Response(stream).arrayBuffer()
}

export async function parseManifestBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const isGzipped = bytes[0] === 0x1f && bytes[1] === 0x8b

  if (!isGzipped) {
    return parseManifest(new TextDecoder().decode(bytes))
  }
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress the vault manifest')
  }

  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
  return parseManifest(await new Response(stream).text())
}
