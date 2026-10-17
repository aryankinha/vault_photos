import { setRevisionScope, clearRevisionScope } from '../session/revision.js'
// Use the pre-bundled build which inlines the WASM as base64. The default
// `argon2-browser` entry does `require('../dist/argon2.wasm')`, which Vite
// cannot resolve at build time. The bundled build sidesteps that entirely.
import argon2 from 'argon2-browser/dist/argon2-bundled.min.js'
import { DEFAULT_KDF_PARAMS } from './kdfParams.js'

const ARGON2_OPTIONS = {
  time: DEFAULT_KDF_PARAMS.time,
  mem: DEFAULT_KDF_PARAMS.memKiB,
  parallelism: DEFAULT_KDF_PARAMS.parallelism,
  hashLen: DEFAULT_KDF_PARAMS.hashLen,
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

  const rawKey = new Uint8Array(result.hash)
  try {
    return await crypto.subtle.importKey(
      'raw',
      rawKey,
      'AES-GCM',
      false,
      ['encrypt', 'decrypt'],
    )
  } finally {
    rawKey.fill(0)
  }
}

export async function unlockWithPassphrase(passphrase, salt) {
  await setRevisionScope(import.meta.env?.VITE_WORKER_URL || 'local', salt)
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
  clearRevisionScope()
  if (typeof navigator !== 'undefined') {
    navigator.serviceWorker?.controller?.postMessage({ type: 'vault-stream-clear' })
  }
}

// KDF sidecar codec re-exports — see kdfParams.js. The sidecar upload route is
// intentionally NOT part of the worker API yet (deferred; must never disturb
// the existing salt, which would brick every existing unlock).
export { DEFAULT_KDF_PARAMS, decodeKdfParamsSidecar, encodeKdfParamsSidecar } from './kdfParams.js'
