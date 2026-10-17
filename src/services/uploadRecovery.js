/**
 * Pure helpers for durable chunked uploads and source re-selection.
 *
 * Must stay free of IndexedDB / network / DOM imports so it can be unit tested
 * in Node and reasoned about independently of storage layers. Persistence of
 * the structures below lives in ../session/cache.js.
 *
 * Queue row shapes produced/consumed here:
 *   Chunked row:
 *     { id, entry, thumbnail, chunked: true, chunk_size, chunk_count,
 *       chunks: Array<receipt|null>,          // LFS receipts, index = chunk index
 *       chunkHashes: Array<string|null>,      // PLAINTEXT sha256 per chunk
 *       backgroundAttempts }
 *   Whole-file row:
 *     { id, encryptedBytes, entry, thumbnail, sha256 (ciphertext),
 *       fileHash (plaintext), uploaded?, backgroundAttempts }
 *
 * A receipt is { index, sha256, size } — the ciphertext sha256/size the worker
 * confirmed at PUT time.
 */

import { sha256Hex } from '../utils/hash.js'

// Bounded transient-retry policy for transport errors (U5). Only network-y
// failures (offline, status 0/408/425, 429, 5xx, or an explicit
// `retryable: true` from the worker) auto-retry; validation 4xx never do.
export const TRANSIENT_RETRY_DELAYS = [1000, 4000, 15000]
export const MAX_TRANSIENT_RETRIES = 3
export const TRANSIENT_JITTER_RATIO = 0.25

// Keep ingestion memory bounded for very large selections (U4): files are
// processed in windows so only ~window files are queued/encrypted/transiently
// buffered at once inside a single batch.
export const UPLOAD_WINDOW_SIZE = 10

// ---------------------------------------------------------------------------
// Chunk receipt bookkeeping (U1)
// ---------------------------------------------------------------------------

/**
 * Indexes whose LFS receipt is still missing from a sparse `chunks` array.
 * @param {Array} chunks
 * @returns {number[]}
 */
export function missingChunkIndexes(chunks) {
  if (!Array.isArray(chunks)) return []
  const missing = []
  for (let index = 0; index < chunks.length; index += 1) {
    if (!chunks[index]) missing.push(index)
  }
  return missing
}

/**
 * Whether every chunk has a receipt (safe to finalize). Accepts either a queue
 * row (`chunk_count`/`entry.chunk_count`) or a prepared item (`chunkCount`).
 * @param {{ chunk_count?: number, chunkCount?: number, entry?: { chunk_count?: number } }} row
 * @param {Array} [chunks]
 * @returns {boolean}
 */
export function isChunkRowComplete(row, chunks = row.chunks) {
  const count = row.chunkCount ?? row.chunk_count ?? row.entry?.chunk_count ?? 0
  if (!Number.isInteger(count) || count <= 0) return false
  if (!Array.isArray(chunks)) return false
  if (chunks.length !== count) return false
  for (let index = 0; index < count; index += 1) {
    if (!chunks[index]) return false
  }
  return true
}

/**
 * Pure merge of a chunk receipt into a sparse chunks array. Returns a NEW
 * dense-with-nulls array so callers can hand the result straight to IndexedDB
 * (structured clone of holey arrays is unreliable across engines).
 *
 * @param {Array} chunks
 * @param {number} index
 * @param {{ sha256: string, size: number }} receipt
 */
export function markChunkReceipt(chunks, index, receipt) {
  if (!Number.isInteger(index) || index < 0 || !receipt) {
    throw new Error('Invalid chunk receipt')
  }
  const dense = Array.isArray(chunks)
    ? Array.from(chunks, (entry) => entry ?? null)
    : []
  if (index >= dense.length) {
    throw new Error('Chunk receipt index is outside the row')
  }
  dense[index] = { index, sha256: receipt.sha256, size: receipt.size }
  return dense
}

// ---------------------------------------------------------------------------
// Transient-retry taxonomy (U5)
// ---------------------------------------------------------------------------

const TRANSIENT_HTTP_STATUSES = new Set([
  408,
  425,
  429,
  500,
  502,
  503,
  504,
])

/**
 * Whether an upload error is a transient transport failure worth retrying.
 * Aborts and validation failures are never transient.
 *
 * @param {{ status?: number, retryable?: boolean }} error
 */
export function isTransientUploadError(error) {
  if (!error) return false
  if (error.retryable === true) return true
  if (error.retryable === false) return false
  const status = error.status
  if (status === 0) return true // network error / offline
  return status === undefined ? false : TRANSIENT_HTTP_STATUSES.has(status)
}

/**
 * Delay before the next transient retry attempt (1-based). Honors a
 * `Retry-After` hint when present (ms), otherwise follows the backoff table
 * with proportional jitter. Clamped to the last delay once attempts run past
 * the table — callers bound attempts with MAX_TRANSIENT_RETRIES.
 *
 * @param {{ retryAfterMs?: number }} error
 * @param {number} attempt
 * @param {number} [jitterRatio]
 * @returns {number}
 */
export function transientRetryDelayMs(error, attempt, jitterRatio = TRANSIENT_JITTER_RATIO) {
  const retryAfter = error?.retryAfterMs
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.round(retryAfter * (1 + jitterRatio * Math.random()))
  }
  const base = TRANSIENT_RETRY_DELAYS[
    Math.min(Math.max(attempt, 1) - 1, TRANSIENT_RETRY_DELAYS.length - 1)
  ]
  const jitter = base * jitterRatio * (Math.random() * 2 - 1)
  return Math.round(base + jitter)
}

// ---------------------------------------------------------------------------
// Source re-selection verification (U1) — size/name alone are not sufficient
// ---------------------------------------------------------------------------

function fileSliceHash(file, start, end) {
  return file.slice(start, end).arrayBuffer().then(sha256Hex)
}

/**
 * Verify a re-selected source File strongly matches the original upload row,
 * using PLAINTEXT hashes recorded during the original upload:
 *   - chunked rows: per-chunk plaintext sha256 for every recorded chunk
 *   - whole-file rows: the plaintext sha256 of the entire file
 *
 * Size is checked first as a cheap necessary precondition; it is never
 * sufficient on its own.
 *
 * Legacy rows recorded before this scheme existed cannot be verified — they
 * return { ok: false, reason: 'unverifiable' } instead of a weak size-only
 * pass, so the caller can keep the row in `needs-source`.
 *
 * @param {object} row — queue row (see module header)
 * @param {File} file — re-selected source file
 * @returns {Promise<{ ok: boolean, reason?: 'size-mismatch'|'hash-mismatch'|'unverifiable', detail?: string }>}
 */
export async function verifyReselectedFile(row, file) {
  if (!row || !file) return { ok: false, reason: 'unverifiable' }
  if (file.size !== row.entry?.size) {
    return { ok: false, reason: 'size-mismatch' }
  }

  if (row.chunked) {
    const hashes = Array.isArray(row.chunkHashes) ? row.chunkHashes : []
    const count = row.chunk_count ?? row.entry?.chunk_count ?? hashes.length
    // A row is only strongly verifiable when ALL plaintext chunk hashes were
    // recorded. An explicit "not ready" marker (legacy/partial preparation)
    // keeps the row unverifiable even if some hashes happen to be present.
    const markers = [
      row.chunkHashesReady,
      row.fingerprintsReady,
      row.hashesReady,
      row.prepared,
      row.fingerprintComplete,
      row.allChunkHashesReady,
    ]
    if (markers.some((value) => value === false)) {
      return { ok: false, reason: 'unverifiable', detail: 'row fingerprints are not fully ready' }
    }
    const hasExplicitReady = markers.some((value) => value === true)
    if (count <= 0 || hashes.length !== count || missingChunkIndexes(hashes).length > 0) {
      return { ok: false, reason: 'unverifiable', detail: 'row is missing recorded chunk hashes' }
    }
    if (!hasExplicitReady && !(Array.isArray(row.chunkHashes) && row.chunkHashes.length === count)) {
      return { ok: false, reason: 'unverifiable', detail: 'row is missing recorded chunk hashes' }
    }
    const chunkSize = row.chunk_size ?? row.entry?.chunk_size
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      return { ok: false, reason: 'unverifiable', detail: 'row is missing chunk_size' }
    }
    for (let index = 0; index < count; index += 1) {
      const start = index * chunkSize
      const end = Math.min(start + chunkSize, file.size)
      const digest = await fileSliceHash(file, start, end)
      if (digest !== hashes[index]) {
        return { ok: false, reason: 'hash-mismatch', detail: `chunk ${index}` }
      }
    }
    return { ok: true }
  }

  const fileMarkers = [row.fileHashReady, row.fingerprintsReady, row.hashesReady, row.prepared, row.fingerprintComplete]
  if (fileMarkers.some((value) => value === false)) {
    return { ok: false, reason: 'unverifiable', detail: 'row fingerprints are not fully ready' }
  }
  const expected = row.fileHash
  if (!expected) return { ok: false, reason: 'unverifiable', detail: 'row has no file hash' }
  const digest = await fileSliceHash(file, 0, file.size)
  if (digest !== expected) return { ok: false, reason: 'hash-mismatch', detail: 'file' }
  return { ok: true }
}
