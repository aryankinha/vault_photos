// Use the pre-bundled build which inlines the WASM as base64. The default
// `argon2-browser` entry does `require('../dist/argon2.wasm')`, which Vite
// cannot resolve at build time. The bundled build sidesteps that entirely.
import argon2 from 'argon2-browser/dist/argon2-bundled.min.js'
import { setPoolKey, clearPoolKey } from '../workers/cryptoWorkerPool'

const ARGON2_OPTIONS = {
  time: 3,
  mem: 65536,
  parallelism: 4,
  hashLen: 32,
  type: argon2.ArgonType.Argon2id,
}

let activeKey = null

export async function deriveKeyFromPassphrase(passphrase, salt) {
  if (!passphrase) {
    throw new Error('Passphrase is required')
  }

  const result = await argon2.hash({
    pass: passphrase,
    salt: new Uint8Array(salt),
    ...ARGON2_OPTIONS,
  })

  const rawKey = result.hash
  // Register the raw key bytes with the worker pool BEFORE the key is imported
  // as non-extractable (once imported as extractable:false, we can't get them back).
  setPoolKey(new Uint8Array(rawKey))
  return crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function unlockWithPassphrase(passphrase, salt) {
  activeKey = await deriveKeyFromPassphrase(passphrase, salt)
  return activeKey
}

export function getActiveKey() {
  if (!activeKey) {
    throw new Error('Vault is locked')
  }

  return activeKey
}

export function hasActiveKey() {
  return activeKey !== null
}

export function clearActiveKey() {
  activeKey = null
  // Clear the worker pool key to avoid stale key material after lock.
  clearPoolKey()
}
