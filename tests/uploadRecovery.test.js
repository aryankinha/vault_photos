import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'

if (!globalThis.crypto) globalThis.crypto = webcrypto

const {
  missingChunkIndexes,
  markChunkReceipt,
  isChunkRowComplete,
  isTransientUploadError,
  transientRetryDelayMs,
  MAX_TRANSIENT_RETRIES,
  TRANSIENT_RETRY_DELAYS,
  verifyReselectedFile,
  UPLOAD_WINDOW_SIZE,
} = await import('../src/services/uploadRecovery.js')
const { sha256Hex } = await import('../src/utils/hash.js')

function makeRow(overrides = {}) {
  return {
    id: '0123456789abcdef',
    entry: { size: 10, chunk_count: 4 },
    chunked: true,
    chunk_size: 3,
    chunk_count: 4,
    chunks: [null, null, null, null],
    chunkHashes: [null, null, null, null],
    ...overrides,
  }
}

function makeFile(bytes, name = 'clip.mp4') {
  return new File([bytes], name)
}

// ---------------------------------------------------------------------------
// Chunk receipt bookkeeping (U1)
// ---------------------------------------------------------------------------

test('missingChunkIndexes reports sparse gaps in receipt arrays', () => {
  assert.deepEqual(missingChunkIndexes([null, null]), [0, 1])
  assert.deepEqual(missingChunkIndexes([{ index: 0 }, null, { index: 2 }]), [1])
  assert.deepEqual(missingChunkIndexes([]), [])
  assert.deepEqual(missingChunkIndexes(undefined), [])
})

test('markChunkReceipt merges into a dense null-filled copy', () => {
  const chunks = markChunkReceipt([null, null], 1, { sha256: 'abc', size: 10 })
  assert.deepEqual(chunks, [null, { index: 1, sha256: 'abc', size: 10 }])
  // original unchanged (pure)
  assert.deepEqual([null, null], [null, null])

  // second receipt does not clobber the first; result stays dense-with-nulls
  const merged = markChunkReceipt(chunks, 0, { sha256: 'def', size: 3 })
  assert.equal(merged[0].sha256, 'def')
  assert.equal(merged[1].sha256, 'abc')
})

test('markChunkReceipt rejects out-of-row indexes', () => {
  assert.throws(() => markChunkReceipt([null], 3, { sha256: 'x', size: 1 }))
  assert.throws(() => markChunkReceipt([null], -1, { sha256: 'x', size: 1 }))
  assert.throws(() => markChunkReceipt([null], 0, null))
})

test('isChunkRowComplete demands full receipt coverage', () => {
  const row = makeRow()
  assert.equal(isChunkRowComplete(row), false)
  const covered = row.chunks.map((_, index) => ({ index, sha256: `h${index}`, size: 3 }))
  assert.equal(isChunkRowComplete({ ...row, chunks: covered }), true)
  // terminal guard: an undefined chunk_count row can never be reported complete
  assert.equal(isChunkRowComplete({ chunks: [] }), false)
})

// ---------------------------------------------------------------------------
// Transient retry taxonomy (U5)
// ---------------------------------------------------------------------------

test('transient classification: gateway/429/status-0 yes, validation 4xx no, abort never', () => {
  assert.equal(isTransientUploadError({ status: 502 }), true)
  assert.equal(isTransientUploadError({ status: 503 }), true)
  assert.equal(isTransientUploadError({ status: 504 }), true)
  assert.equal(isTransientUploadError({ status: 429 }), true)
  assert.equal(isTransientUploadError({ status: 0 }), true)
  assert.equal(isTransientUploadError({ status: 404 }), false)
  assert.equal(isTransientUploadError({ status: 400 }), false)
  assert.equal(isTransientUploadError({ status: 409, code: 'VAULT_STALE', retryable: false }), false)
  // explicit worker flag wins over status defaults
  assert.equal(isTransientUploadError({ status: 500, retryable: false }), false)
  assert.equal(isTransientUploadError({ status: 412, retryable: true }), true)
  assert.equal(isTransientUploadError(new DOMException('cancel', 'AbortError')), false)
  assert.equal(isTransientUploadError(null), false)
})

test('bounded retry delay honors Retry-After and the 1s/4s/15s backoff', () => {
  assert.deepEqual(TRANSIENT_RETRY_DELAYS, [1000, 4000, 15000])
  assert.equal(MAX_TRANSIENT_RETRIES, 3)

  // deterministic base table (no jitter)
  assert.equal(transientRetryDelayMs({}, 1, 0), 1000)
  assert.equal(transientRetryDelayMs({}, 2, 0), 4000)
  assert.equal(transientRetryDelayMs({}, 3, 0), 15000)
  // past-table attempts clamp instead of growing unbounded
  assert.equal(transientRetryDelayMs({}, 9, 0), 15000)

  // Retry-After dominates
  assert.equal(transientRetryDelayMs({ retryAfterMs: 30_000 }, 1, 0), 30_000)

  // jitter stays proportional
  for (let i = 0; i < 50; i += 1) {
    const delay = transientRetryDelayMs({}, 2)
    assert.ok(delay >= 4000 * 0.75 && delay <= 4000 * 1.25, `jitter out of range: ${delay}`)
  }
})

// ---------------------------------------------------------------------------
// Source re-selection verification (U1) — plaintext hashes, size not enough
// ---------------------------------------------------------------------------

test('verifyReselectedFile passes for an identical chunked file', async () => {
  const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  const file = makeFile(bytes)
  const row = makeRow({
    entry: { size: bytes.byteLength, chunk_count: 4 },
    chunkHashes: await Promise.all(
      [0, 3, 6, 9].map(async (start) => sha256Hex(bytes.slice(start, Math.min(start + 3, bytes.byteLength)))),
    ),
  })
  const result = await verifyReselectedFile(row, file)
  assert.equal(result.ok, true)
})

test('verifyReselectedFile rejects a same-size different-content chunked file', async () => {
  const original = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  const swapped = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 11]) // same size!
  const file = makeFile(swapped, 'impostor.mp4')
  const row = makeRow({
    entry: { size: original.byteLength, chunk_count: 4 },
    chunkHashes: await Promise.all(
      [0, 3, 6, 9].map(async (start) => sha256Hex(original.slice(start, Math.min(start + 3, original.byteLength)))),
    ),
  })
  // size matches, but the strong hash check catches the swap
  assert.equal(file.size, row.entry.size)
  const result = await verifyReselectedFile(row, file)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'hash-mismatch')
})

test('verifyReselectedFile rejects a size-mismatched file before hashing', async () => {
  const file = makeFile(Uint8Array.from([1, 2, 3]))
  const result = await verifyReselectedFile(makeRow(), file)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'size-mismatch')
})

test('verifyReselectedFile verifies whole-file plaintext hash for non-chunked rows', async () => {
  const bytes = Uint8Array.from([9, 8, 7, 6])
  const row = {
    id: 'fedcba9876543210',
    entry: { size: bytes.byteLength },
    fileHash: await sha256Hex(bytes),
  }
  assert.equal((await verifyReselectedFile(row, makeFile(bytes))).ok, true)

  const tampered = Uint8Array.from([9, 8, 7, 7])
  assert.equal(tampered.length, bytes.byteLength) // same size, different bytes
  const verdict = await verifyReselectedFile(row, makeFile(tampered))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'hash-mismatch')
})

test('verifyReselectedFile refuses legacy rows without integrity records', async () => {
  // Row written before plaintext hashes existed must NOT pass a weak
  // size-only check — needs-source stays until the vault owner re-uploads.
  const result = await verifyReselectedFile(makeRow({ chunkHashes: null }), makeFile(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])))
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'unverifiable')

  const wholeFileRow = { id: 'x', entry: { size: 4 } }
  assert.equal((await verifyReselectedFile(wholeFileRow, makeFile(Uint8Array.from([1, 2, 3, 4])))).ok, false)
})

test('upload window bounds intake', () => {
  assert.equal(typeof UPLOAD_WINDOW_SIZE, 'number')
  assert.ok(UPLOAD_WINDOW_SIZE >= 1)
})
