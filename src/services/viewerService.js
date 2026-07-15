/**
 * Viewer orchestration: fetch a single encrypted media file, decrypt it, and
 * hand back an object URL the caller can bind to an <img>/<video>. The caller
 * owns the URL's lifetime (the hook revokes on cleanup).
 *
 * Phase 9: encrypted OPFS read-through / write-back cache.
 *   Hot path  — encrypted bytes are read from OPFS and authenticated/decrypted.
 *   Cold path — encrypted bytes are fetched, decrypted, then persisted as-is.
 *   Chunked files — OPFS cache is skipped (assembling all chunks in RAM before
 *                   writing defeats the purpose of chunking).
 */
import { decryptPacked } from '../crypto/decrypt'
import { getActiveKey } from '../crypto/keyDerivation'
import { loadManifest } from '../storage/manifest'
import { decryptFileChunks } from '../crypto/chunkEncrypt'
import * as worker from '../storage/workerClient'
import {
  deleteCachedFile,
  getCachedFile,
  isOPFSSupported,
  setCachedFile,
} from '../storage/opfsCache'

export async function loadFullMedia(entryOrId, mimeType) {
  let entry
  if (typeof entryOrId === 'object' && entryOrId !== null) {
    entry = entryOrId
  } else {
    const manifest = await loadManifest()
    entry = manifest.files.find((f) => f.id === entryOrId)
  }

  const id = entry?.id ?? entryOrId

  if (entry && entry.chunked) {
    // ── Chunked assembly path (Phase 7) ────────────────────────────────────
    // OPFS cache is deliberately skipped here: chunked files are already
    // large (>= 50 MB) and assembling them into one ArrayBuffer before
    // writing would cause a second peak-memory spike. The in-memory prefetch
    // cache (Phase 8) handles repeat opens within a single session.
    const chunks = []
    for await (const chunk of decryptFileChunks(entry.id, entry.chunk_count, getActiveKey(), worker.getChunk)) {
      chunks.push(chunk)
    }
    const blob = new Blob(chunks, { type: mimeType || 'application/octet-stream' })
    return URL.createObjectURL(blob)
  }

  // ── Phase 9: OPFS read-through ────────────────────────────────────────────
  if (await isOPFSSupported()) {
    try {
      const cached = await getCachedFile(id, getActiveKey())
      if (cached) {
        const blob = new Blob([cached], { type: mimeType || 'application/octet-stream' })
        return URL.createObjectURL(blob)
      }
    } catch {
      // A stale/tampered cache entry is untrusted. Remove it and use HF.
      void deleteCachedFile(id)
    }
  }

  // ── Cold path: decrypt from worker ───────────────────────────────────────
  const buffer = await worker.getFile(id)
  const decrypted = await decryptPacked(buffer, getActiveKey())

  // Persist ciphertext only. The plaintext remains in memory for this view.
  if (await isOPFSSupported()) void setCachedFile(id, buffer)

  const blob = new Blob([decrypted], { type: mimeType || 'application/octet-stream' })
  return URL.createObjectURL(blob)
}
