import 'fake-indexeddb/auto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { openDB } from 'idb'
import { prepareVaultCreation, unlockVaultWithSecret, verifyRecovery, prepareCredentialChange, commitPreparedVault, assertCurrentSession } from '../src/services/vaultLifecycle.js'
import { rememberSecretKey, getRememberedSecretKey, forgetSecretKey } from '../src/session/deviceKeys.js'
import { parseSecretKeyFile, serializeSecretKeyFile, secretKeyFilename, generateApiToken } from '../src/crypto/v2/keyFile.js'
import { encryptObject, decryptObject } from '../src/crypto/v2/objects.js'
import { fromHex, toHex, utf8 } from '../src/crypto/v2/binary.js'
import { shouldAutoLock, idleMinutes, HIDDEN_LOCK_MS } from '../src/utils/idlePolicy.js'

const passphrase = 'synthetic lifecycle violet candle'

function storageDouble() {
  let manifest
  let keyring
  let commits = 0
  let apiToken
  return {
    get commits() { return commits },
    getApiToken: () => apiToken,
    loadKeyring: async () => keyring,
    async createVault(candidate) {
      if (keyring) throw new Error('Vault exists')
      keyring = structuredClone(candidate.keyring)
      apiToken = candidate.apiToken
      manifest = await encryptObject(utf8('synthetic encrypted manifest'), candidate.session.keys.manifest, { kind: 'manifest', vaultId: keyring.vault_id })
      commits += 1
    },
    async replaceKeyring(candidate) {
      assert.equal(candidate.keyring.generation, keyring.generation + 1)
      keyring = structuredClone(candidate.keyring)
      commits += 1
    },
    async verifyUnlock(session) {
      const plain = await decryptObject(manifest, session.keys.manifest, { kind: 'manifest', vaultId: keyring.vault_id })
      assert.equal(new TextDecoder().decode(plain), 'synthetic encrypted manifest')
    },
  }
}

test('creation has no remote side effects until commit and key file excludes RK/VMK/passphrase', async () => {
  const adapter = storageDouble()
  const prepared = await prepareVaultCreation(passphrase)
  assert.equal(adapter.commits, 0)
  const file = parseSecretKeyFile(prepared.keyFile, prepared.keyring.vault_id)
  assert.deepEqual(Object.keys(file), ['format', 'vault_id', 'secret_key', 'api_token'])
  assert.equal(prepared.keyFile.includes(passphrase), false)
  assert.equal(prepared.keyFile.includes(prepared.recoveryKeyText), false)
  assert.equal(prepared.apiVerifier, toHex(await crypto.subtle.digest('SHA-256', utf8(file.api_token))))
  assert.equal(prepared.apiToken.length, 43)
  assert.equal(secretKeyFilename(file.vault_id), `VaultPhotos-SecretKey-${file.vault_id.slice(0, 8)}.vpkey`)
  const session = await commitPreparedVault(prepared, { adapter, remember: false })
  assert.equal(adapter.commits, 1)
  assert.equal(session.vaultId, prepared.keyring.vault_id)
  await unlockVaultWithSecret({ keyring: await adapter.loadKeyring(), passphrase, keyFile: prepared.keyFile, adapter })
})

test('trusted-device storage contains only a non-extractable HMAC key and can be forgotten', async () => {
  const prepared = await prepareVaultCreation(passphrase)
  const id = prepared.keyring.vault_id
  await rememberSecretKey(id, prepared.secretKey)
  const key = await getRememberedSecretKey(id)
  assert.equal(key.algorithm.name, 'HMAC')
  assert.equal(key.extractable, false)
  assert.deepEqual(key.usages, ['sign'])
  await assert.rejects(crypto.subtle.exportKey('raw', key))
  const database = await openDB('vaultphotos-device', 1)
  const stored = await database.get('secretKeys', id)
  assert.equal(stored.constructor.name, 'CryptoKey')
  const message = utf8('test device key identity')
  assert.deepEqual(await crypto.subtle.sign('HMAC', stored, message), await crypto.subtle.sign('HMAC', prepared.secretKey, message))
  database.close()
  await forgetSecretKey(id)
  assert.equal(await getRememberedSecretKey(id), null)
  await assert.rejects(rememberSecretKey(id, prepared.session.root), /Invalid device/)
})

test('key file rejects wrong vault, extra data, malformed SK, invalid token and oversized input', async () => {
  const prepared = await prepareVaultCreation(passphrase)
  const file = JSON.parse(prepared.keyFile)
  assert.throws(() => parseSecretKeyFile(prepared.keyFile, 'f'.repeat(32)), /different vault/)
  for (const mutation of [
    { ...file, format: 'v1' }, { ...file, recovery_key: 'not allowed' },
    { ...file, secret_key: 'invalid' }, { ...file, api_token: 'human chosen' },
  ]) assert.throws(() => parseSecretKeyFile(JSON.stringify(mutation)))
  assert.throws(() => parseSecretKeyFile(' '.repeat(8193)))
  assert.notEqual(generateApiToken(), generateApiToken())
  assert.equal(fromHex(file.vault_id, 16).length, 16)
})

test('unlock verifies remote encrypted metadata before remembering an imported key', async () => {
  const adapter = storageDouble()
  const prepared = await prepareVaultCreation(passphrase)
  await commitPreparedVault(prepared, { adapter, remember: false })
  await assert.rejects(unlockVaultWithSecret({ keyring: prepared.keyring, passphrase,
    keyFile: prepared.keyFile, adapter: { verifyUnlock: async () => { throw new Error('Corrupt manifest') } } }), { message: 'Cannot unlock' })
  assert.equal(await getRememberedSecretKey(prepared.keyring.vault_id), null)
  const unlocked = await unlockVaultWithSecret({ keyring: prepared.keyring, passphrase, keyText: prepared.secretKeyText, adapter })
  assert.equal(unlocked.root.extractable, false)
})

test('password change, SK rotation and full recovery preserve media and update every credential path', async () => {
  const adapter = storageDouble()
  const prepared = await prepareVaultCreation(passphrase)
  let session = await commitPreparedVault(prepared, { adapter, remember: false })
  const recovery = await verifyRecovery({ keyring: prepared.keyring, recoveryText: prepared.recoveryKeyText, adapter })
  const changed = await prepareCredentialChange({ keyring: prepared.keyring, recoveryKey: recovery.recoveryKey,
    passphrase: 'synthetic changed passphrase candle', secretKey: session.secretKey, mode: 'passphrase', apiToken: prepared.apiToken })
  assert.equal(changed.keyFile, null)
  session = await commitPreparedVault(changed, { adapter, remember: false })
  await adapter.verifyUnlock(session)
  const rotated = await prepareCredentialChange({ keyring: changed.keyring, recoveryKey: recovery.recoveryKey,
    passphrase: 'synthetic changed passphrase candle', secretKey: session.secretKey, mode: 'secret', apiToken: prepared.apiToken })
  assert.equal(parseSecretKeyFile(rotated.keyFile).api_token, prepared.apiToken)
  session = await commitPreparedVault(rotated, { adapter, remember: false })
  await adapter.verifyUnlock(session)
  const recovered = await prepareCredentialChange({ keyring: rotated.keyring, recoveryKey: recovery.recoveryKey,
    passphrase: 'synthetic recovered passphrase candle', mode: 'recover', apiToken: prepared.apiToken })
  assert.ok(recovered.secretKeyText)
  assert.ok(recovered.recoveryKeyText)
  session = await commitPreparedVault(recovered, { adapter, remember: false })
  await adapter.verifyUnlock(session)
  assert.equal(adapter.commits, 4)
  await assert.rejects(verifyRecovery({ keyring: recovered.keyring, recoveryText: prepared.recoveryKeyText, adapter }), { message: 'Cannot unlock' })
  assert.doesNotThrow(() => serializeSecretKeyFile(recovered.keyring.vault_id, recovered.secretKeyText, prepared.apiToken))
})

test('auto-lock policy uses five-minute default and a ten-minute hidden maximum', () => {
  assert.equal(idleMinutes(null), 5)
  assert.equal(idleMinutes('30'), 30)
  assert.equal(idleMinutes('0'), 5)
  assert.equal(idleMinutes('NaN'), 5)
  assert.equal(shouldAutoLock({ lastActivity: 0, hiddenAt: null, now: 299999 }), false)
  assert.equal(shouldAutoLock({ lastActivity: 0, hiddenAt: null, now: 300000 }), true)
  assert.equal(shouldAutoLock({ lastActivity: 0, hiddenAt: 1, now: HIDDEN_LOCK_MS, minutes: 60 }), false)
  assert.equal(shouldAutoLock({ lastActivity: 0, hiddenAt: 1, now: HIDDEN_LOCK_MS + 1, minutes: 60 }), true)
  assert.equal(shouldAutoLock({ lastActivity: 300000, hiddenAt: null, now: 599999 }), false)
})

test('credential changes refuse stale sessions and a failed commit does not replace a device key', async () => {
  const adapter = storageDouble()
  const prepared = await prepareVaultCreation(passphrase)
  const session = await commitPreparedVault(prepared, { adapter })
  assertCurrentSession(prepared.keyring, session)
  assert.throws(() => assertCurrentSession({ ...prepared.keyring, generation: 2 }, session), /changed elsewhere/)
  const recovery = await verifyRecovery({ keyring: prepared.keyring, recoveryText: prepared.recoveryKeyText, adapter })
  const changed = await prepareCredentialChange({ keyring: prepared.keyring, recoveryKey: recovery.recoveryKey,
    passphrase, mode: 'secret', apiToken: prepared.apiToken })
  await assert.rejects(commitPreparedVault(changed, { adapter: { replaceKeyring: async () => { throw new Error('VAULT_STALE') } } }), /VAULT_STALE/)
  const remembered = await getRememberedSecretKey(prepared.keyring.vault_id)
  await unlockVaultWithSecret({ keyring: prepared.keyring, passphrase, deviceKey: remembered, adapter })
  await forgetSecretKey(prepared.keyring.vault_id)
})
