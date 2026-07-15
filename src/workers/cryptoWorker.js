/**
 * CPU-heavy media work in a dedicated Web Worker.
 *
 * Runs entirely off the main thread so large-file crypto doesn't block UI.
 * Uses Transferable ArrayBuffer transfers (zero-copy) for both input and output.
 *
 * CryptoKey is structured-cloned into this worker. It remains non-extractable;
 * raw key bytes are never serialized into a JWK or retained by the pool.
 */

import exifr from 'exifr'

const NONCE_BYTES = 12
const INDEX_BYTES = 4
const TAG_BYTES = 16
const MAX_THUMB_DIMENSION = 400
const JPEG_QUALITY = 0.7
const EXIF_TAGS = ['DateTimeOriginal', 'CreateDate', 'ModifyDate']

self.onmessage = async (event) => {
  const { operation, taskId, buffer, key, mediaType, filename, index } = event.data

  try {
    let result

    if (operation === 'encrypt') {
      result = await encryptPacked(buffer, key)
    } else if (operation === 'decrypt') {
      result = await decryptPacked(buffer, key)
    } else if (operation === 'encryptChunk') {
      result = await encryptChunk(buffer, key, index)
    } else if (operation === 'decryptChunk') {
      result = await decryptChunk(buffer, key, index)
    } else if (operation === 'thumbnail') {
      result = await createThumbnail(buffer, mediaType, filename)
    } else if (operation === 'exif') {
      result = await readExif(buffer)
    } else {
      throw new Error(`Unknown worker operation: ${operation}`)
    }

    const transferable = result instanceof ArrayBuffer
      ? [result]
      : result?.buffer instanceof ArrayBuffer
        ? [result.buffer]
        : []
    self.postMessage({ type: 'result', taskId, result }, transferable)
  } catch (err) {
    self.postMessage({
      type: 'error',
      taskId,
      message: err instanceof Error ? err.message : 'Worker task failed',
    })
  }
}

// ---------------------------------------------------------------------------
// Crypto primitives mirror the main-thread fallbacks exactly.
// ---------------------------------------------------------------------------

async function encryptPacked(buffer, key) {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 },
    key,
    buffer,
  )
  const output = new Uint8Array(nonce.byteLength + ciphertext.byteLength)
  output.set(nonce, 0)
  output.set(new Uint8Array(ciphertext), nonce.byteLength)
  return output.buffer
}

async function decryptPacked(buffer, key) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  if (bytes.byteLength <= NONCE_BYTES) {
    throw new Error('Encrypted payload is too short')
  }
  const nonce = bytes.slice(0, NONCE_BYTES)
  const ciphertext = bytes.slice(NONCE_BYTES)
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 },
    key,
    ciphertext,
  )
}

async function encryptChunk(buffer, key, index) {
  const aad = encodeIndex(index)
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128, additionalData: aad },
    key,
    buffer,
  )
  const output = new Uint8Array(INDEX_BYTES + NONCE_BYTES + ciphertext.byteLength)
  output.set(aad, 0)
  output.set(nonce, INDEX_BYTES)
  output.set(new Uint8Array(ciphertext), INDEX_BYTES + NONCE_BYTES)
  return output.buffer
}

async function decryptChunk(buffer, key, expectedIndex) {
  const bytes = new Uint8Array(buffer)
  if (bytes.byteLength <= INDEX_BYTES + NONCE_BYTES + TAG_BYTES) {
    throw new Error('Encrypted chunk is too short')
  }

  const storedIndex = new DataView(bytes.buffer, 0, INDEX_BYTES).getUint32(0, false)
  if (storedIndex === expectedIndex) {
    try {
      return await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: bytes.slice(INDEX_BYTES, INDEX_BYTES + NONCE_BYTES),
          tagLength: 128,
          additionalData: bytes.slice(0, INDEX_BYTES),
        },
        key,
        bytes.slice(INDEX_BYTES + NONCE_BYTES),
      )
    } catch (currentError) {
      try {
        return await decryptLegacyChunk(bytes, key, expectedIndex)
      } catch {
        throw currentError
      }
    }
  }
  return decryptLegacyChunk(bytes, key, expectedIndex)
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

async function createThumbnail(buffer, mediaType, filename) {
  // Video decoding requires HTMLVideoElement, which does not exist in workers.
  // Older Safari versions also lack a complete OffscreenCanvas worker path.
  if (
    mediaType === 'video' ||
    typeof OffscreenCanvas === 'undefined' ||
    typeof createImageBitmap !== 'function'
  ) {
    return { needsMainThread: true }
  }

  const blob = new Blob([buffer], { type: inferImageMime(filename) })
  const bitmap = await createImageBitmap(blob)

  try {
    const scale = Math.min(
      1,
      MAX_THUMB_DIMENSION / Math.max(bitmap.width, bitmap.height),
    )
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d', { alpha: false })
    if (!context || typeof canvas.convertToBlob !== 'function') {
      return { needsMainThread: true }
    }

    context.drawImage(bitmap, 0, 0, width, height)
    const thumbnail = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: JPEG_QUALITY,
    })
    return {
      needsMainThread: false,
      buffer: await thumbnail.arrayBuffer(),
    }
  } finally {
    bitmap.close()
  }
}

async function readExif(buffer) {
  const metadata = await exifr.parse(buffer, EXIF_TAGS)
  const date = metadata?.DateTimeOriginal ?? metadata?.CreateDate ?? metadata?.ModifyDate
  return {
    dateTaken: date instanceof Date && Number.isFinite(date.getTime())
      ? date.toISOString()
      : null,
    duration: null,
  }
}

function inferImageMime(filename = '') {
  const extension = filename.toLowerCase().split('.').pop()
  if (extension === 'png') return 'image/png'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'gif') return 'image/gif'
  if (extension === 'heic' || extension === 'heif') return 'image/heic'
  return 'image/jpeg'
}
