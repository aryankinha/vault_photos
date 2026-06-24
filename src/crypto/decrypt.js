import { decryptWithPool as poolDecrypt } from '../workers/cryptoWorkerPool'
import { getActiveKey } from './keyDerivation'

const NONCE_BYTES = 12

export async function decryptPacked(buffer, key) {
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

/**
 * Worker-pool backed version of decryptPacked().
 *
 * Transfers the buffer to a worker thread (zero-copy). Falls back to the
 * main-thread decryptPacked() if the pool key is not set.
 *
 * IMPORTANT: The input `buffer` is transferred — callers must not use it after
 * this call. If you need the original data, copy it first.
 *
 * @param {ArrayBuffer|Uint8Array} buffer — packed [nonce | ciphertext+tag]
 * @returns {Promise<ArrayBuffer>} — plaintext
 */
export async function decryptPackedOffThread(buffer) {
  // Always work with an ArrayBuffer for transfer.
  let buf
  if (buffer instanceof ArrayBuffer) {
    buf = buffer
  } else if (buffer instanceof Uint8Array) {
    // Copy so we own the buffer and can safely transfer.
    buf = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  } else {
    buf = buffer
  }
  try {
    return await poolDecrypt(buf)
  } catch {
    // Pool not initialised or key not set — fall back to main thread.
    return decryptPacked(buf, getActiveKey())
  }
}
