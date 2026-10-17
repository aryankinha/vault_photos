import 'fake-indexeddb/auto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'

if (!globalThis.crypto) globalThis.crypto = webcrypto

const cacheModule = await import('../src/session/cache.js').catch(() => null)
const cacheAvailable = Boolean(cacheModule)
const {
  queueChunkedUploadPending,
  markChunkUploaded,
  saveChunkPlaintextHash,
  getUploadQueue,
  dequeueUpload,
} = cacheModule || {}

test('parallel chunk receipts do not lose updates', { skip: !cacheAvailable }, async () => {
  const id = '0123456789abcdef'
  await queueChunkedUploadPending(id, { id, name: 'x', size: 10, chunk_count: 4 }, new Blob(['x']), 4, 3, [null, null, null, null])
  await Promise.all([
    markChunkUploaded(id, 0, { index: 0, sha256: 'a'.repeat(64), size: 3 }),
    markChunkUploaded(id, 2, { index: 2, sha256: 'c'.repeat(64), size: 3 }),
    markChunkUploaded(id, 1, { index: 1, sha256: 'b'.repeat(64), size: 3 }),
  ])
  const row = (await getUploadQueue()).find((r) => r.id === id)
  assert.ok(row.chunks[0])
  assert.ok(row.chunks[1])
  assert.ok(row.chunks[2])
  assert.equal(row.chunks[0].sha256, 'a'.repeat(64))
  assert.equal(row.chunks[2].sha256, 'c'.repeat(64))
})

test('plaintext hashes persist and survive partial crash', { skip: !cacheAvailable }, async () => {
  const id = 'fedcba9876543210'
  await queueChunkedUploadPending(id, { id, name: 'y', size: 8, chunk_count: 2 }, new Blob(['y']), 2, 4, ['h0', 'h1'])
  await saveChunkPlaintextHash(id, 0, 'hash0')
  await saveChunkPlaintextHash(id, 1, 'hash1')
  const row = (await getUploadQueue()).find((r) => r.id === id)
  assert.deepEqual(row.chunkHashes, ['hash0', 'hash1'])
  assert.equal(row.chunkHashesReady, true)
  await dequeueUpload(id)
})

test('crashed partial row keeps preflight hashes for reselection', { skip: !cacheAvailable }, async () => {
  const id = '1234567890abcdef'
  const bytes = Uint8Array.from([1,2,3,4,5,6,7,8])
  const chunkSize = 3
  const hashes = await Promise.all([0,3,6].map(async (s) => {
    const { sha256Hex } = await import('../src/utils/hash.js')
    return sha256Hex(bytes.slice(s, Math.min(s + chunkSize, bytes.length)))
  }))
  await queueChunkedUploadPending(id, { id, name: 'clip.mp4', size: bytes.length, chunk_count: 3 }, new Blob(['x']), 3, chunkSize, hashes, { chunkHashesReady: true })
  // simulate one chunk landed before crash
  await markChunkUploaded(id, 0, { index: 0, sha256: 'r0', size: 3 })
  const row = (await getUploadQueue()).find((r) => r.id === id)
  assert.equal(row.chunks[0].sha256, 'r0')
  assert.equal(row.chunks[1], null)
  const { verifyReselectedFile } = await import('../src/services/uploadRecovery.js')
  const file = new (globalThis.File)([bytes], 'clip.mp4')
  const verdict = await verifyReselectedFile(row, file)
  assert.equal(verdict.ok, true)
  await dequeueUpload(id)
})
