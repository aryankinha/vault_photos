import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'

if (!globalThis.crypto) globalThis.crypto = webcrypto

const {
  createEmptyManifest,
  parseManifest,
  validateManifest,
} = await import('../src/schema/manifestSchema.js')
const {
  BUNDLE_PAGE_SIZE,
  appendBundleEntry,
  createEmptyBundle,
  getBundlePageKey,
  parseBundle,
  parseBundlePage,
  serializeBundlePage,
} = await import('../src/schema/bundleSchema.js')
const { encryptPacked } = await import('../src/crypto/encrypt.js')
const { decryptPacked } = await import('../src/crypto/decrypt.js')
const { decryptChunk, encryptChunk } = await import('../src/crypto/chunkEncrypt.js')
const { encodeManifest, parseManifestBytes } = await import('../src/storage/manifestCodec.js')
const {
  MAX_LFS_POINTERS_PER_COMMIT,
  MAX_HF_OPERATIONS_PER_COMMIT,
  planCommitBatches,
} = await import('../worker/commitPlan.js')
const { abortableDelay } = await import('../src/utils/abort.js')

test('manifest accepts old entries and optional V3 fields', () => {
  const manifest = createEmptyManifest('2026-01-01T00:00:00.000Z')
  manifest.bundle_pages = 2
  manifest.files.push({
    id: '0123456789abcdef',
    name: 'clip.mp4',
    type: 'video',
    date_taken: '2026-01-01T00:00:00.000Z',
    size: 123,
    duration: 4.5,
    thumb_offset: 24,
    thumb_length: 3,
    page_index: 1,
    chunked: true,
    chunk_size: 32 * 1024 * 1024,
    chunk_count: 2,
  })
  assert.doesNotThrow(() => validateManifest(manifest))

  const old = structuredClone(manifest)
  delete old.bundle_pages
  delete old.files[0].page_index
  delete old.files[0].chunked
  delete old.files[0].chunk_size
  delete old.files[0].chunk_count
  assert.doesNotThrow(() => validateManifest(old))
})

test('bundle pages preserve offsets and binary entries', () => {
  assert.equal(BUNDLE_PAGE_SIZE, 50)
  assert.equal(getBundlePageKey(3), 'thumbs_page_3.bundle')

  const bytes = Uint8Array.of(1, 2, 3, 4)
  const appended = appendBundleEntry(createEmptyBundle(), {
    id: '0123456789abcdef',
    bytes,
  })
  assert.equal(appended.thumb_offset, 24)
  assert.equal(appended.thumb_length, 4)
  assert.deepEqual([...parseBundle(appended.bundle)[0].bytes], [...bytes])

  const page = serializeBundlePage([{ id: 'fedcba9876543210', bytes }])
  assert.deepEqual([...parseBundlePage(page)[0].bytes], [...bytes])
})

test('packed AES-GCM round trips and rejects tampering', async () => {
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  const plain = crypto.getRandomValues(new Uint8Array(4096))
  const encrypted = await encryptPacked(plain, key)
  assert.equal(encrypted.byteLength, plain.byteLength + 12 + 16)
  assert.deepEqual(
    new Uint8Array(await decryptPacked(encrypted, key)),
    plain,
  )

  const tampered = new Uint8Array(encrypted.slice(0))
  tampered[tampered.length - 1] ^= 1
  await assert.rejects(() => decryptPacked(tampered, key))
})

test('chunk decrypt supports indexed and legacy V3 layouts', async () => {
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  const plain = crypto.getRandomValues(new Uint8Array(2048))
  const current = await encryptChunk(plain, key, 7)
  assert.equal(new DataView(current).getUint32(0, false), 7)
  assert.deepEqual(new Uint8Array(await decryptChunk(current, key, 7)), plain)
  await assert.rejects(() => decryptChunk(current, key, 6))

  const aad = new Uint8Array(4)
  new DataView(aad.buffer).setUint32(0, 7, false)
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128, additionalData: aad },
    key,
    plain,
  )
  const legacy = new Uint8Array(nonce.byteLength + ciphertext.byteLength)
  legacy.set(nonce)
  legacy.set(new Uint8Array(ciphertext), nonce.byteLength)
  assert.deepEqual(new Uint8Array(await decryptChunk(legacy, key, 7)), plain)
})

test('gzip and old plain manifest encodings both parse', async () => {
  const manifest = createEmptyManifest('2026-01-01T00:00:00.000Z')
  const encoded = new Uint8Array(await encodeManifest(manifest))
  if (typeof CompressionStream !== 'undefined') {
    assert.deepEqual([...encoded.slice(0, 2)], [0x1f, 0x8b])
  }
  assert.deepEqual(await parseManifestBytes(encoded), manifest)

  const oldBytes = new TextEncoder().encode(JSON.stringify(manifest))
  assert.deepEqual(await parseManifestBytes(oldBytes), parseManifest(JSON.stringify(manifest)))
})

test('large LFS commits are bounded and publish metadata only in the final batch', () => {
  const metadata = [{ path: 'manifest.enc' }, { path: 'thumbs_page_0.bundle' }]
  const pointers = Array.from({ length: 101 }, (_, index) => ({
    path: `files/${index}.enc`,
  }))
  const batches = planCommitBatches(metadata, pointers)

  assert.equal(batches.length, 3)
  for (const batch of batches) {
    assert.ok(batch.lfsFilesToCommit.length <= MAX_LFS_POINTERS_PER_COMMIT)
  }
  assert.deepEqual(batches[0].filesToCommit, [])
  assert.deepEqual(batches[1].filesToCommit, [])
  assert.deepEqual(batches[2].filesToCommit, [metadata[1], metadata[0]])
  assert.equal(batches[2].filesToCommit.at(-1).path, 'manifest.enc')
  assert.equal(
    batches.reduce((count, batch) => count + batch.lfsFilesToCommit.length, 0),
    pointers.length,
  )
})

test('abortable upload waits stop immediately', async () => {
  const controller = new AbortController()
  const waiting = abortableDelay(10_000, controller.signal)
  controller.abort()
  await assert.rejects(waiting, (error) => error.name === 'AbortError')
})

test('many encrypted thumbnail pages are staged before the manifest', () => {
  const pages = Array.from({ length: 95 }, (_, index) => ({
    path: `thumbs_page_${index}.bundle`,
  }))
  const manifest = { path: 'manifest.enc' }
  const batches = planCommitBatches([...pages, manifest], [])

  assert.equal(batches.length, 3)
  assert.equal(batches[0].filesToCommit.length, MAX_HF_OPERATIONS_PER_COMMIT)
  assert.equal(batches[1].filesToCommit.length, MAX_HF_OPERATIONS_PER_COMMIT)
  assert.equal(batches[2].filesToCommit.length, 16)
  assert.equal(batches[0].filesToCommit.some((file) => file.path === manifest.path), false)
  assert.equal(batches[1].filesToCommit.some((file) => file.path === manifest.path), false)
  assert.equal(batches[2].filesToCommit.at(-1).path, manifest.path)
})
