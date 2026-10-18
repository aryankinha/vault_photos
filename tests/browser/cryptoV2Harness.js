import { createKeyring, unlockWithSecrets, unlockWithRecovery } from '../../src/crypto/v2/keyring.js'
import { decodeSecret, importRecoveryKey, importSecretKey } from '../../src/crypto/v2/secrets.js'
import { PURPOSES } from '../../src/crypto/v2/objects.js'
import { equalBytes, utf8 } from '../../src/crypto/v2/binary.js'
import { encryptV2WithPool, decryptV2WithPool, shutdownPool } from '../../src/workers/cryptoWorkerPool.js'

async function run() {
  let heartbeats = 0
  const timer = setInterval(() => { heartbeats += 1 }, 10)
  try {
    const started = performance.now()
    const created = await createKeyring('synthetic browser test passphrase')
    const creationMs = Math.round(performance.now() - started)
    const derivationHeartbeats = heartbeats
    if (derivationHeartbeats < 1) throw new Error('No UI heartbeat during key derivation')
    const imported = await importSecretKey(decodeSecret(created.secretKeyText, 'secret'))
    const normal = await unlockWithSecrets(created.keyring, 'synthetic browser test passphrase', imported)
    const rk = await importRecoveryKey(decodeSecret(created.recoveryKeyText, 'recovery'))
    const recovered = await unlockWithRecovery(created.keyring, rk)
    for (const purpose of PURPOSES) {
      const context = {
        vaultId: normal.vaultId, kind: purpose,
        ...(['file', 'chunk', 'cache'].includes(purpose) ? { id: '0123456789abcdef' } : {}),
        ...(['chunk', 'bundle'].includes(purpose) ? { index: 0 } : {}),
      }
      const expected = utf8('synthetic worker test bytes')
      const ciphertext = await encryptV2WithPool(expected.slice(), normal.keys, context)
      const plaintext = await decryptV2WithPool(ciphertext, recovered.keys, context)
      if (!equalBytes(new Uint8Array(plaintext), expected)) throw new Error(`Worker ${purpose} round trip failed`)
      if (normal.keys[purpose].extractable) throw new Error('Extractable purpose key')
    }
    let rejected = false
    try { await unlockWithSecrets(created.keyring, 'wrong test passphrase', imported) }
    catch (error) { rejected = error.message === 'Cannot unlock' }
    if (!rejected) throw new Error('Wrong passphrase did not produce a generic error')
    return { passed: true, purposes: PURPOSES.length, recovery: true,
      nonExtractableWorkerClones: true, genericWrongPassphrase: true,
      creationMs, uiHeartbeatsDuringCreation: derivationHeartbeats }
  } finally { clearInterval(timer); shutdownPool() }
}

run().then((result) => { document.querySelector('#result').textContent = JSON.stringify(result, null, 2) })
  .catch((error) => { document.querySelector('#result').textContent = JSON.stringify({ passed: false, error: error.message }) })
