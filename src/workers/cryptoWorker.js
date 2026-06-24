/**
 * cryptoWorker.js — AES-256-GCM encrypt/decrypt in a dedicated Web Worker.
 *
 * Runs entirely off the main thread so large-file crypto doesn't block UI.
 * Uses Transferable ArrayBuffer transfers (zero-copy) for both input and output.
 *
 * Message shapes (sent TO worker):
 *   { type: 'encrypt', id: string, payload: ArrayBuffer, keyData: JsonWebKey }
 *   { type: 'decrypt', id: string, payload: ArrayBuffer, keyData: JsonWebKey }
 *
 * Message shapes (sent FROM worker):
 *   { type: 'result',  id: string, result: ArrayBuffer }
 *   { type: 'error',   id: string, message: string }
 *
 * The `keyData` is a JWK-exported AES-GCM key. The worker imports it as
 * non-extractable for each operation (key import is cheap compared to the
 * Argon2 derivation that already happened on the main thread).
 */

const NONCE_BYTES = 12

self.onmessage = async (event) => {
  const { type, id, payload, keyData } = event.data

  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      keyData,
      { name: 'AES-GCM' },
      false,
      type === 'encrypt' ? ['encrypt'] : ['decrypt'],
    )

    let result

    if (type === 'encrypt') {
      result = await encryptPacked(payload, key)
    } else if (type === 'decrypt') {
      result = await decryptPacked(payload, key)
    } else {
      throw new Error(`Unknown message type: ${type}`)
    }

    // Transfer the result buffer (zero-copy).
    self.postMessage({ type: 'result', id, result }, [result])
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err.message })
  }
}

// ---------------------------------------------------------------------------
// Crypto primitives — mirrors src/crypto/encrypt.js and decrypt.js exactly.
// These are intentionally duplicated here so the worker has no module imports.
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
