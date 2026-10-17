import { encryptPacked } from '../crypto/encrypt'
import { getActiveKey } from '../crypto/keyDerivation'
import { loadManifest, serializeManifestCompressed } from '../storage/manifest'
import * as worker from '../storage/workerClient'
import { clearCache, deleteCachedThumb } from '../session/cache'
import { deleteCachedFile } from '../storage/opfsCache'

// Pointer deletion is deliberately distinct from destructive history rewriting.
// Old revisions and thumbnail bundles can still contain the deleted content.
export async function deleteMedia(id, { signal } = {}) {
  const operation = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      signal?.throwIfAborted()
      const { oid } = await worker.getVaultHead()
      const manifest = await loadManifest(oid)
      const entry = manifest.files.find((file) => file.id === id)
      if (!entry) {
        await invalidateDeletedMedia(id)
        return
      }
      manifest.files = manifest.files.filter((file) => file.id !== id)
      manifest.revision = (manifest.revision || 0) + 1
      manifest.updated_at = new Date().toISOString()
      const encrypted = await encryptPacked(
        await serializeManifestCompressed(manifest), getActiveKey(),
      )
      try {
        await worker.deleteMedia({
          parentCommit: oid,
          ids: [{ id, ...(entry.chunked ? { chunk_count: entry.chunk_count } : {}) }],
          manifestBytesBase64: bytesToBase64(new Uint8Array(encrypted)),
        }, { signal })
      } catch (error) {
        if (error.code === 'VAULT_STALE' && attempt < 2) continue
        throw error
      }
      await invalidateDeletedMedia(id)
      return
    }
  }
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request('vaultphotos-vault', { signal }, operation)
  }
  return operation()
}

async function invalidateDeletedMedia(id) {
  // A cache failure must not turn a successful remote deletion into a retry.
  await Promise.allSettled([clearCache(), deleteCachedThumb(id), deleteCachedFile(id)])
}

function bytesToBase64(bytes) {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}
