import { encryptWithPool as poolEncrypt } from '../workers/cryptoWorkerPool'
import { getActiveKey } from './keyDerivation'

const NONCE_BYTES = 12

export async function encryptArrayBuffer(buffer, key) {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 },
    key,
    buffer,
  )

  return { nonce, ciphertext }
}

export async function encryptPacked(buffer, key) {
  const { nonce, ciphertext } = await encryptArrayBuffer(buffer, key)
  const output = new Uint8Array(nonce.byteLength + ciphertext.byteLength)
  output.set(nonce, 0)
  output.set(new Uint8Array(ciphertext), nonce.byteLength)
  return output.buffer
}

/**
 * Worker-pool backed version of encryptPacked().
 *
 * Transfers the buffer to a worker thread (zero-copy). Falls back to the
 * main-thread encryptPacked() if the pool key is not set.
 *
 * IMPORTANT: The input `buffer` is transferred — callers must not use it after
 * this call. If you need the original data, copy it first.
 *
 * @param {ArrayBuffer|Uint8Array} buffer — plaintext to encrypt
 * @returns {Promise<ArrayBuffer>} — [nonce | ciphertext+tag]
 */
export async function encryptPackedOffThread(buffer) {
  const buf = buffer instanceof ArrayBuffer ? buffer : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  try {
    return await poolEncrypt(buf)
  } catch {
    // Pool not initialised or key not set — fall back to main thread.
    return encryptPacked(buf, getActiveKey())
  }
}

/**
 * Named alias — uploadService and chunkEncrypt import this name.
 * Delegates to encryptPackedOffThread (worker pool, falls back to main thread).
 *
 * @param {ArrayBuffer|Uint8Array} buffer — plaintext bytes (will be transferred)
 * @param {CryptoKey} [_key] — ignored; pool uses the active key from keyDerivation
 * @returns {Promise<ArrayBuffer>}
 */
export async function encryptWithPool(buffer, /* key intentionally unused; pool reads active key */
  // eslint-disable-next-line no-unused-vars
  _key) {
  return encryptPackedOffThread(buffer)
}

