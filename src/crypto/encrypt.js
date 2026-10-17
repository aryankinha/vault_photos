import {
  encryptWithPool as poolEncrypt,
  isCryptoPoolSupported,
} from '../workers/cryptoWorkerPool.js'
import { getActiveKey } from './keyDerivation.js'
import { resolveCryptoMode } from './context.js'

const NONCE_BYTES = 12

export async function encryptArrayBuffer(buffer, key, aad = null) {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const algorithm = { name: 'AES-GCM', iv: nonce, tagLength: 128 }
  if (aad) algorithm.additionalData = aad
  const ciphertext = await crypto.subtle.encrypt(algorithm, key, buffer)

  return { nonce, ciphertext }
}

/**
 * Pack [nonce | ciphertext+tag].
 *
 * @param {ArrayBuffer|Uint8Array} buffer — plaintext
 * @param {CryptoKey} key
 * @param {{ context?: {kind,id?,index?} }} [options] — optional crypto context
 *   (v2, audit finding S3). When present, the canonical context encoding is
 *   authenticated as AES-GCM AAD, binding the ciphertext to its object. The
 *   wire layout is unchanged; whether an object is context-bound is decided
 *   EXPLICITLY by `crypto_version` metadata on the manifest entry, never by
 *   format sniffing.
 */
export async function encryptPacked(buffer, key, options = {}) {
  const { aad } = resolveCryptoMode(options)
  const { nonce, ciphertext } = await encryptArrayBuffer(buffer, key, aad)
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
 * @param {CryptoKey} [key]
 * @param {{ context?: {kind,id?,index?} }} [options] — optional crypto context,
 *   forwarded to the worker (or to the main-thread fallback)
 * @returns {Promise<ArrayBuffer>} — [nonce | ciphertext+tag]
 */
export async function encryptPackedOffThread(buffer, key = getActiveKey(), options = {}) {
  const buf = buffer instanceof ArrayBuffer ? buffer : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  if (!isCryptoPoolSupported()) return encryptPacked(buf, key, options)
  return poolEncrypt(buf, key, options)
}

/**
 * Named alias — uploadService and chunkEncrypt import this name.
 * Delegates to encryptPackedOffThread (worker pool, falls back to main thread).
 *
 * @param {ArrayBuffer|Uint8Array} buffer — plaintext bytes (will be transferred)
 * @param {CryptoKey} [key] — pool uses the active key from keyDerivation when omitted
 * @param {{ context?: {kind,id?,index?} }} [options] — optional crypto context
 * @returns {Promise<ArrayBuffer>}
 */
export async function encryptWithPool(buffer, key = getActiveKey(), options = {}) {
  return encryptPackedOffThread(buffer, key, options)
}
