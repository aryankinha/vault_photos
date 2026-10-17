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
 *
 * Integrity + context binding (audit findings S3/U6):
 *   - When the manifest entry carries `sha256` / `chunk_sha256`, the fetched
 *     ciphertext is verified against it BEFORE decryption (a swapped or
 *     truncated object fails loudly instead of decrypting "successfully").
 *   - When the entry carries `crypto_version: 2`, decryption is context-bound:
 *     the canonical kind+id(+index) AAD is required and there is NO legacy
 *     fallback on auth failure. Entries without crypto_version (existing
 *     vaults) decrypt exactly as before.
 */
import { decryptPacked } from '../crypto/decrypt'
import { getActiveKey } from '../crypto/keyDerivation'
import { loadManifest } from '../storage/manifest'
import { decryptFileChunks } from '../crypto/chunkEncrypt'
import { fileContext, resolveCryptoVersion, CRYPTO_VERSION_CONTEXT } from '../crypto/context'
import { assertCiphertextHash } from '../crypto/integrity'
import * as worker from '../storage/workerClient'
import {
  deleteCachedFile,
  getCachedFile,
  isOPFSSupported,
  setCachedFile,
} from '../storage/opfsCache'

export async function loadFullMedia(entryOrId, mimeType, options = {}) {
  let entry
  if (typeof entryOrId === 'object' && entryOrId !== null) {
    entry = entryOrId
  } else {
    const manifest = await loadManifest()
    entry = manifest.files.find((f) => f.id === entryOrId)
  }

  const id = entry?.id ?? entryOrId
  // Throws on an unknown crypto_version — never silently downgrades a mode we
  // do not understand. Absent (every existing vault) = legacy.
  const cryptoVersion = entry ? resolveCryptoVersion(entry) : undefined
  const contextBound = cryptoVersion === CRYPTO_VERSION_CONTEXT
  // The context is only bound for context-mode objects; legacy entries keep
  // the exact pre-existing (no-AAD) decrypt.
  const context = entry && contextBound
    ? (entry.chunked ? { kind: 'chunk', id } : fileContext(id)) : undefined

  if (entry && entry.chunked) {
    // ── Chunked assembly path (Phase 7) ────────────────────────────────────
    // OPFS cache is deliberately skipped here: chunked files are already
    // large (>= 50 MB) and assembling them into one ArrayBuffer before
    // writing would cause a second peak-memory spike. The in-memory prefetch
    // cache (Phase 8) handles repeat opens within a single session.
    const chunks = []
    for await (const chunk of decryptFileChunks(
      entry.id,
      entry.chunk_count,
      getActiveKey(),
      (mediaId, index) => worker.getChunk(mediaId, index, options),
      undefined,
      { context, cryptoVersion, chunkSha256: entry.chunk_sha256 },
    )) {
      chunks.push(chunk)
    }
    const blob = new Blob(chunks, { type: mimeType || 'application/octet-stream' })
    return URL.createObjectURL(blob)
  }

  // ── Phase 9: OPFS read-through ──────────────────────────────────────────
  // The OPFS helper still decrypts in legacy mode, so context-bound (v2)
  // ciphertext would fail authentication on every read. Skip the hot path for
  // those entries until the cache learns the v2 context decrypt — otherwise
  // each view would round-trip the network AND rewrite a cache it can never
  // hit. Legacy entries keep the fast path unchanged.
  if (!contextBound && await isOPFSSupported()) {
    try {
      const cached = await getCachedFile(id, getActiveKey())
      if (!cached) throw new Error('Cache miss')
      options.signal?.throwIfAborted()
      const blob = new Blob([cached], { type: mimeType || 'application/octet-stream' })
      return URL.createObjectURL(blob)
    } catch {
      // A stale/tampered cache entry is untrusted. Remove it and use HF.
      void deleteCachedFile(id)
    }
  }

  // ── Cold path: fetch, verify integrity, then decrypt from worker ────────
  const buffer = await worker.getFile(id, options)
  // Verify the ciphertext hash (when the manifest recorded one) BEFORE
  // decrypting, so swaps/truncation surface as a clear integrity error.
  await assertCiphertextHash(buffer, entry?.sha256, `file ${id}`)
  const decrypted = await decryptPacked(buffer, getActiveKey(), { context, cryptoVersion })

  // Persist ciphertext only. The plaintext remains in memory for this view.
  if (await isOPFSSupported()) void setCachedFile(id, buffer)

  options.signal?.throwIfAborted()
  const blob = new Blob([decrypted], { type: mimeType || 'application/octet-stream' })
  return URL.createObjectURL(blob)
}
