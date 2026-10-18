import { DEFAULT_KDF, deriveArgonOutput, validateKdfParameters } from './argon2.js'
import { concat, exactFields, fromBase64, fromHex, lengthPrefixed, toBase64, toHex, uint32, uint64, utf8 } from './binary.js'
import { derivePurposeKeys } from './objects.js'
import { encodeSecret, importRecoveryKey, importSecretKey } from './secrets.js'

export class CannotUnlockError extends Error {
  constructor() { super('Cannot unlock'); this.name = 'CannotUnlockError' }
}

function validateCommon(keyring) {
  if (keyring.format !== 'VPK2') throw new Error('Invalid format')
  fromHex(keyring.vault_id, 16)
  if (!Number.isInteger(keyring.generation) || keyring.generation < 1) throw new Error('Invalid generation')
  uint32(keyring.generation)
  exactFields(keyring.kdf, ['alg', 'm', 't', 'p', 'salt'])
  validateKdfParameters(keyring.kdf)
  fromBase64(keyring.kdf.salt, 16)
}

/** Validate and snapshot untrusted data before any asynchronous crypto work. */
export function parseKeyring(value) {
  try {
    if (typeof value === 'string') {
      if (value.length > 8192) throw new Error('Oversized keyring')
      value = JSON.parse(value)
    }
    exactFields(value, ['format', 'vault_id', 'generation', 'kdf', 'wraps'])
    validateCommon(value)
    if (!Array.isArray(value.wraps) || value.wraps.length !== 2) throw new Error('Invalid wraps')
    const types = new Set()
    for (const wrap of value.wraps) {
      exactFields(wrap, ['type', 'nonce', 'ct'])
      if (!['pass+sk', 'recovery'].includes(wrap.type) || types.has(wrap.type)) throw new Error('Invalid wrap type')
      types.add(wrap.type)
      fromBase64(wrap.nonce, 12)
      fromBase64(wrap.ct, 48)
    }
    return {
      format: value.format, vault_id: value.vault_id, generation: value.generation,
      kdf: { alg: value.kdf.alg, m: value.kdf.m, t: value.kdf.t, p: value.kdf.p, salt: value.kdf.salt },
      wraps: value.wraps.map((wrap) => ({ type: wrap.type, nonce: wrap.nonce, ct: wrap.ct })),
    }
  } catch { throw new CannotUnlockError() }
}

export function keyringAAD(keyring, type) {
  validateCommon(keyring)
  if (!['pass+sk', 'recovery'].includes(type)) throw new Error('Invalid wrap type')
  const kdf = keyring.kdf
  const encodedKdf = lengthPrefixed(utf8(kdf.alg), uint32(kdf.m), uint32(kdf.t), uint32(kdf.p), fromBase64(kdf.salt, 16))
  return lengthPrefixed(utf8('VPK2'), fromHex(keyring.vault_id, 16), uint64(keyring.generation), encodedKdf, utf8(type))
}

function requireKey(key, algorithm) {
  if (key?.algorithm?.name !== algorithm || key.extractable !== false || key.type !== 'secret') throw new Error('Invalid key')
  if (algorithm === 'HMAC' && key.algorithm.hash?.name !== 'SHA-256') throw new Error('Invalid Secret Key')
}

async function passKek(keyring, passphrase, secretKey) {
  requireKey(secretKey, 'HMAC')
  let argonOutput
  let message
  let raw
  try {
    argonOutput = await deriveArgonOutput(passphrase, fromBase64(keyring.kdf.salt, 16), keyring.kdf)
    message = concat(utf8('VPK2/kek/pass+sk'), fromHex(keyring.vault_id, 16), argonOutput)
    raw = new Uint8Array(await crypto.subtle.sign('HMAC', secretKey, message))
    return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
  } finally {
    argonOutput?.fill(0)
    message?.fill(0)
    raw?.fill(0)
  }
}

async function recoveryKek(keyring, recoveryKey) {
  requireKey(recoveryKey, 'HKDF')
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256',
    salt: fromHex(keyring.vault_id, 16), info: utf8('VPK2/kek/recovery'),
  }, recoveryKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

async function wrapMaster(keyring, type, master, kek) {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce,
    tagLength: 128, additionalData: keyringAAD(keyring, type) }, kek, master)
  return { type, nonce: toBase64(nonce), ct: toBase64(ct) }
}

async function unwrapMaster(keyring, type, kek) {
  const wrap = keyring.wraps.find((candidate) => candidate.type === type)
  const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM',
    iv: fromBase64(wrap.nonce, 12), tagLength: 128, additionalData: keyringAAD(keyring, type),
  }, kek, fromBase64(wrap.ct, 48)))
  if (raw.length !== 32) { raw.fill(0); throw new Error('Invalid master key') }
  return raw
}

async function importSession(master, vaultId, generation) {
  try {
    const root = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveKey'])
    master.fill(0)
    return { vaultId, generation, root, keys: await derivePurposeKeys(root, vaultId) }
  } finally { master.fill(0) }
}

function validateNewPassphrase(passphrase) {
  if (typeof passphrase !== 'string') throw new Error('Passphrase required')
  const normalized = passphrase.normalize('NFKC')
  const encoded = utf8(normalized)
  try {
    if (Array.from(normalized).length < 12 || encoded.length > 4096) throw new Error('Use a passphrase of at least 12 characters (maximum 4096 UTF-8 bytes).')
  } finally { encoded.fill(0) }
}

async function buildWraps(keyring, master, passphrase, secretKey, recoveryKey) {
  const ps = await passKek(keyring, passphrase, secretKey)
  const rk = await recoveryKek(keyring, recoveryKey)
  keyring.wraps = [await wrapMaster(keyring, 'pass+sk', master, ps), await wrapMaster(keyring, 'recovery', master, rk)]
  return parseKeyring(keyring)
}

/** Returned key texts are intended only for the one-time save/confirmation UI. */
export async function createKeyring(passphrase, { kdf = DEFAULT_KDF } = {}) {
  validateNewPassphrase(passphrase)
  validateKdfParameters(kdf)
  const master = crypto.getRandomValues(new Uint8Array(32))
  const secret = crypto.getRandomValues(new Uint8Array(32))
  const recovery = crypto.getRandomValues(new Uint8Array(32))
  try {
    const secretKeyText = encodeSecret(secret, 'secret')
    const recoveryKeyText = encodeSecret(recovery, 'recovery')
    const secretKey = await importSecretKey(secret)
    const recoveryKey = await importRecoveryKey(recovery)
    const keyring = await buildWraps({
      format: 'VPK2', vault_id: toHex(crypto.getRandomValues(new Uint8Array(16))), generation: 1,
      kdf: { alg: kdf.alg, m: kdf.m, t: kdf.t, p: kdf.p, salt: toBase64(crypto.getRandomValues(new Uint8Array(16))) },
      wraps: [],
    }, master, passphrase, secretKey, recoveryKey)
    const session = await importSession(master, keyring.vault_id, keyring.generation)
    return { keyring, secretKey, secretKeyText, recoveryKeyText, session }
  } finally { master.fill(0); secret.fill(0); recovery.fill(0) }
}

export async function unlockWithSecrets(value, passphrase, secretKey) {
  let master
  try {
    const keyring = parseKeyring(value)
    master = await unwrapMaster(keyring, 'pass+sk', await passKek(keyring, passphrase, secretKey))
    return await importSession(master, keyring.vault_id, keyring.generation)
  } catch { throw new CannotUnlockError() }
  finally { master?.fill(0) }
}

export async function unlockWithRecovery(value, recoveryKey) {
  let master
  try {
    const keyring = parseKeyring(value)
    master = await unwrapMaster(keyring, 'recovery', await recoveryKek(keyring, recoveryKey))
    return await importSession(master, keyring.vault_id, keyring.generation)
  } catch { throw new CannotUnlockError() }
  finally { master?.fill(0) }
}

/**
 * Shared generation/KDF binds both wraps, so every rewrap requires RK.
 * No media changes: temporarily unwrap VMK with RK, rewrap, then zero it.
 * Recovery callers must request BOTH rotations and a new passphrase.
 */
export async function rewrapCredentials(value, recoveryKey, newPassphrase, {
  secretKey, rotateSecret = false, rotateRecovery = false, kdf = DEFAULT_KDF,
} = {}) {
  validateNewPassphrase(newPassphrase)
  validateKdfParameters(kdf)
  let master
  let secret
  let recovery
  try {
    const current = parseKeyring(value)
    master = await unwrapMaster(current, 'recovery', await recoveryKek(current, recoveryKey))
    let secretKeyText
    let recoveryKeyText
    if (rotateSecret) {
      secret = crypto.getRandomValues(new Uint8Array(32))
      secretKeyText = encodeSecret(secret, 'secret')
      secretKey = await importSecretKey(secret)
    }
    requireKey(secretKey, 'HMAC')
    if (rotateRecovery) {
      recovery = crypto.getRandomValues(new Uint8Array(32))
      recoveryKeyText = encodeSecret(recovery, 'recovery')
      recoveryKey = await importRecoveryKey(recovery)
    }
    const keyring = await buildWraps({
      format: 'VPK2', vault_id: current.vault_id, generation: current.generation + 1,
      kdf: { alg: kdf.alg, m: kdf.m, t: kdf.t, p: kdf.p, salt: toBase64(crypto.getRandomValues(new Uint8Array(16))) },
      wraps: [],
    }, master, newPassphrase, secretKey, recoveryKey)
    return { keyring, secretKey, secretKeyText, recoveryKeyText,
      session: await importSession(master, keyring.vault_id, keyring.generation) }
  } catch { throw new CannotUnlockError() }
  finally { master?.fill(0); secret?.fill(0); recovery?.fill(0) }
}
