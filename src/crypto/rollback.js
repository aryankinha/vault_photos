/**
 * Rollback/replay detection helper (audit finding S4) — SEPARATE from the
 * manifest schema and from every other vault operation.
 *
 * Threat: an attacker who can restore an old legitimate `manifest.enc`
 * (finding S1) makes recent photos silently vanish while everything still
 * decrypts. Mitigation: each manifest carries a monotonically increasing
 * `revision`; the client keeps a non-decreasing high-water mark and flags any
 * manifest whose revision is lower than the highest one it has seen.
 *
 * Scoping (deliberate): the high-water mark is keyed by the SHA-256 digest of
 * the vault's KDF salt — a non-reversible per-vault identity. Two vaults on
 * the same origin never share a counter, and nothing global mixes revisions
 * across vaults. A fresh device naturally sees "firstSighting" until it has
 * observed a higher revision.
 *
 * Storage: `localStorage` when available, in-memory otherwise. The caller may
 * inject a Storage-shaped object ({getItem,setItem,removeItem}) for tests or a
 * future IndexedDB-backed implementation.
 *
 * Wiring note: this helper is intentionally NOT called from app code yet — the
 * gallery bootstrap (outside this module's ownership) decides when to surface
 * the "vault rolled back" banner.
 */

const STORAGE_PREFIX = 'vaultphotos:revision-highwater:'

/** Test/injection helper: a fresh in-memory Storage-shaped object. */
export function createMemoryStorage() {
  const backing = new Map()
  return {
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => { backing.set(key, String(value)) },
    removeItem: (key) => { backing.delete(key) },
  }
}

const memoryStorage = createMemoryStorage()

function defaultStorage() {
  try {
    if (typeof localStorage !== 'undefined') {
      // Touch it — Safari private mode throws on access.
      localStorage.setItem(`${STORAGE_PREFIX}probe`, '1')
      localStorage.removeItem(`${STORAGE_PREFIX}probe`)
      return localStorage
    }
  } catch {
    // Fall through to the in-memory store.
  }
  return memoryStorage
}

/** Non-reversible per-vault identity: SHA-256 of the KDF salt, as hex. */
export async function vaultIdentityFromSalt(salt) {
  const bytes = salt instanceof Uint8Array ? salt : new Uint8Array(salt)
  if (bytes.byteLength === 0) throw new TypeError('Vault identity requires a non-empty salt')
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function storageKey(vaultId) {
  return `${STORAGE_PREFIX}${vaultId}`
}

/**
 * Observe a manifest revision for a vault and update the high-water mark.
 *
 * @param {Uint8Array|ArrayBuffer} salt — the vault's KDF salt (vault identity)
 * @param {number} revision — the manifest's revision field (0 for the initial
 *   manifest; manifests without a revision field should be read as 0)
 * @param {{ storage?: {getItem,setItem,removeItem} }} [options]
 * @returns {Promise<{
 *   vaultId: string,
 *   revision: number,
 *   previous: number|undefined,
 *   firstSighting: boolean,
 *   rolledBack: boolean,
 * }>}
 */
export async function checkManifestRevision(salt, revision, options = {}) {
  if (!Number.isInteger(revision) || revision < 0) {
    throw new TypeError('Manifest revision must be a non-negative integer')
  }
  const vaultId = await vaultIdentityFromSalt(salt)
  const storage = options.storage ?? defaultStorage()
  const key = storageKey(vaultId)

  let previous
  try {
    const raw = storage.getItem(key)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Number.isInteger(parsed?.revision) && parsed.revision >= 0) {
        previous = parsed.revision
      }
    }
  } catch {
    // Corrupt/absent high-water data is treated as "no history".
    previous = undefined
  }

  const rolledBack = previous !== undefined && revision < previous
  if (!rolledBack && (previous === undefined || revision > previous)) {
    try {
      storage.setItem(key, JSON.stringify({ revision, updatedAt: new Date().toISOString() }))
    } catch {
      // Storage failures must never block reading a vault.
    }
  }

  return {
    vaultId,
    revision,
    previous,
    firstSighting: previous === undefined,
    rolledBack,
  }
}

/** Forget the high-water mark for a vault (e.g. after an explicit repair). */
export function resetRevisionHighWater(salt, options = {}) {
  const storage = options.storage ?? defaultStorage()
  return vaultIdentityFromSalt(salt).then((vaultId) => {
    storage.removeItem(storageKey(vaultId))
    return vaultId
  })
}
