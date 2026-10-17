import { openDB } from 'idb'

let scope = null
let database

export async function setRevisionScope(workerUrl, salt) {
  const origin = new TextEncoder().encode(`${workerUrl.replace(/\/$/, '')}\n`)
  const bytes = new Uint8Array(origin.length + salt.byteLength)
  bytes.set(origin)
  bytes.set(new Uint8Array(salt), origin.length)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  scope = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

// These are non-secret high-water marks, not cached plaintext or keys.
export async function checkManifestRevision(manifest) {
  if (!scope) return
  const vaultScope = scope
  const revision = manifest.revision ?? 0
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid vault revision')
  const db = await (database ??= openDB('vaultphotos-integrity', 1, {
    upgrade(db) { db.createObjectStore('revisions') },
  }))
  const tx = db.transaction('revisions', 'readwrite')
  const previous = await tx.store.get(vaultScope)
  if (previous !== undefined && revision < previous) {
    await tx.done
    const error = new Error('This vault is older than a previously opened revision. Restore the latest repository state before making changes.')
    error.code = 'VAULT_ROLLBACK'
    throw error
  }
  if (previous === undefined || revision > previous) await tx.store.put(revision, vaultScope)
  await tx.done
}

export function clearRevisionScope() { scope = null }
