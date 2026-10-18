import { openDB } from 'idb'
import { fromHex } from '../crypto/v2/binary.js'

let database
function db() {
  return database ??= openDB('vaultphotos-device', 1, {
    upgrade(database) { database.createObjectStore('secretKeys') },
  })
}
function validateSecretKey(key) {
  if (key?.type !== 'secret' || key.extractable !== false || key.algorithm?.name !== 'HMAC' ||
      key.algorithm.hash?.name !== 'SHA-256' || key.usages.length !== 1 || key.usages[0] !== 'sign') throw new Error('Invalid device Secret Key')
}

export async function rememberSecretKey(vaultId, key) {
  fromHex(vaultId, 16)
  validateSecretKey(key)
  await (await db()).put('secretKeys', key, vaultId)
}

export async function getRememberedSecretKey(vaultId) {
  fromHex(vaultId, 16)
  const key = await (await db()).get('secretKeys', vaultId)
  if (key !== undefined) validateSecretKey(key)
  return key ?? null
}

export async function forgetSecretKey(vaultId) {
  fromHex(vaultId, 16)
  await (await db()).delete('secretKeys', vaultId)
}
