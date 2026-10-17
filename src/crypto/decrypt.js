import {
  decryptWithPool as poolDecrypt,
  isCryptoPoolSupported,
} from '../workers/cryptoWorkerPool.js'
import { getActiveKey } from './keyDerivation.js'
import { resolveCryptoMode } from './context.js'

const NONCE_BYTES = 12

/**
 * Unpack and decrypt [nonce | ciphertext+tag].
 *
 * @param {ArrayBuffer|Uint8Array} buffer — packed bytes
 * @param {CryptoKey} key
 * @param {{ context?: {kind,id?,index?}, cryptoVersion?: 1|2 }} [options]
 *   - legacy mode (no context, no version or version 1): existing vaults,
 *     no AAD — byte-identical behaviour to before.
 *   - context mode (context / crypto_version 2): the canonical context is
 *     required as AAD. On authentication failure this mode NEVER falls back to
 *     legacy decryption (audit finding S3 downgrade protection) — a swapped or
 *     tampered object must fail loudly, not decrypt in the wrong context.
 */
export async function decryptPacked(buffer, key, options = {}) {
  const { aad } = resolveCryptoMode(options)
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  if (bytes.byteLength <= NONCE_BYTES) {
    throw new Error('Encrypted payload is too short')
  }

  const nonce = bytes.slice(0, NONCE_BYTES)
  const ciphertext = bytes.slice(NONCE_BYTES)

  const algorithm = { name: 'AES-GCM', iv: nonce, tagLength: 128 }
  if (aad) algorithm.additionalData = aad
  return crypto.subtle.decrypt(algorithm, key, ciphertext)
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
 * @param {CryptoKey} [key]
 * @param {{ context?: {kind,id?,index?}, cryptoVersion?: 1|2 }} [options] —
 *   optional crypto context, forwarded to the worker (or main-thread fallback)
 * @returns {Promise<ArrayBuffer>} — plaintext
 */
export async function decryptPackedOffThread(buffer, key = getActiveKey(), options = {}) {
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
  if (!isCryptoPoolSupported()) return decryptPacked(buf, key, options)
  return poolDecrypt(buf, key, options)
}
