/**
 * chunkEncrypt.js — Chunked AES-GCM encrypt/decrypt generators.
 *
 * For files >= 50MB, we encrypt and upload in sequential chunks to avoid
 * memory saturation. We use the 4-byte chunk index (Big-Endian) as AES-GCM
 * Additional Authenticated Data (AAD) to prevent chunk reordering attacks.
 */

const NONCE_BYTES = 12

/**
 * Encrypt a single chunk buffer with its index as AAD.
 *
 * @param {ArrayBuffer} chunkBytes — plaintext chunk data
 * @param {CryptoKey} key — AES-256 key
 * @param {number} index — zero-based chunk index
 * @returns {Promise<ArrayBuffer>} — [nonce | ciphertext+tag]
 */
export async function encryptChunk(chunkBytes, key, index) {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  
  // Format the index as a 4-byte big-endian AAD
  const aad = new Uint8Array(4)
  new DataView(aad.buffer).setUint32(0, index, false)

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128, additionalData: aad },
    key,
    chunkBytes,
  )

  const output = new Uint8Array(nonce.byteLength + ciphertext.byteLength)
  output.set(nonce, 0)
  output.set(new Uint8Array(ciphertext), nonce.byteLength)
  return output.buffer
}

/**
 * Decrypt a single chunk buffer with its index as AAD.
 *
 * @param {ArrayBuffer|Uint8Array} packedBuffer — [nonce | ciphertext+tag]
 * @param {CryptoKey} key — AES-256 key
 * @param {number} index — zero-based chunk index
 * @returns {Promise<ArrayBuffer>} — plaintext chunk
 */
export async function decryptChunk(packedBuffer, key, index) {
  const bytes = packedBuffer instanceof Uint8Array ? packedBuffer : new Uint8Array(packedBuffer)
  if (bytes.byteLength <= NONCE_BYTES) {
    throw new Error('Encrypted chunk is too short')
  }

  const nonce = bytes.slice(0, NONCE_BYTES)
  const ciphertext = bytes.slice(NONCE_BYTES)

  // Format the index as a 4-byte big-endian AAD
  const aad = new Uint8Array(4)
  new DataView(aad.buffer).setUint32(0, index, false)

  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128, additionalData: aad },
    key,
    ciphertext,
  )
}

/**
 * Async generator to yield encrypted chunks from a File/Blob.
 *
 * @param {File|Blob} file — full file/blob to encrypt
 * @param {CryptoKey} key — AES-256 key
 * @param {number} chunkSize — chunk size in bytes
 * @returns {AsyncGenerator<{ index: number, encrypted: ArrayBuffer, size: number }>}
 */
export async function* encryptFileChunks(file, key, chunkSize) {
  const totalSize = file.size
  const chunkCount = Math.ceil(totalSize / chunkSize)
  for (let i = 0; i < chunkCount; i++) {
    const start = i * chunkSize
    const end = Math.min(start + chunkSize, totalSize)
    const chunk = file.slice(start, end)
    const chunkBuffer = await chunk.arrayBuffer()
    const encrypted = await encryptChunk(chunkBuffer, key, i)
    yield { index: i, encrypted, size: chunkBuffer.byteLength }
  }
}

/**
 * Async generator to yield decrypted chunks.
 *
 * @param {string} id — 16-hex file id
 * @param {number} chunkCount — total number of chunks
 * @param {CryptoKey} key — AES-256 key
 * @param {(id: string, index: number) => Promise<ArrayBuffer>} fetchChunk — function to fetch raw chunk bytes
 * @returns {AsyncGenerator<ArrayBuffer>}
 */
export async function* decryptFileChunks(id, chunkCount, key, fetchChunk) {
  for (let i = 0; i < chunkCount; i++) {
    const encryptedChunk = await fetchChunk(id, i)
    const decrypted = await decryptChunk(encryptedChunk, key, i)
    yield decrypted
  }
}
