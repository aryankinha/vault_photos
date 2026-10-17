import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'

if (!globalThis.crypto) globalThis.crypto = webcrypto

const {
  CRYPTO_VERSION_CONTEXT,
  CRYPTO_VERSION_LEGACY,
  chunkContext,
  encodeCryptoContext,
  fileContext,
  resolveCryptoMode,
  resolveCryptoVersion,
} = await import('../src/crypto/context.js')
const { encryptPacked, encryptPackedOffThread } = await import('../src/crypto/encrypt.js')
const { decryptPacked, decryptPackedOffThread } = await import('../src/crypto/decrypt.js')
const { decryptChunk, encryptChunk, decryptFileChunks } = await import('../src/crypto/chunkEncrypt.js')
const { assertCiphertextHash, hexEquals, IntegrityError } = await import('../src/crypto/integrity.js')

const ID_A = '0123456789abcdef'
const ID_B = 'fedcba9876543210'

async function makeKey() {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

// ---------------------------------------------------------------------------
// Context canonical encoding
// ---------------------------------------------------------------------------

test('canonical context encoding is deterministic and injective', () => {
  const base = encodeCryptoContext(chunkContext(ID_A, 3))
  assert.deepEqual([...encodeCryptoContext(chunkContext(ID_A, 3))], [...base])

  const variants = [
    encodeCryptoContext(chunkContext(ID_B, 3)),
    encodeCryptoContext(chunkContext(ID_A, 4)),
    encodeCryptoContext({ kind: 'chunk', id: ID_A }), // id present, index absent
    encodeCryptoContext({ kind: 'file', id: ID_A, index: 3 }), // different kind
    encodeCryptoContext(fileContext(ID_A)),
    encodeCryptoContext({ kind: 'manifest' }),
    encodeCryptoContext({ kind: 'bundle', id: 'page_1' }),
  ]
  for (const variant of variants) {
    assert.notDeepEqual([...variant], [...base])
  }
  // id presence is flagged, so {kind:'file'} and {kind:'file', id:''}… id ''
  // is rejected, but id-absent vs index-absent must differ from each other.
  assert.notDeepEqual(
    [...encodeCryptoContext({ kind: 'file' })],
    [...encodeCryptoContext({ kind: 'chunk', index: 0 })],
  )
})

test('context encoding rejects malformed contexts', () => {
  assert.throws(() => encodeCryptoContext(null), TypeError)
  assert.throws(() => encodeCryptoContext({ kind: 'nope' }), RangeError)
  assert.throws(() => encodeCryptoContext({ kind: 'file', id: 'not hex/../x' }), RangeError)
  assert.throws(() => encodeCryptoContext({ kind: 'file', id: '' }), RangeError)
  assert.throws(() => encodeCryptoContext({ kind: 'chunk', index: -1 }), RangeError)
  assert.throws(() => encodeCryptoContext({ kind: 'chunk', index: 1.5 }), RangeError)
  assert.throws(() => encodeCryptoContext({ kind: 'chunk', index: 2 ** 53 }), RangeError)
})

test('crypto version resolution never silently upgrades or downgrades', () => {
  assert.equal(resolveCryptoVersion({}), CRYPTO_VERSION_LEGACY)
  assert.equal(resolveCryptoVersion(undefined), CRYPTO_VERSION_LEGACY)
  assert.equal(resolveCryptoVersion({ crypto_version: 2 }), CRYPTO_VERSION_CONTEXT)
  assert.equal(resolveCryptoVersion({ crypto_version: 1 }), CRYPTO_VERSION_LEGACY)
  assert.throws(() => resolveCryptoVersion({ crypto_version: 3 }), /Unsupported crypto version/)
  assert.throws(() => resolveCryptoVersion({ crypto_version: '2' }), /Unsupported crypto version/)

  // v2 without a context must refuse rather than fall back to legacy.
  assert.throws(
    () => resolveCryptoMode({ cryptoVersion: CRYPTO_VERSION_CONTEXT }),
    /refusing legacy fallback/,
  )
  // v1 + context is a contradiction, also refused.
  assert.throws(
    () => resolveCryptoMode({ cryptoVersion: CRYPTO_VERSION_LEGACY, context: fileContext(ID_A) }),
    /cannot be combined/,
  )
  assert.deepEqual(resolveCryptoMode({}), { mode: 'legacy', aad: null })
  assert.equal(resolveCryptoMode({ context: fileContext(ID_A) }).mode, 'context')
})

// ---------------------------------------------------------------------------
// Packed (whole-file) context binding
// ---------------------------------------------------------------------------

test('packed context round trips and rejects every cross-context swap', async () => {
  const key = await makeKey()
  const plain = crypto.getRandomValues(new Uint8Array(2048))

  const bound = await encryptPacked(plain, key, { context: fileContext(ID_A) })
  assert.deepEqual(
    new Uint8Array(await decryptPacked(bound, key, { context: fileContext(ID_A) })),
    plain,
  )

  // Wrong file id under context mode → auth failure (cross-file swap).
  await assert.rejects(() => decryptPacked(bound, key, { context: fileContext(ID_B) }))
  // Context-bound ciphertext offered to legacy mode → auth failure (no AAD
  // match), so there is no "convenient" downgrade direction either.
  await assert.rejects(() => decryptPacked(bound, key, {}))
  await assert.rejects(() => decryptPacked(bound, key))

  // Legacy ciphertext offered to context mode → auth failure (no fallback).
  const legacy = await encryptPacked(plain, key)
  assert.deepEqual(new Uint8Array(await decryptPacked(legacy, key)), plain)
  await assert.rejects(() => decryptPacked(legacy, key, { context: fileContext(ID_A) }))

  // Tampering still fails.
  const tampered = new Uint8Array(bound.slice(0))
  tampered[tampered.length - 1] ^= 1
  await assert.rejects(() => decryptPacked(tampered, key, { context: fileContext(ID_A) }))
})

test('off-thread packed path (pool fallback in Node) honours context', async () => {
  const key = await makeKey()
  const plain = crypto.getRandomValues(new Uint8Array(1024))

  const bound = await encryptPackedOffThread(plain, key, { context: fileContext(ID_A) })
  const opened = await decryptPackedOffThread(bound, key, { context: fileContext(ID_A) })
  assert.deepEqual(new Uint8Array(opened), plain)
  await assert.rejects(() => decryptPackedOffThread(bound, key, { context: fileContext(ID_B) }))
  await assert.rejects(() => decryptPackedOffThread(bound, key, {}))
})

// ---------------------------------------------------------------------------
// Chunk context binding
// ---------------------------------------------------------------------------

test('chunk context round trips and rejects cross-file/cross-index swaps', async () => {
  const key = await makeKey()
  const plain = crypto.getRandomValues(new Uint8Array(512))

  const options = { context: chunkContext(ID_A, 0), cryptoVersion: 2 }
  const bound = await encryptChunk(plain, key, 0, { context: chunkContext(ID_A, 0) })
  // Index prefix stays in the wire layout.
  assert.equal(new DataView(bound).getUint32(0, false), 0)

  assert.deepEqual(new Uint8Array(await decryptChunk(bound, key, 0, options)), plain)

  // Same index, different file id → cross-file rejection.
  await assert.rejects(() => decryptChunk(bound, key, 0, {
    context: chunkContext(ID_B, 0),
    cryptoVersion: 2,
  }))
  // Right file, wrong index → rejection.
  await assert.rejects(() => decryptChunk(bound, key, 1, {
    context: chunkContext(ID_A, 1),
    cryptoVersion: 2,
  }))
  // Context mismatch between index and context argument → hard error.
  await assert.rejects(
    () => decryptChunk(bound, key, 0, { context: chunkContext(ID_A, 5), cryptoVersion: 2 }),
    /does not match chunk index/,
  )
  // v2 without context → refuses legacy fallback.
  await assert.rejects(() => decryptChunk(bound, key, 0, { cryptoVersion: 2 }), /refusing legacy fallback/)
})

test('context mode never falls back to legacy on auth failure (S3 core fix)', async () => {
  const key = await makeKey()
  const plain = crypto.getRandomValues(new Uint8Array(512))

  // A current-format LEGACY chunk (index-only AAD) for file A at index 0.
  const legacySameIndex = await encryptChunk(plain, key, 0)
  assert.equal(new DataView(legacySameIndex).getUint32(0, false), 0)

  // Legacy mode reads it fine (existing vault compatibility).
  assert.deepEqual(new Uint8Array(await decryptChunk(legacySameIndex, key, 0)), plain)

  // The S3 attack: serving that legacy chunk as a context-bound (v2) object of
  // ANY file must fail — the stored index matches, so a fallback attempt would
  // have "succeeded" and rendered the wrong media. It must not.
  await assert.rejects(() => decryptChunk(legacySameIndex, key, 0, {
    context: chunkContext(ID_A, 0),
    cryptoVersion: 2,
  }))

  // A v1 chunk from file A served at file B's slot still decrypts in legacy
  // mode (documented residual risk for entries that predate crypto_version 2).
  assert.deepEqual(new Uint8Array(await decryptChunk(legacySameIndex, key, 0)), plain)
})

test('legacy V3 chunk layouts still decrypt without context options', async () => {
  const key = await makeKey()
  const plain = crypto.getRandomValues(new Uint8Array(256))

  // Pre-V3 layout: [nonce:12][ct+tag], index-only AAD, no stored index.
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
  await assert.rejects(() => decryptChunk(legacy, key, 6))
  // Context mode rejects it too (no fallback in either direction).
  await assert.rejects(() => decryptChunk(legacy, key, 7, {
    context: chunkContext(ID_A, 7),
    cryptoVersion: 2,
  }))
})

// ---------------------------------------------------------------------------
// decryptFileChunks integration: context + per-chunk hash verification
// ---------------------------------------------------------------------------

test('chunk stream verifies hashes and rejects foreign chunks', async () => {
  const key = await makeKey()
  const plainA0 = crypto.getRandomValues(new Uint8Array(300))
  const plainA1 = crypto.getRandomValues(new Uint8Array(300))
  const plainB0 = crypto.getRandomValues(new Uint8Array(300))

  const chunkA0 = await encryptChunk(plainA0, key, 0, { context: chunkContext(ID_A, 0) })
  const chunkA1 = await encryptChunk(plainA1, key, 1, { context: chunkContext(ID_A, 1) })
  const chunkB0 = await encryptChunk(plainB0, key, 0, { context: chunkContext(ID_B, 0) })

  const store = new Map([
    [`${ID_A}/0`, chunkA0],
    [`${ID_A}/1`, chunkA1],
    [`${ID_B}/0`, chunkB0],
  ])
  const fetchChunk = async (id, index) => store.get(`${id}/${index}`)

  const hashA0 = await sha256(chunkA0)
  const options = { context: { kind: 'chunk', id: ID_A }, cryptoVersion: 2 }

  // Happy path: correct contexts + recorded hash.
  const decrypted = []
  for await (const chunk of decryptFileChunks(ID_A, 2, key, fetchChunk, undefined, options)) {
    decrypted.push(chunk)
  }
  assert.deepEqual(new Uint8Array(decrypted[0]), plainA0)
  assert.deepEqual(new Uint8Array(decrypted[1]), plainA1)

  // Foreign file's chunk at the same index with no recorded hash → GCM rejects.
  const swapStore = new Map([[`${ID_A}/0`, chunkB0]])
  await assert.rejects(async () => {
    for await (const _ of decryptFileChunks(ID_A, 1, key, (id, i) => swapStore.get(`${id}/${i}`), undefined, options)) {
      void _
    }
  })

  // Tampered ciphertext with a recorded hash → IntegrityError before decrypt.
  const tampered = new Uint8Array(chunkA0.slice(0))
  tampered[tampered.length - 1] ^= 1
  const tamperStore = new Map([[`${ID_A}/0`, tampered]])
  await assert.rejects(
    () => consume(decryptFileChunks(ID_A, 1, key, (id, i) => tamperStore.get(`${id}/${i}`), undefined, {
      ...options,
      chunkSha256: [hashA0],
    })),
    (error) => error instanceof IntegrityError && error.code === 'CIPHERTEXT_HASH_MISMATCH',
  )

  // Hash metadata mismatch (recorded digest belongs to another chunk) → rejected.
  const hashB0 = await sha256(chunkB0)
  await assert.rejects(
    () => consume(decryptFileChunks(ID_A, 1, key, (id, i) => store.get(`${id}/${i}`), undefined, {
      ...options,
      chunkSha256: [hashB0],
    })),
    (error) => error instanceof IntegrityError,
  )

  // Legacy entries without hashes decrypt exactly as before (mode by context only).
  const legacyChunk = await encryptChunk(plainA0, key, 0)
  const legacyStore = new Map([[`${ID_A}/0`, legacyChunk]])
  const legacyOut = await consume(decryptFileChunks(
    ID_A, 1, key, (id, i) => legacyStore.get(`${id}/${i}`), undefined, {},
  ))
  assert.deepEqual(new Uint8Array(legacyOut[0]), plainA0)
})

// ---------------------------------------------------------------------------
// Hash verification helpers
// ---------------------------------------------------------------------------

test('ciphertext hash verification passes, fails, and skips cleanly', async () => {
  const bytes = crypto.getRandomValues(new Uint8Array(64))
  const expected = await sha256(bytes)

  assert.equal(await assertCiphertextHash(bytes, expected), expected)
  assert.equal(await assertCiphertextHash(bytes, expected.toUpperCase()), expected)
  assert.equal(await assertCiphertextHash(bytes, undefined), null)
  assert.equal(await assertCiphertextHash(bytes, ''), null)

  const foreignBytes = crypto.getRandomValues(new Uint8Array(64))
  const foreignHash = await sha256(foreignBytes)
  await assert.rejects(
    () => assertCiphertextHash(bytes, foreignHash, 'file x'),
    (error) => error instanceof IntegrityError && error.label === 'file x',
  )
  await assert.rejects(() => assertCiphertextHash(bytes, 'deadbeef', 'file x'), IntegrityError)
  assert.equal(hexEquals(expected, expected.toUpperCase()), true)
  assert.equal(hexEquals(expected, `${expected.slice(0, 63)}0`), false)
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function consume(asyncIterable) {
  const out = []
  for await (const item of asyncIterable) out.push(item)
  return out
}
