import { bytes, concat, fromHex, lengthPrefixed, uint32, uint64, utf8 } from './binary.js'

export const PURPOSES = Object.freeze(['file', 'chunk', 'manifest', 'bundle', 'cache'])
export const V2_CHUNK_SIZE = 8 * 1024 * 1024

export function encodeObjectContext(context) {
  if (!context || !PURPOSES.includes(context.kind)) throw new Error('Invalid object context')
  const vault = fromHex(context.vaultId, 16)
  const requiresId = ['file', 'chunk', 'cache'].includes(context.kind)
  const requiresIndex = ['chunk', 'bundle'].includes(context.kind)
  const id = requiresId ? fromHex(context.id, 8) : new Uint8Array()
  const index = requiresIndex ? uint64(context.index) : new Uint8Array()
  if ((!requiresId && context.id !== undefined) || (!requiresIndex && context.index !== undefined)) throw new Error('Unexpected context field')
  if (context.kind === 'chunk') uint32(context.index)
  if (Object.keys(context).some((name) => !['vaultId', 'kind', 'id', 'index'].includes(name))) throw new Error('Unknown context field')
  return lengthPrefixed(utf8('VPC3'), vault, utf8(context.kind), id, index)
}

export async function derivePurposeKeys(root, vaultId) {
  const salt = fromHex(vaultId, 16)
  if (root?.algorithm?.name !== 'HKDF' || root.extractable !== false) throw new Error('Invalid master key')
  const result = {}
  for (const purpose of PURPOSES) {
    // deriveKey imports AES internally: no raw subkey appears in JS memory.
    result[purpose] = await crypto.subtle.deriveKey({
      name: 'HKDF', hash: 'SHA-256', salt, info: utf8(`VPK2/key/${purpose}`),
    }, root, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  }
  return Object.freeze(result)
}

function checkKey(key) {
  if (key?.algorithm?.name !== 'AES-GCM' || key.extractable !== false) throw new Error('Invalid object key')
}

/** V2 objects always authenticate VPC3; these functions have no legacy mode. */
export async function encryptObject(plaintext, key, context) {
  checkKey(key)
  const aad = encodeObjectContext(context)
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM', iv: nonce, tagLength: 128, additionalData: aad,
  }, key, bytes(plaintext)))
  return concat(nonce, encrypted).buffer
}

export async function decryptObject(packed, key, context) {
  checkKey(key)
  const aad = encodeObjectContext(context)
  const input = bytes(packed)
  if (input.length < 28) throw new Error('Invalid encrypted object')
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: input.subarray(0, 12),
    tagLength: 128, additionalData: aad }, key, input.subarray(12))
}

export async function encryptObjectChunk(plaintext, key, context) {
  if (context?.kind !== 'chunk') throw new Error('Chunk context required')
  return concat(uint32(context.index), new Uint8Array(await encryptObject(plaintext, key, context))).buffer
}

export async function decryptObjectChunk(packed, key, context) {
  const input = bytes(packed)
  if (context?.kind !== 'chunk' || input.length < 32) throw new Error('Invalid encrypted chunk')
  uint32(context.index)
  if (new DataView(input.buffer, input.byteOffset, 4).getUint32(0, false) !== context.index) throw new Error('Invalid encrypted chunk')
  return decryptObject(input.subarray(4), key, context)
}
