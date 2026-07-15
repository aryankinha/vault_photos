/**
 * Chunked AES-256-GCM with the big-endian chunk index authenticated as AAD.
 * New chunks are packed as [index:4][nonce:12][ciphertext+tag]. Decryption also
 * accepts the earlier V3 [nonce:12][ciphertext+tag] layout for compatibility.
 */

import {
  decryptChunkWithPool,
  encryptChunkWithPool,
  isCryptoPoolSupported,
} from '../workers/cryptoWorkerPool.js'

export const CHUNK_SIZE = 32 * 1024 * 1024

const INDEX_BYTES = 4
const NONCE_BYTES = 12
const TAG_BYTES = 16

export async function encryptChunk(chunkBytes, key, index) {
  const plaintext = toUint8Array(chunkBytes)
  const aad = encodeIndex(index)
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128, additionalData: aad },
    key,
    plaintext,
  )

  const output = new Uint8Array(INDEX_BYTES + NONCE_BYTES + ciphertext.byteLength)
  output.set(aad, 0)
  output.set(nonce, INDEX_BYTES)
  output.set(new Uint8Array(ciphertext), INDEX_BYTES + NONCE_BYTES)
  return output.buffer
}

export async function decryptChunk(packedBuffer, key, expectedIndex) {
  const bytes = toUint8Array(packedBuffer)
  if (bytes.byteLength <= INDEX_BYTES + NONCE_BYTES + TAG_BYTES) {
    throw new Error('Encrypted chunk is too short')
  }

  const storedIndex = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    INDEX_BYTES,
  ).getUint32(0, false)

  if (storedIndex === expectedIndex) {
    try {
      return await decryptCurrentChunk(bytes, key, expectedIndex)
    } catch (currentError) {
      // A legacy nonce has a 1-in-2^32 chance of beginning with expectedIndex.
      // Try the old layout before reporting the authenticated failure.
      try {
        return await decryptLegacyChunk(bytes, key, expectedIndex)
      } catch {
        throw currentError
      }
    }
  }

  // Legacy V3 chunks did not store the index prefix, but still authenticated
  // the caller-supplied index as AAD. A reordered current-format chunk also
  // reaches this branch and fails GCM verification under the legacy layout.
  return decryptLegacyChunk(bytes, key, expectedIndex)
}

export async function* encryptChunked(buffer, key, onProgress) {
  const bytes = toUint8Array(buffer)
  const totalChunks = Math.ceil(bytes.byteLength / CHUNK_SIZE)

  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * CHUNK_SIZE
    const end = Math.min(start + CHUNK_SIZE, bytes.byteLength)
    const encrypted = await encryptChunkOffThread(bytes.slice(start, end), key, index)
    onProgress?.({ chunksProcessed: index + 1, totalChunks })
    yield { index, encrypted, isLast: index === totalChunks - 1 }
  }
}

export async function* decryptChunked(getChunk, chunkCount, key, onProgress) {
  for (let index = 0; index < chunkCount; index += 1) {
    const packed = await getChunk(index)
    const plaintext = await decryptChunkOffThread(packed, key, index)
    onProgress?.({ chunksDecrypted: index + 1, chunkCount })
    yield plaintext
  }
}

export async function* encryptFileChunks(file, key, chunkSize = CHUNK_SIZE, onProgress) {
  const chunkCount = Math.ceil(file.size / chunkSize)

  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * chunkSize
    const end = Math.min(start + chunkSize, file.size)
    const plaintext = await file.slice(start, end).arrayBuffer()
    const size = plaintext.byteLength
    const encrypted = await encryptChunkOffThread(plaintext, key, index)
    onProgress?.({ chunksProcessed: index + 1, totalChunks: chunkCount })
    yield {
      index,
      encrypted,
      size,
      isLast: index === chunkCount - 1,
    }
  }
}

export async function* decryptFileChunks(id, chunkCount, key, fetchChunk, onProgress) {
  yield* decryptChunked(
    (index) => fetchChunk(id, index),
    chunkCount,
    key,
    onProgress,
  )
}

async function decryptCurrentChunk(bytes, key, expectedIndex) {
  const aad = bytes.slice(0, INDEX_BYTES)
  const storedIndex = new DataView(aad.buffer, aad.byteOffset, aad.byteLength)
    .getUint32(0, false)
  if (storedIndex !== expectedIndex) {
    throw new Error(`Encrypted chunk index mismatch: expected ${expectedIndex}`)
  }

  return crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: bytes.slice(INDEX_BYTES, INDEX_BYTES + NONCE_BYTES),
      tagLength: 128,
      additionalData: aad,
    },
    key,
    bytes.slice(INDEX_BYTES + NONCE_BYTES),
  )
}

function decryptLegacyChunk(bytes, key, expectedIndex) {
  return crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: bytes.slice(0, NONCE_BYTES),
      tagLength: 128,
      additionalData: encodeIndex(expectedIndex),
    },
    key,
    bytes.slice(NONCE_BYTES),
  )
}

function encodeIndex(index) {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) {
    throw new RangeError('Chunk index must be a uint32')
  }
  const aad = new Uint8Array(INDEX_BYTES)
  new DataView(aad.buffer).setUint32(0, index, false)
  return aad
}

function encryptChunkOffThread(bytes, key, index) {
  if (!isCryptoPoolSupported()) return encryptChunk(bytes, key, index)
  return encryptChunkWithPool(bytes, key, index)
}

function decryptChunkOffThread(bytes, key, index) {
  if (!isCryptoPoolSupported()) return decryptChunk(bytes, key, index)
  return decryptChunkWithPool(bytes, key, index)
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  throw new TypeError('Expected an ArrayBuffer or typed array')
}
