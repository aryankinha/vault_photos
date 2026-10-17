import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'

if (!globalThis.crypto) globalThis.crypto = webcrypto

const {
  MIN_NEW_PASSPHRASE_LENGTH,
  estimatePassphraseStrength,
  isCommonPassphrase,
  normalizeForBlocklist,
  validateNewPassphrase,
} = await import('../src/crypto/passphrasePolicy.js')
const {
  DEFAULT_KDF_PARAMS,
  decodeKdfParamsSidecar,
  encodeKdfParamsSidecar,
  validateKdfParams,
} = await import('../src/crypto/kdfParams.js')
const {
  checkManifestRevision,
  createMemoryStorage,
  resetRevisionHighWater,
  vaultIdentityFromSalt,
} = await import('../src/crypto/rollback.js')

// ---------------------------------------------------------------------------
// Passphrase policy — NEW vaults only (never applied to existing unlocks)
// ---------------------------------------------------------------------------

test('new passphrase policy enforces length and common-password rejection', () => {
  assert.equal(MIN_NEW_PASSPHRASE_LENGTH, 12)

  assert.equal(validateNewPassphrase('short').ok, false)
  assert.equal(validateNewPassphrase('123456789').ok, false)
  assert.equal(validateNewPassphrase('abcdefghijk').ok, false) // 11 chars

  assert.equal(validateNewPassphrase('password').ok, false)
  assert.match(validateNewPassphrase('password').errors.join(' '), /common-password/)

  // Leetspeak + trailing padding normalization catches disguised classics.
  assert.equal(normalizeForBlocklist('P@ssw0rd1234!'), 'password')
  assert.equal(validateNewPassphrase('P@ssw0rd1234!').ok, false)
  assert.equal(validateNewPassphrase('qwertyuiop1234').ok, false)

  // Patterns: repeated char / ascending run.
  assert.equal(validateNewPassphrase('aaaaaaaaaaaaaaaa').ok, false)
  assert.equal(validateNewPassphrase('abcdefghijklmn').ok, false)

  // A good passphrase passes with no errors.
  const good = validateNewPassphrase('correct horse battery staple')
  assert.equal(good.ok, true)
  assert.deepEqual(good.errors, [])

  assert.equal(isCommonPassphrase('trustno1trustno1'), true)
  assert.equal(isCommonPassphrase('correct horse battery staple'), false)
})

test('entropy guidance is heuristic-only and covers the clear-cut cases', () => {
  assert.equal(estimatePassphraseStrength('').level, 'weak')
  assert.equal(estimatePassphraseStrength('aaaaaaaaaaaa').level, 'weak')

  const diceware = estimatePassphraseStrength('correct horse battery staple')
  assert.equal(diceware.level, 'strong')
  assert.ok(diceware.entropyBits >= 50)
  assert.ok(diceware.suggestions.length > 0)

  // Never throws on odd input.
  const unicode = estimatePassphraseStrength('🔥🔥🔥🔥')
  assert.equal(typeof unicode.entropyBits, 'number')
  assert.ok(['weak', 'fair', 'strong'].includes(unicode.level))
})

// ---------------------------------------------------------------------------
// KDF params sidecar (deferred worker route — codec only for now)
// ---------------------------------------------------------------------------

test('KDF params sidecar round trips and refuses unknown parameters', () => {
  assert.deepEqual({ ...DEFAULT_KDF_PARAMS }, {
    alg: 'argon2id',
    argon2Version: 19,
    time: 3,
    memKiB: 65536,
    parallelism: 4,
    hashLen: 32,
  })

  const sidecar = encodeKdfParamsSidecar()
  const decoded = decodeKdfParamsSidecar(sidecar)
  assert.deepEqual({ ...decoded }, { ...DEFAULT_KDF_PARAMS })

  // Bytes form decodes too.
  const bytes = new TextEncoder().encode(sidecar)
  assert.deepEqual({ ...decodeKdfParamsSidecar(bytes) }, { ...DEFAULT_KDF_PARAMS })

  // Custom-but-valid params survive.
  const custom = encodeKdfParamsSidecar({ ...DEFAULT_KDF_PARAMS, time: 4 })
  assert.equal(decodeKdfParamsSidecar(custom).time, 4)

  assert.throws(() => decodeKdfParamsSidecar('not json'), /valid JSON/)
  assert.throws(() => decodeKdfParamsSidecar('{"nope":1}'), /sidecar/)
  assert.throws(() => validateKdfParams({ ...DEFAULT_KDF_PARAMS, alg: 'scrypt' }), RangeError)
  assert.throws(() => validateKdfParams({ ...DEFAULT_KDF_PARAMS, argon2Version: 16 }), RangeError)
  assert.throws(() => validateKdfParams({ ...DEFAULT_KDF_PARAMS, time: 0 }), RangeError)
  assert.throws(() => validateKdfParams({ ...DEFAULT_KDF_PARAMS, memKiB: 1024 }), RangeError)
  assert.throws(() => validateKdfParams(null), TypeError)
})

// ---------------------------------------------------------------------------
// Rollback detection — scoped per vault identity (salt digest), never global
// ---------------------------------------------------------------------------

const SALT_A = new Uint8Array(16).fill(1)
const SALT_B = new Uint8Array(16).fill(2)

test('vault identity is a stable, salt-scoped digest', async () => {
  const idA1 = await vaultIdentityFromSalt(SALT_A)
  const idA2 = await vaultIdentityFromSalt(new Uint8Array(SALT_A))
  const idB = await vaultIdentityFromSalt(SALT_B)

  assert.equal(idA1, idA2)
  assert.match(idA1, /^[0-9a-f]{64}$/)
  assert.notEqual(idA1, idB)
  // The digest must not reveal the salt.
  assert.notEqual(idA1, [...SALT_A].map((b) => b.toString(16).padStart(2, '0')).join(''))
  await assert.rejects(() => vaultIdentityFromSalt(new Uint8Array(0)), TypeError)
})

test('revision high-water mark flags rollback and stays per-vault', async () => {
  const storage = createMemoryStorage()

  const first = await checkManifestRevision(SALT_A, 0, { storage })
  assert.equal(first.firstSighting, true)
  assert.equal(first.rolledBack, false)
  assert.equal(first.previous, undefined)

  const advance = await checkManifestRevision(SALT_A, 5, { storage })
  assert.equal(advance.firstSighting, false)
  assert.equal(advance.rolledBack, false)
  assert.equal(advance.previous, 0)

  const equal = await checkManifestRevision(SALT_A, 5, { storage })
  assert.equal(equal.rolledBack, false)

  // An attacker restoring an older legitimate manifest (revision 3) → flagged.
  const rollback = await checkManifestRevision(SALT_A, 3, { storage })
  assert.equal(rollback.rolledBack, true)
  assert.equal(rollback.previous, 5)
  // The high-water mark must NOT regress on a rolled-back observation.
  const stillFlagged = await checkManifestRevision(SALT_A, 4, { storage })
  assert.equal(stillFlagged.rolledBack, true)

  // A later legit manifest recovers.
  const recovered = await checkManifestRevision(SALT_A, 6, { storage })
  assert.equal(recovered.rolledBack, false)

  // Vault B shares nothing with vault A — its low revision is not a rollback.
  const vaultB = await checkManifestRevision(SALT_B, 1, { storage })
  assert.equal(vaultB.rolledBack, false)
  assert.notEqual(vaultB.vaultId, first.vaultId)
  // …and vault A's history is untouched by vault B.
  const backToA = await checkManifestRevision(SALT_A, 2, { storage })
  assert.equal(backToA.rolledBack, true)
  assert.equal(backToA.previous, 6)

  // Reset only affects the addressed vault.
  await resetRevisionHighWater(SALT_A, { storage })
  const fresh = await checkManifestRevision(SALT_A, 1, { storage })
  assert.equal(fresh.firstSighting, true)
  assert.equal(fresh.rolledBack, false)
})

test('revision inputs are validated strictly', async () => {
  const storage = createMemoryStorage()
  await assert.rejects(() => checkManifestRevision(SALT_A, -1, { storage }), TypeError)
  await assert.rejects(() => checkManifestRevision(SALT_A, 1.5, { storage }), TypeError)
  await assert.rejects(() => checkManifestRevision(SALT_A, '3', { storage }), TypeError)
})
