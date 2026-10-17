/**
 * Chunked AES-256-GCM with the big-endian chunk index authenticated as AAD.
 * New chunks are packed as [index:4][nonce:12][ciphertext+tag]. Decryption also
 * accepts the earlier V3 [nonce:12][ciphertext+tag] layout for compatibility.
 *
 * v2 context binding (audit finding S3): every encrypt/decrypt accepts an
 * optional crypto context ({kind:'chunk', id, index}). When present, the
 * canonical context encoding — kind + file id + chunk index — is authenticated
 * as AAD, so chunks of different files (or different indexes) can never be
 * swapped. Whether an object is context-bound is decided EXPLICITLY by the
 * manifest entry's `crypto_version` metadata; in context mode decryption NEVER
 * falls back to the legacy index-only layouts on authentication failure.
 *
 * The wire layout is identical in both modes ([index:4][nonce:12][ct+tag]);
 * there is no format sniffing and therefore no downgrade path.
 */

import {
  decryptChunkWithPool,
  encryptChunkWithPool,
  isCryptoPoolSupported,
} from '../workers/cryptoWorkerPool.js'
import {
  CRYPTO_VERSION_CONTEXT,
  encodeCryptoContext,
  resolveCryptoMode,
} from './context.js'
import { assertCiphertextHash } from './integrity.js'

// New uploads use smaller chunks for fast seek/startup while each manifest
// keeps its own chunk_size, so existing 32 MiB V3 videos remain compatible.
export const CHUNK_SIZE = 8 * 1024 * 1024

const INDEX_BYTES = 4
const NONCE_BYTES = 12
const TAG_BYTES = 16

/**
 * @param {ArrayBuffer|Uint8Array} chunkBytes — plaintext chunk
 * @param {CryptoKey} key
 * @param {number} index — zero-based chunk index
 * @param {{ context?: {kind,id?,index?} }} [options] — optional crypto context
 */
export async function encryptChunk(chunkBytes, key, index, options = {}) {
  const plaintext = toUint8Array(chunkBytes)
  const aad = buildChunkAad(index, options.context)
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128, additionalData: aad },
    key,
    plaintext,
  )

  const output = new Uint8Array(INDEX_BYTES + NONCE_BYTES + ciphertext.byteLength)
  output.set(encodeIndex(index), 0)
  output.set(nonce, INDEX_BYTES)
  output.set(new Uint8Array(ciphertext), INDEX_BYTES + NONCE_BYTES)
  return output.buffer
}

/**
 * @param {ArrayBuffer|Uint8Array} packedBuffer — [index:4][nonce:12][ct+tag] or
 *   legacy [nonce:12][ct+tag]
 * @param {CryptoKey} key
 * @param {number} expectedIndex — zero-based chunk index the caller is reading
 * @param {{ context?: {kind,id?,index?}, cryptoVersion?: 1|2 }} [options] —
 *   context/crypto_version 2 selects context mode, which never falls back to
 *   legacy layouts on auth failure (S3 downgrade protection)
 */
export async function decryptChunk(packedBuffer, key, expectedIndex, options = {}) {
  const { context, cryptoVersion } = options
  if (context || cryptoVersion === CRYPTO_VERSION_CONTEXT) {
    return decryptContextChunk(toUint8Array(packedBuffer), key, expectedIndex, options)
  }

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

export async function* encryptChunked(buffer, key, onProgress, options = {}) {
  const bytes = toUint8Array(buffer)
  const totalChunks = Math.ceil(bytes.byteLength / CHUNK_SIZE)

  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * CHUNK_SIZE
    const end = Math.min(start + CHUNK_SIZE, bytes.byteLength)
    const encrypted = await encryptChunkOffThread(bytes.slice(start, end), key, index, options)
    onProgress?.({ chunksProcessed: index + 1, totalChunks })
    yield { index, encrypted, isLast: index === totalChunks - 1 }
  }
}

/**
 * @param {(index:number)=>Promise<ArrayBuffer|Uint8Array>} getChunk
 * @param {number} chunkCount
 * @param {CryptoKey} key
 * @param {object} [onProgress]
 * @param {{ context?: {kind,id?}, cryptoVersion?: 1|2,
 *           chunkSha256?: (string|null)[] }} [options] — `context` is the base
 *   chunk context (index merged per chunk); `chunkSha256` optionally carries
 *   the expected ciphertext digest per chunk (verified before decryption).
 */
export async function* decryptChunked(getChunk, chunkCount, key, onProgress, options = {}) {
  const baseContext = options.context ?? null
  const expectedHashes = Array.isArray(options.chunkSha256) ? options.chunkSha256 : null

  for (let index = 0; index < chunkCount; index += 1) {
    const packed = await getChunk(index)
    const expectedHash = expectedHashes?.[index] ?? null
    if (expectedHash) {
      await assertCiphertextHash(packed, expectedHash, `chunk ${index}`)
    }
    const context = baseContext ? withChunkIndex(baseContext, index) : undefined
    const plaintext = await decryptChunkOffThread(packed, key, index, {
      context,
      cryptoVersion: options.cryptoVersion,
    })
    onProgress?.({ chunksDecrypted: index + 1, chunkCount })
    yield plaintext
  }
}

export async function* encryptFileChunks(file, key, chunkSize = CHUNK_SIZE, onProgress, options = {}) {
  const chunkCount = Math.ceil(file.size / chunkSize)

  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * chunkSize
    const end = Math.min(start + chunkSize, file.size)
    const plaintext = await file.slice(start, end).arrayBuffer()
    const size = plaintext.byteLength
    const encrypted = await encryptChunkOffThread(plaintext, key, index, options)
    onProgress?.({ chunksProcessed: index + 1, totalChunks: chunkCount })
    yield {
      index,
      encrypted,
      size,
      isLast: index === chunkCount - 1,
    }
  }
}

export async function encryptFileChunk(file, key, index, chunkSize = CHUNK_SIZE, options = {}) {
  const start = index * chunkSize
  const end = Math.min(start + chunkSize, file.size)
  const plaintext = await file.slice(start, end).arrayBuffer()
  const size = plaintext.byteLength
  const encrypted = await encryptChunkOffThread(plaintext, key, index, options)
  return { index, encrypted, size }
}

export async function* decryptFileChunks(id, chunkCount, key, fetchChunk, onProgress, options = {}) {
  yield* decryptChunked(
    (index) => fetchChunk(id, index),
    chunkCount,
    key,
    onProgress,
    options,
  )
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Context mode: authenticate the canonical kind+id+index encoding as AAD.
 * Only the current [index:4][nonce:12][ct+tag] layout is accepted and there is
 * NO legacy fallback — an index-prefixed legacy chunk from another file must
 * fail here rather than silently decrypt.
 */
async function decryptContextChunk(bytes, key, expectedIndex, options) {
  // Validates cryptoVersion and that a version-2 request actually carries a
  // context (throws instead of degrading to legacy).
  const { aad } = resolveCryptoMode({
    context: withChunkIndex(options.context, expectedIndex),
    cryptoVersion: options.cryptoVersion,
  })

  if (bytes.byteLength <= INDEX_BYTES + NONCE_BYTES + TAG_BYTES) {
    throw new Error('Encrypted chunk is too short')
  }
  const storedIndex = new DataView(bytes.buffer, bytes.byteOffset, INDEX_BYTES)
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

/** Merge a base chunk context with the concrete index (kind defaults to 'chunk'). */
function withChunkIndex(context, index) {
  if (!context) return undefined
  if (context.kind !== undefined && context.kind !== 'chunk') {
    throw new RangeError(`Chunk crypto context kind must be 'chunk', got '${context.kind}'`)
  }
  if (context.index !== undefined && context.index !== index) {
    throw new RangeError(`Crypto context index ${context.index} does not match chunk index ${index}`)
  }
  return { ...context, kind: 'chunk', index }
}

/** AAD for a chunk: canonical context bytes when bound, index-only otherwise. */
function buildChunkAad(index, context) {
  if (!context) return encodeIndex(index)
  return encodeCryptoContext(withChunkIndex(context, index))
}

function encryptChunkOffThread(bytes, key, index, options = {}) {
  if (!isCryptoPoolSupported()) return encryptChunk(bytes, key, index, options)
  return encryptChunkWithPool(bytes, key, index, options)
}

function decryptChunkOffThread(bytes, key, index, options = {}) {
  if (!isCryptoPoolSupported()) return decryptChunk(bytes, key, index, options)
  return decryptChunkWithPool(bytes, key, index, options)
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  throw new TypeError('Expected an ArrayBuffer or typed array')
}
