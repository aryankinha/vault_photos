import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'

if (!globalThis.crypto) globalThis.crypto = webcrypto

const {
  createEmptyManifest,
  parseManifest,
  serializeManifest,
  validateManifest,
} = await import('../src/schema/manifestSchema.js')
const { encodeManifest, parseManifestBytes } = await import('../src/storage/manifestCodec.js')

const DATE = '2026-01-01T00:00:00.000Z'
const HEX64_A = 'a'.repeat(64)
const HEX64_B = 'b'.repeat(64)

function baseEntry(overrides = {}) {
  return {
    id: '0123456789abcdef',
    name: 'photo.jpg',
    type: 'image',
    date_taken: DATE,
    size: 1234,
    duration: null,
    thumb_offset: 24,
    thumb_length: 8,
    ...overrides,
  }
}

function manifestWith(files, root = {}) {
  const manifest = createEmptyManifest(DATE)
  manifest.files = files
  Object.assign(manifest, root)
  return manifest
}

// ---------------------------------------------------------------------------
// Existing vaults keep parsing (no breakage)
// ---------------------------------------------------------------------------

test('legacy manifests and V3 entries still validate unchanged', () => {
  const legacy = baseEntry({ duration: 4.5, page_index: 1, chunked: true, chunk_size: 1024, chunk_count: 2 })
  assert.doesNotThrow(() => validateManifest(manifestWith([legacy])))

  // Bare old entry — no new fields at all.
  const bare = baseEntry()
  assert.doesNotThrow(() => validateManifest(manifestWith([bare])))
  assert.equal(bare.sha256, undefined)
  assert.equal(bare.crypto_version, undefined)

  const parsed = parseManifest(JSON.stringify(manifestWith([legacy])))
  assert.equal(parsed.files[0].chunk_count, 2)
})

// ---------------------------------------------------------------------------
// sha256 / chunk_sha256 integrity metadata
// ---------------------------------------------------------------------------

test('sha256 validation: well-formed accepted, malformed rejected', () => {
  assert.doesNotThrow(() => validateManifest(manifestWith([baseEntry({ sha256: HEX64_A })])))
  assert.doesNotThrow(() => validateManifest(manifestWith([baseEntry({ sha256: HEX64_A.toUpperCase() })])))
  // Absent (existing vaults) stays valid.
  assert.doesNotThrow(() => validateManifest(manifestWith([baseEntry()])))

  assert.throws(() => validateManifest(manifestWith([baseEntry({ sha256: 'deadbeef' })])), /sha256/)
  assert.throws(() => validateManifest(manifestWith([baseEntry({ sha256: `${'a'.repeat(63)}z` })])), /sha256/)
  assert.throws(() => validateManifest(manifestWith([baseEntry({ sha256: 42 })])), /sha256/)
  // Whole-file digest does not belong on a chunked entry.
  assert.throws(
    () => validateManifest(manifestWith([
      baseEntry({ chunked: true, chunk_size: 1024, chunk_count: 1, sha256: HEX64_A }),
    ])),
    /chunk_sha256/,
  )
})

test('chunk_sha256 must align exactly with chunk_count', () => {
  const ok = baseEntry({ chunked: true, chunk_size: 1024, chunk_count: 2, chunk_sha256: [HEX64_A, HEX64_B] })
  assert.doesNotThrow(() => validateManifest(manifestWith([ok])))

  const short = baseEntry({ chunked: true, chunk_size: 1024, chunk_count: 2, chunk_sha256: [HEX64_A] })
  assert.throws(() => validateManifest(manifestWith([short])), /must equal chunk_count/)

  const long = baseEntry({
    chunked: true, chunk_size: 1024, chunk_count: 1, chunk_sha256: [HEX64_A, HEX64_B],
  })
  assert.throws(() => validateManifest(manifestWith([long])), /must equal chunk_count/)

  const badHex = baseEntry({ chunked: true, chunk_size: 1024, chunk_count: 1, chunk_sha256: ['nope'] })
  assert.throws(() => validateManifest(manifestWith([badHex])), /64-char hex/)

  const notArray = baseEntry({ chunked: true, chunk_size: 1024, chunk_count: 1, chunk_sha256: HEX64_A })
  assert.throws(() => validateManifest(manifestWith([notArray])), /must be an array/)

  const unchunked = baseEntry({ chunk_sha256: [HEX64_A] })
  assert.throws(() => validateManifest(manifestWith([unchunked])), /only valid on chunked/)
})

// ---------------------------------------------------------------------------
// crypto_version metadata
// ---------------------------------------------------------------------------

test('crypto_version 1/2 accepted, unknown refused, v2 requires digests', () => {
  assert.doesNotThrow(() => validateManifest(manifestWith([baseEntry({ crypto_version: 1 })])))
  assert.doesNotThrow(() => validateManifest(manifestWith([baseEntry({ crypto_version: 2, sha256: HEX64_A })])))
  assert.doesNotThrow(() => validateManifest(manifestWith([
    baseEntry({ crypto_version: 2, chunked: true, chunk_size: 1024, chunk_count: 1, chunk_sha256: [HEX64_A] }),
  ])))

  // A mode we do not understand must never silently downgrade to legacy.
  assert.throws(() => validateManifest(manifestWith([baseEntry({ crypto_version: 3 })])), /Unsupported crypto_version/)
  assert.throws(() => validateManifest(manifestWith([baseEntry({ crypto_version: '2' })])), /Unsupported crypto_version/)

  // v2 without its integrity digest is inconsistent — viewers could not verify.
  assert.throws(() => validateManifest(manifestWith([baseEntry({ crypto_version: 2 })])), /must carry sha256/)
  assert.throws(
    () => validateManifest(manifestWith([
      baseEntry({ crypto_version: 2, chunked: true, chunk_size: 1024, chunk_count: 1 }),
    ])),
    /must carry chunk_sha256/,
  )
})

// ---------------------------------------------------------------------------
// Duplicate ids + revision
// ---------------------------------------------------------------------------

test('duplicate manifest file ids are rejected', () => {
  const a = baseEntry()
  const b = baseEntry({ name: 'other.jpg' }) // same id
  assert.throws(() => validateManifest(manifestWith([a, b])), /duplicate file id: 0123456789abcdef/)

  const distinct = [baseEntry(), baseEntry({ id: 'fedcba9876543210' })]
  assert.doesNotThrow(() => validateManifest(manifestWith(distinct)))

  // Three-way duplicate still caught.
  assert.throws(
    () => validateManifest(manifestWith([baseEntry(), baseEntry(), baseEntry({ id: 'fedcba9876543210' })])),
    /duplicate/,
  )
})

test('manifest revision must be a non-negative integer when present', () => {
  assert.doesNotThrow(() => validateManifest(manifestWith([], { revision: 0 })))
  assert.doesNotThrow(() => validateManifest(manifestWith([], { revision: 42 })))
  // Absent (existing vaults) stays valid.
  assert.doesNotThrow(() => validateManifest(manifestWith([])))

  assert.throws(() => validateManifest(manifestWith([], { revision: -1 })), /revision/)
  assert.throws(() => validateManifest(manifestWith([], { revision: 1.5 })), /revision/)
  assert.throws(() => validateManifest(manifestWith([], { revision: '2' })), /revision/)
})

// ---------------------------------------------------------------------------
// Round trips through codec with the new optional fields
// ---------------------------------------------------------------------------

test('manifest with integrity metadata round trips through serialize/parse', async () => {
  const manifest = manifestWith([
    baseEntry({ sha256: HEX64_A, crypto_version: 2 }),
    baseEntry({
      id: 'fedcba9876543210',
      name: 'clip.mp4',
      type: 'video',
      chunked: true,
      chunk_size: 8 * 1024 * 1024,
      chunk_count: 2,
      chunk_sha256: [HEX64_A, HEX64_B],
      crypto_version: 2,
    }),
  ], { revision: 7, bundle_pages: 1 })

  const text = serializeManifest(manifest)
  assert.deepEqual(parseManifest(text), manifest)

  const encoded = await encodeManifest(manifest)
  const decoded = await parseManifestBytes(encoded)
  assert.deepEqual(decoded, manifest)
  assert.equal(decoded.revision, 7)
})
