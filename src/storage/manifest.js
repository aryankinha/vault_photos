/**
 * Manifest storage. Handles fetch → decrypt → parse and serialize → encrypt →
 * upload round-trips against the worker. A missing manifest (HTTP 404 on first
 * run) returns an empty manifest instead of throwing, so the gallery can render
 * an empty state on a brand-new vault.
 */
import { decryptPacked } from '../crypto/decrypt'
import { encryptPacked } from '../crypto/encrypt'
import { getActiveKey } from '../crypto/keyDerivation'
import {
  createEmptyManifest,
  parseManifest,
  serializeManifest,
} from '../schema/manifestSchema'
import * as worker from './workerClient'

export async function loadManifest() {
  let buffer
  try {
    buffer = await worker.getManifest()
  } catch (error) {
    if (error.status === 404) return createEmptyManifest()
    throw error
  }

  const decrypted = await decryptPacked(buffer, getActiveKey())
  const text = new TextDecoder().decode(decrypted)
  return parseManifest(text)
}

export async function saveManifest(manifest) {
  const text = serializeManifest(manifest)
  const bytes = new TextEncoder().encode(text)
  const encrypted = await encryptPacked(bytes, getActiveKey())
  await worker.uploadManifest(encrypted)
}

/**
 * Append a new media entry and persist. Returns the updated manifest. The
 * caller is responsible for computing thumb_offset/thumb_length before calling.
 */
export async function addEntry(entry) {
  const manifest = await loadManifest()
  manifest.files.push(entry)
  manifest.updated_at = new Date().toISOString()
  await saveManifest(manifest)
  return manifest
}
