/**
 * Ciphertext integrity verification (audit findings S3/U6).
 *
 * The manifest can optionally carry the SHA-256 of each encrypted object
 * (`sha256` for whole files, `chunk_sha256[]` for chunked files — both already
 * computed by the upload pipeline). When present, viewers verify the hash
 * BEFORE decryption so a swapped/truncated/corrupted object is rejected with a
 * clear integrity error instead of a vague GCM failure years later.
 *
 * Entries without hash metadata (every pre-existing vault) skip verification —
 * this never blocks legacy vaults.
 */
import { sha256Hex } from '../utils/hash.js'

export class IntegrityError extends Error {
  constructor(message, label = 'ciphertext') {
    super(message)
    this.name = 'IntegrityError'
    this.code = 'CIPHERTEXT_HASH_MISMATCH'
    this.label = label
  }
}

export function normalizeHex(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/** Length-checked, branch-light hex comparison (no early exit on first diff). */
export function hexEquals(a, b) {
  const left = normalizeHex(a)
  const right = normalizeHex(b)
  if (left.length === 0 || left.length !== right.length) return false
  let diff = 0
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return diff === 0
}

/**
 * Verify `bytes` against an expected hex SHA-256.
 *
 * @param {ArrayBuffer|Uint8Array} bytes — the ciphertext as fetched/stored
 * @param {string|undefined|null} expectedHex — expected lowercase hex digest;
 *   absent/empty = no metadata (legacy entry) → verification skipped
 * @param {string} [label] — used in the error message
 * @returns {Promise<string|null>} the actual digest, or null when skipped
 * @throws {IntegrityError} when the digest does not match
 */
export async function assertCiphertextHash(bytes, expectedHex, label = 'ciphertext') {
  if (!expectedHex) return null
  const actual = await sha256Hex(bytes)
  if (!hexEquals(actual, expectedHex)) {
    throw new IntegrityError(`${label} failed its SHA-256 integrity check`, label)
  }
  return actual
}
