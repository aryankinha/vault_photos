import { createKeyring, parseKeyring, unlockWithSecrets, unlockWithRecovery, rewrapCredentials } from '../crypto/v2/keyring.js'
import { decodeSecret, importSecretKey, importRecoveryKey } from '../crypto/v2/secrets.js'
import { generateApiToken, parseSecretKeyFile, serializeSecretKeyFile } from '../crypto/v2/keyFile.js'
import { toHex, utf8 } from '../crypto/v2/binary.js'
import { rememberSecretKey } from '../session/deviceKeys.js'
import { validateNewPassphrase } from '../crypto/passphrasePolicy.js'

function requireNewPassphrase(passphrase) {
  const policy = validateNewPassphrase(typeof passphrase === 'string' ? passphrase.normalize('NFKC') : '')
  if (!policy.ok) throw new Error(policy.errors[0])
}

export function assertCurrentSession(value, session) {
  const keyring = parseKeyring(value)
  if (keyring.vault_id !== session.vaultId || keyring.generation !== session.generation) {
    throw new Error('Vault changed elsewhere. Lock and unlock again before changing keys.')
  }
  return keyring
}

export async function prepareVaultCreation(passphrase) {
  requireNewPassphrase(passphrase)
  const created = await createKeyring(passphrase)
  const apiToken = generateApiToken()
  return {
    ...created, apiToken, operation: 'create',
    keyFile: serializeSecretKeyFile(created.keyring.vault_id, created.secretKeyText, apiToken),
    apiVerifier: toHex(await crypto.subtle.digest('SHA-256', utf8(apiToken))),
  }
}

export async function unlockVaultWithSecret({ keyring: value, passphrase, keyText, keyFile, deviceKey, adapter }) {
  const keyring = parseKeyring(value)
  let secretKey = deviceKey
  let apiToken
  try {
    if (keyFile) {
      const file = parseSecretKeyFile(keyFile, keyring.vault_id)
      keyText = file.secret_key
      apiToken = file.api_token
    }
    if (keyText) secretKey = await importSecretKey(decodeSecret(keyText, 'secret'))
    const session = await unlockWithSecrets(keyring, passphrase, secretKey)
    await adapter.verifyUnlock(session, apiToken)
    return { ...session, secretKey }
  } catch { throw new Error('Cannot unlock') }
}

/** Recovery verification returns only a temporary, unactivated session. */
export async function verifyRecovery({ keyring, recoveryText, adapter }) {
  try {
    const recoveryKey = await importRecoveryKey(decodeSecret(recoveryText, 'recovery'))
    const session = await unlockWithRecovery(keyring, recoveryKey)
    await adapter.verifyUnlock(session)
    return { recoveryKey, session }
  } catch { throw new Error('Cannot unlock') }
}

export async function prepareCredentialChange({ keyring, recoveryKey, passphrase, secretKey, mode, apiToken }) {
  requireNewPassphrase(passphrase)
  if (!['passphrase', 'secret', 'recover'].includes(mode)) throw new Error('Invalid credential operation')
  const next = await rewrapCredentials(keyring, recoveryKey, passphrase, {
    secretKey, rotateSecret: mode !== 'passphrase', rotateRecovery: mode === 'recover',
  })
  return {
    ...next, apiToken, operation: 'replace',
    // Re-export the SK only when a new one was generated. Password changes
    // retain the existing device key; its raw bytes cannot be exported.
    keyFile: next.secretKeyText ? serializeSecretKeyFile(next.keyring.vault_id, next.secretKeyText, apiToken) : null,
  }
}

export async function commitPreparedVault(candidate, { adapter, remember = true }) {
  if (candidate.operation === 'create') await adapter.createVault(candidate)
  else await adapter.replaceKeyring(candidate)
  // A failed browser write cannot turn an applied remote transaction into a
  // fake creation failure or cause a second vault to be generated.
  let deviceWarning = ''
  if (remember) {
    try { await rememberSecretKey(candidate.keyring.vault_id, candidate.secretKey) }
    catch { deviceWarning = 'This browser could not remember your Secret Key. Keep your key file: you must import it next time.' }
  }
  return { ...candidate.session, secretKey: candidate.secretKey, deviceWarning }
}
