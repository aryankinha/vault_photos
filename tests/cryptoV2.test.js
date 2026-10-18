import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { argon2Sync } from 'node:crypto'
import { argon2id } from 'hash-wasm'
import { DEFAULT_KDF, deriveArgonOutput } from '../src/crypto/v2/argon2.js'
import { equalBytes, fromBase64, toBase64, toHex, utf8 } from '../src/crypto/v2/binary.js'
import { encodeSecret, decodeSecret, importSecretKey, importRecoveryKey, confirmSavedKey, confirmationGroups } from '../src/crypto/v2/secrets.js'
import { createKeyring, parseKeyring, keyringAAD, unlockWithSecrets, unlockWithRecovery, rewrapCredentials } from '../src/crypto/v2/keyring.js'
import { PURPOSES, encodeObjectContext, encryptObject, decryptObject, encryptObjectChunk, decryptObjectChunk } from '../src/crypto/v2/objects.js'

// All credentials in this file are synthetic test inputs, never user keys.
const PASSPHRASE = 'test only violet copper clouds'
const TEST_KDF = { alg: 'argon2id', m: 32768, t: 2, p: 1 }
const ID = '0123456789abcdef'
let vault
let recoveryKey
before(async () => {
  vault = await createKeyring(PASSPHRASE, { kdf: TEST_KDF })
  recoveryKey = await importRecoveryKey(decodeSecret(vault.recoveryKeyText, 'recovery'))
})
const context = (kind = 'file', rest = {}) => ({ vaultId: vault.keyring.vault_id, kind, ...(['file', 'chunk', 'cache'].includes(kind) ? { id: ID } : {}), ...(['bundle', 'chunk'].includes(kind) ? { index: 0 } : {}), ...rest })
const clone = () => structuredClone(vault.keyring)
const cannotUnlock = (promise) => assert.rejects(promise, (error) => error.name === 'CannotUnlockError' && error.message === 'Cannot unlock' && error.cause === undefined)
function mutateBase64(value) {
  const bytes = fromBase64(value, value.length === 16 ? 12 : 48)
  bytes[0] ^= 1
  return toBase64(bytes)
}

test('hash-wasm matches published Argon2id upstream vectors', async () => {
  // https://github.com/Daninet/hash-wasm/blob/master/test/argon2.test.ts
  for (const [password, salt, parallelism, iterations, memorySize, hashLength, expected] of [
    ['a', 'abcdefgh', 1, 2, 16, 16, 'f94aa50873d67fdd589d6774b87c0634'],
    ['text demo', '123456789', 2, 1, 64, 32, 'b3f9d902f65bd329cf0810c78b19c746b6f46fbb8243647a8942ab83b6850d47'],
  ]) {
    assert.equal(await argon2id({ password, salt, parallelism, iterations, memorySize, hashLength, outputType: 'hex' }), expected)
  }
})

test('independent native Argon2 reference passes the full RFC 9106 section 5.3 vector', () => {
  const output = argon2Sync('argon2id', {
    message: new Uint8Array(32).fill(1), nonce: new Uint8Array(16).fill(2),
    secret: new Uint8Array(8).fill(3), associatedData: new Uint8Array(12).fill(4),
    parallelism: 4, tagLength: 32, memory: 32, passes: 3,
  })
  assert.equal(toHex(output), '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659')
})

test('production WASM derivation matches independent native Argon2 at policy and default settings', async () => {
  for (const kdf of [TEST_KDF, DEFAULT_KDF]) {
    const salt = new Uint8Array(16).fill(7)
    const expected = argon2Sync('argon2id', { message: PASSPHRASE, nonce: salt,
      parallelism: kdf.p, tagLength: 32, memory: kdf.m, passes: kdf.t })
    const output = await deriveArgonOutput(PASSPHRASE, salt, kdf)
    assert.equal(equalBytes(output, expected), true)
    output.fill(0)
    expected.fill(0)
  }
})

test('Crockford key text round trips all bytes, aliases and grouping, with checksum rejection', () => {
  for (const kind of ['secret', 'recovery']) {
    for (const raw of [new Uint8Array(32), new Uint8Array(32).fill(255), Uint8Array.from({ length: 32 }, (_, i) => i)]) {
      const encoded = encodeSecret(raw, kind)
      assert.deepEqual(decodeSecret(encoded, kind), raw)
      assert.deepEqual(decodeSecret(encoded.toLowerCase().replace(/0/g, 'o').replace(/1/g, 'l'), kind), raw)
      const badCheck = `${encoded.slice(0, -1)}${encoded.at(-1) === '0' ? '1' : '0'}`
      assert.throws(() => decodeSecret(badCheck, kind))
      assert.equal(confirmSavedKey(encoded, confirmationGroups(encoded)), true)
      assert.equal(confirmSavedKey(encoded, 'WRONG'), false)
    }
  }
  assert.throws(() => decodeSecret(vault.secretKeyText, 'recovery'))
  assert.throws(() => decodeSecret(`${vault.secretKeyText}extra`, 'secret'))
})

test('raw key import consumes input and produces non-extractable device/recovery keys', async () => {
  for (const importer of [importSecretKey, importRecoveryKey]) {
    const raw = new Uint8Array(32).fill(17)
    const key = await importer(raw)
    assert.equal(raw.every((byte) => byte === 0), true)
    assert.equal(key.extractable, false)
    await assert.rejects(crypto.subtle.exportKey('raw', key))
  }
})

test('normal unlock and independent recovery open the same random master key', async () => {
  const normal = await unlockWithSecrets(JSON.stringify(vault.keyring), PASSPHRASE, vault.secretKey)
  const recovered = await unlockWithRecovery(vault.keyring, recoveryKey)
  const plaintext = utf8('synthetic photo bytes')
  const packed = await encryptObject(plaintext, normal.keys.file, context())
  assert.deepEqual(new Uint8Array(await decryptObject(packed, recovered.keys.file, context())), plaintext)
  for (const key of [normal.root, ...Object.values(normal.keys)]) {
    assert.equal(key.extractable, false)
    await assert.rejects(crypto.subtle.exportKey('raw', key))
  }
  assert.equal(normal.root.algorithm.name, 'HKDF')
  assert.deepEqual(Object.keys(normal.keys), PURPOSES)
})

test('NFKC-equivalent passphrases derive the same unlock key', async () => {
  const created = await createKeyring('test only café lantern cloud', { kdf: TEST_KDF })
  const normal = await unlockWithSecrets(created.keyring, 'test only cafe\u0301 lantern cloud', created.secretKey)
  assert.equal(normal.vaultId, created.keyring.vault_id)
})

test('wrong passphrase, wrong SK, and wrong RK have exactly the same public failure', async () => {
  await cannotUnlock(unlockWithSecrets(vault.keyring, 'wrong synthetic passphrase', vault.secretKey))
  await cannotUnlock(unlockWithSecrets(vault.keyring, PASSPHRASE, await importSecretKey(new Uint8Array(32).fill(31))))
  await cannotUnlock(unlockWithRecovery(vault.keyring, await importRecoveryKey(new Uint8Array(32).fill(31))))
})

for (const [name, mutate] of [
  ['format', (v) => { v.format = 'VPK1' }],
  ['vault id', (v) => { v.vault_id = 'f'.repeat(32) }],
  ['generation', (v) => { v.generation += 1 }],
  ['KDF algorithm', (v) => { v.kdf.alg = 'argon2i' }],
  ['KDF memory', (v) => { v.kdf.m = 65536 }],
  ['KDF iterations', (v) => { v.kdf.t = 3 }],
  ['KDF lanes', (v) => { v.kdf.p = 2 }],
  ['KDF salt', (v) => { v.kdf.salt = toBase64(new Uint8Array(16)) }],
]) {
  test(`tampered shared keyring field (${name}) fails normal unlock and recovery`, async () => {
    const changed = clone()
    mutate(changed)
    await cannotUnlock(unlockWithSecrets(changed, PASSPHRASE, vault.secretKey))
    await cannotUnlock(unlockWithRecovery(changed, recoveryKey))
  })
}

for (const type of ['pass+sk', 'recovery']) {
  for (const field of ['nonce', 'ct', 'type']) {
    test(`tampered ${type} wrap ${field} fails its unlock path`, async () => {
      const changed = clone()
      const wrap = changed.wraps.find((item) => item.type === type)
      wrap[field] = field === 'type' ? 'unknown' : mutateBase64(wrap[field])
      await cannotUnlock(type === 'pass+sk'
        ? unlockWithSecrets(changed, PASSPHRASE, vault.secretKey)
        : unlockWithRecovery(changed, recoveryKey))
    })
  }
}

test('schema, downgrade and resource-abuse inputs are rejected before derivation', async () => {
  for (const mutate of [
    (v) => { v.extra = 'unknown field' }, (v) => { v.kdf.extra = 1 },
    (v) => { v.wraps[0].extra = 1 }, (v) => { v.wraps.push(v.wraps[0]) },
    (v) => { v.wraps[1].type = v.wraps[0].type }, (v) => { v.wraps.reverse(); v.wraps[0].ct = '!' },
    (v) => { v.generation = 0 }, (v) => { v.generation = 2 ** 32 },
    (v) => { v.kdf.m = 32767 }, (v) => { v.kdf.t = 1 },
    (v) => { v.kdf.p = 0 }, (v) => { v.kdf.m = 131073 },
    (v) => { v.kdf.t = 7 }, (v) => { v.kdf.p = 5 },
    (v) => { v.kdf.m = '65536' }, (v) => { v.kdf.salt = 'invalid' },
  ]) {
    const changed = clone()
    mutate(changed)
    assert.throws(() => parseKeyring(changed), { message: 'Cannot unlock' })
    await cannotUnlock(unlockWithSecrets(changed, PASSPHRASE, vault.secretKey))
  }
  assert.throws(() => parseKeyring(' '.repeat(8193)), { message: 'Cannot unlock' })
  assert.throws(() => parseKeyring('{broken json'), { message: 'Cannot unlock' })
})

test('all five purposes have authenticated contexts and distinct encryption keys', async () => {
  for (const kind of PURPOSES) {
    const ctx = context(kind)
    const packed = await encryptObject(utf8('same synthetic bytes'), vault.session.keys[kind], ctx)
    assert.equal(new TextDecoder().decode(await decryptObject(packed, vault.session.keys[kind], ctx)), 'same synthetic bytes')
    for (const other of PURPOSES.filter((purpose) => purpose !== kind)) {
      await assert.rejects(decryptObject(packed, vault.session.keys[other], ctx))
    }
    await assert.rejects(decryptObject(packed, vault.session.keys[kind], { ...ctx, vaultId: 'f'.repeat(32) }))
  }
  const packed = await encryptObject(utf8('test'), vault.session.keys.file, context())
  await assert.rejects(decryptObject(packed, vault.session.keys.file, context('cache')))
  await assert.rejects(decryptObject(packed, vault.session.keys.file, context('file', { id: 'f'.repeat(16) })))
})

test('chunks authenticate index in header and AAD, and never accept a packed-object fallback', async () => {
  const packed = await encryptObjectChunk(utf8('test chunk'), vault.session.keys.chunk, context('chunk'))
  assert.equal(new TextDecoder().decode(await decryptObjectChunk(packed, vault.session.keys.chunk, context('chunk'))), 'test chunk')
  await assert.rejects(decryptObjectChunk(packed, vault.session.keys.chunk, context('chunk', { index: 1 })))
  const tampered = new Uint8Array(packed.slice(0))
  tampered[0] ^= 1
  await assert.rejects(decryptObjectChunk(tampered, vault.session.keys.chunk, context('chunk')))
  await assert.rejects(decryptObject(packed, vault.session.keys.chunk, context('chunk')))
  assert.throws(() => encodeObjectContext({ kind: 'file', id: ID }))
  assert.throws(() => encodeObjectContext(context('manifest', { id: ID })))
  assert.throws(() => encodeObjectContext(context('file', { index: 0 })))
  assert.throws(() => encodeObjectContext(context('chunk', { index: 2 ** 32 })))
})

test('fresh encryption uses a new nonce and non-extractable keys survive structured clone', async () => {
  const key = structuredClone(vault.session.keys.file)
  assert.equal(key.extractable, false)
  const a = await encryptObject(utf8('test'), key, context())
  const b = await encryptObject(utf8('test'), key, context())
  assert.equal(equalBytes(new Uint8Array(a).subarray(0, 12), new Uint8Array(b).subarray(0, 12)), false)
})

test('password rewrap requires RK, increments generation and preserves encrypted media', async () => {
  const packed = await encryptObject(utf8('media survives rewrap'), vault.session.keys.file, context())
  const next = await rewrapCredentials(vault.keyring, recoveryKey, 'new synthetic passphrase violet', { secretKey: vault.secretKey, kdf: TEST_KDF })
  assert.equal(next.keyring.generation, 2)
  assert.equal(next.keyring.vault_id, vault.keyring.vault_id)
  assert.equal(next.secretKeyText, undefined)
  const unlocked = await unlockWithSecrets(next.keyring, 'new synthetic passphrase violet', vault.secretKey)
  assert.equal(new TextDecoder().decode(await decryptObject(packed, unlocked.keys.file, context())), 'media survives rewrap')
  await unlockWithRecovery(next.keyring, recoveryKey)
  await cannotUnlock(unlockWithSecrets(next.keyring, PASSPHRASE, vault.secretKey))
  await cannotUnlock(rewrapCredentials(vault.keyring, null, PASSPHRASE, { secretKey: vault.secretKey, kdf: TEST_KDF }))
})

test('recovery can replace both secrets without the old passphrase or SK', async () => {
  const next = await rewrapCredentials(vault.keyring, recoveryKey, 'new recovered synthetic passphrase', { rotateSecret: true, rotateRecovery: true, kdf: TEST_KDF })
  assert.ok(next.secretKeyText)
  assert.ok(next.recoveryKeyText)
  await unlockWithSecrets(next.keyring, 'new recovered synthetic passphrase', next.secretKey)
  const nextRecovery = await importRecoveryKey(decodeSecret(next.recoveryKeyText, 'recovery'))
  await unlockWithRecovery(next.keyring, nextRecovery)
  await cannotUnlock(unlockWithRecovery(next.keyring, recoveryKey))
})

test('Secret Key rotation replaces only that unlock secret and preserves recovery and media', async () => {
  const packed = await encryptObject(utf8('unchanged media'), vault.session.keys.file, context())
  const next = await rewrapCredentials(vault.keyring, recoveryKey, PASSPHRASE, { rotateSecret: true, kdf: TEST_KDF })
  assert.ok(next.secretKeyText)
  assert.equal(next.recoveryKeyText, undefined)
  await cannotUnlock(unlockWithSecrets(next.keyring, PASSPHRASE, vault.secretKey))
  const unlocked = await unlockWithSecrets(next.keyring, PASSPHRASE, next.secretKey)
  assert.equal(new TextDecoder().decode(await decryptObject(packed, unlocked.keys.file, context())), 'unchanged media')
  await unlockWithRecovery(next.keyring, recoveryKey)
})

test('creation enforces normalized minimum length and session roots are independent between vaults', async () => {
  await assert.rejects(createKeyring('too short', { kdf: TEST_KDF }), /at least 12/)
  const other = await createKeyring(PASSPHRASE, { kdf: TEST_KDF })
  assert.notEqual(other.keyring.vault_id, vault.keyring.vault_id)
  const packed = await encryptObject(utf8('vault one'), vault.session.keys.file, context())
  await assert.rejects(decryptObject(packed, other.session.keys.file, context()))
  await assert.rejects(decryptObject(packed, other.session.keys.file, { ...context(), vaultId: other.keyring.vault_id }))
})

test('canonical AAD is deterministic and changes with shared KDF and wrap type', () => {
  assert.deepEqual(keyringAAD(vault.keyring, 'pass+sk'), keyringAAD(clone(), 'pass+sk'))
  assert.equal(equalBytes(keyringAAD(vault.keyring, 'pass+sk'), keyringAAD(vault.keyring, 'recovery')), false)
  assert.equal(new TextDecoder().decode(encodeObjectContext(context()).subarray(4, 8)), 'VPC3')
})
