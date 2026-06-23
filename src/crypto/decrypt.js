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
