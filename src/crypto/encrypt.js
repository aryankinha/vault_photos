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
