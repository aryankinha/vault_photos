/**
 * Upload orchestration — V3.
 *
 * Two upload paths, chosen by encrypted size:
 *   < DIRECT_UPLOAD_THRESHOLD  → proxy through the worker (XHR with progress)
 *   >= DIRECT_UPLOAD_THRESHOLD → direct-to-S3 (preauth → XHR PUT → commit)
 *
 * Exports:
 *   uploadMedia(file, onProgress)         — V1 single-file path, UNCHANGED
 *   uploadMediaBatch(files, onBatchProgress, optimisticCallbacks)
 *                                          — V3 batch path with optimistic UI support
 *
 * Progress callback shapes:
 *   uploadMedia: { phase: 'reading'|'encrypting'|'uploading'|'finalizing'|'done' }
 *                plus { phase:'uploading', percent: 0..1 } on direct path
 *
 *   uploadMediaBatch: {
 *     totalFiles, completedFiles, currentFile, stage,
 *     overallPercent, etaDisplay, errors
 *   }
 */
import { encryptPacked, encryptWithPool } from '../crypto/encrypt'
import { encryptFileChunks } from '../crypto/chunkEncrypt'
import { getActiveKey } from '../crypto/keyDerivation'
import { addEntry, loadManifest, serializeManifestCompressed } from '../storage/manifest'
import { appendThumb } from '../storage/bundle'
import { readMediaMetadata } from '../utils/exif'
import { generateThumbnail } from '../utils/thumbnail'
import { generateMediaId } from '../utils/uuid'
import { clearCache, queueUpload, dequeueUpload, setCachedThumb } from '../session/cache'
import { EtaTracker } from '../utils/eta'
import { encryptPacked as encryptPackedCrypto } from '../crypto/encrypt'
import * as worker from '../storage/workerClient'
import {
  appendBundleEntry,
  createEmptyBundle,
} from '../schema/bundleSchema'
import { decryptPacked } from '../crypto/decrypt'

// Files at or above this (encrypted) size bypass the worker for the byte
// transfer: the worker only authorizes (preauth) and finalizes (commit).
// Below it, bytes are proxied through the worker via XHR.
const DIRECT_UPLOAD_THRESHOLD = 50 * 1024 * 1024 // 50 MB
const CHUNK_SIZE = 32 * 1024 * 1024 // 32 MB

// Maximum concurrent network uploads in the batch path.
const BATCH_CONCURRENCY = 3

// ---------------------------------------------------------------------------
// V1 — single-file upload (KEEP EXACTLY AS BEFORE — only added comments)
// ---------------------------------------------------------------------------

export async function uploadMedia(file, onProgress) {
  const emit = (phase, extra = {}) => onProgress && onProgress({ phase, ...extra })

  emit('reading')
  const meta = await readMediaMetadata(file)
  const thumbnail = await generateThumbnail(file, meta.type)
  const thumbBytes = new Uint8Array(await thumbnail.arrayBuffer())

  const isLarge = file.size >= DIRECT_UPLOAD_THRESHOLD
  const id = generateMediaId()

  if (isLarge) {
    emit('encrypting')
    // No full-file encryption needed here. We will encrypt chunk-by-chunk.
    
    emit('uploading')
    let uploadedBytes = 0
    const chunkCount = Math.ceil(file.size / CHUNK_SIZE)
    const generator = encryptFileChunks(file, getActiveKey(), CHUNK_SIZE)
    for await (const chunkInfo of generator) {
      const { index: chunkIndex, encrypted: chunkEncrypted, size: chunkRawSize } = chunkInfo
      await worker.uploadChunk(id, chunkIndex, chunkEncrypted, (e) => {
        const percent = file.size > 0 ? (uploadedBytes + e.loaded) / file.size : 0
        onProgress && onProgress({ phase: 'uploading', percent })
      })
      uploadedBytes += chunkRawSize
    }

    const { thumb_offset, thumb_length } = await appendThumb(id, thumbBytes)

    const entry = {
      id,
      name: file.name,
      type: meta.type,
      date_taken: meta.date_taken,
      size: file.size,
      duration: meta.duration,
      thumb_offset,
      thumb_length,
      chunked: true,
      chunk_size: CHUNK_SIZE,
      chunk_count: chunkCount,
    }

    emit('finalizing')
    await addEntry(entry)
    await clearCache()

    emit('done')
    return entry
  } else {
    emit('encrypting')
    const fileBytes = new Uint8Array(await file.arrayBuffer())
    const encrypted = new Uint8Array(await encryptPacked(fileBytes, getActiveKey()))

    emit('uploading')
    // Route to direct or proxy based on encrypted size.
    await uploadEncryptedFile(id, encrypted, (e) => {
      onProgress && onProgress({ phase: 'uploading', percent: e.percent })
    })

    const { thumb_offset, thumb_length } = await appendThumb(id, thumbBytes)

    const entry = {
      id,
      name: file.name,
      type: meta.type,
      date_taken: meta.date_taken,
      size: file.size,
      duration: meta.duration,
      thumb_offset,
      thumb_length,
    }

    emit('finalizing')
    await addEntry(entry)
    await clearCache()

    emit('done')
    return entry
  }
}

// ---------------------------------------------------------------------------
// V2 — batch upload
// ---------------------------------------------------------------------------

/**
 * Upload multiple files with:
 *   - Parallel local processing (all files at once — CPU only, no network)
 *   - Parallel network uploads (max BATCH_CONCURRENCY in flight)
 *   - Single manifest update at the end
 *   - Single bundle update at the end
 *   - Single clearCache() at the end
 *
 * V3: accepts optional optimisticCallbacks for instant gallery appearance.
 *
 * @param {File[]} files
 * @param {(progress: BatchProgress) => void} onBatchProgress
 * @param {{ addOptimisticEntry, updateOptimisticState, removeOptimisticEntry, markOptimisticError }} [optimisticCallbacks]
 * @returns {Promise<{ entries: object[], errors: { file: File, error: Error }[] }>}
 */
export async function uploadMediaBatch(files, onBatchProgress, optimisticCallbacks = {}) {
  const {
    addOptimisticEntry,
    updateOptimisticState,
    removeOptimisticEntry,
    markOptimisticError,
  } = optimisticCallbacks
  const totalFiles = files.length
  const errors = []

  // ------------------------------------------------------------------
  // Step 1 — process all files locally in parallel (no network limit)
  // ------------------------------------------------------------------
  const report = (state) => onBatchProgress && onBatchProgress(state)

  report({
    totalFiles,
    completedFiles: 0,
    currentFile: files[0]?.name ?? '',
    stage: 'reading',
    overallPercent: 0,
    etaDisplay: 'calculating…',
    errors: [],
  })

  const processedFiles = await Promise.all(
    files.map(async (file) => {
      const meta = await readMediaMetadata(file)
      const thumbnail = await generateThumbnail(file, meta.type)
      const thumbBlob = thumbnail                              // Blob from generateThumbnail
      const thumbBytes = new Uint8Array(await thumbnail.arrayBuffer())

      const isLarge = file.size >= DIRECT_UPLOAD_THRESHOLD
      let encrypted = null
      const id = generateMediaId()

      if (isLarge) {
        // V3 chunked upload path doesn't encrypt the file body here.
        // It will be encrypted chunk-by-chunk during the upload step.
      } else {
        const fileBytes = new Uint8Array(await file.arrayBuffer())
        // V3: use the crypto worker pool for file body encryption (off main thread).
        encrypted = new Uint8Array(await encryptWithPool(fileBytes, getActiveKey()))
      }

      // V3: cache the thumbnail immediately — gallery will find it on next open.
      void setCachedThumb(id, thumbBlob).catch(() => {})

      // V3: add the entry to the gallery NOW, before any network request.
      const optimisticEntry = {
        id,
        name: file.name,
        type: meta.type,
        date_taken: meta.date_taken,
        size: file.size,
        duration: meta.duration ?? null,
        thumb_offset: 0,   // placeholder — not known until bundle is written
        thumb_length: thumbBytes.byteLength,
      }
      
      if (isLarge) {
        optimisticEntry.chunked = true
        optimisticEntry.chunk_size = CHUNK_SIZE
        optimisticEntry.chunk_count = Math.ceil(file.size / CHUNK_SIZE)
      }

      if (addOptimisticEntry) addOptimisticEntry(optimisticEntry, thumbBlob)

      // Queue the upload in IndexedDB for Background Sync before network starts
      if (!isLarge) {
        const initialEntry = {
          id,
          name: file.name,
          type: meta.type,
          date_taken: meta.date_taken,
          size: file.size,
          duration: meta.duration,
        }
        await queueUpload(id, encrypted, initialEntry)
      }

      return {
        file,
        meta,
        thumbBytes,
        thumbBlob,
        encrypted,
        id,
        isLarge,
        chunkSize: isLarge ? CHUNK_SIZE : undefined,
        chunkCount: isLarge ? Math.ceil(file.size / CHUNK_SIZE) : undefined,
      }
    }),
  )

  // ------------------------------------------------------------------
  // Step 2 — upload encrypted blobs with concurrency limit
  // ------------------------------------------------------------------
  const totalEncryptedBytes = processedFiles.reduce((s, p) => {
    if (p.isLarge) {
      const overheadPerChunk = 28 // 12 nonce + 16 tag
      return s + p.file.size + (p.chunkCount * overheadPerChunk)
    }
    return s + p.encrypted.byteLength
  }, 0)
  const eta = new EtaTracker(totalEncryptedBytes)
  const perFileLoaded = new Array(processedFiles.length).fill(0)
  let completedFiles = 0

  // Accumulate the commit descriptors: { id, sha256, size }
  const commitDescriptors = new Array(processedFiles.length).fill(null)
  const uploadResults = new Array(processedFiles.length).fill(null)

  function emitProgress(fileIndex, stage) {
    const totalLoaded = perFileLoaded.reduce((a, b) => a + b, 0)
    eta.update(totalLoaded)
    const { etaDisplay } = eta.getEta()
    report({
      totalFiles,
      completedFiles,
      currentFile: processedFiles[fileIndex]?.file.name ?? '',
      stage,
      overallPercent: totalEncryptedBytes > 0 ? totalLoaded / totalEncryptedBytes : 0,
      etaDisplay,
      errors,
    })
  }

  async function uploadOne(pf, index) {
    // V3: update optimistic state → 'uploading'
    if (updateOptimisticState) {
      updateOptimisticState(pf.id, { status: 'uploading', progress: 0, error: null })
    }
    emitProgress(index, 'uploading')

    try {
      if (pf.isLarge) {
        // Chunked upload path
        let uploadedBytes = 0
        const generator = encryptFileChunks(pf.file, getActiveKey(), pf.chunkSize)

        for await (const chunkInfo of generator) {
          const { index: chunkIndex, encrypted: chunkEncrypted } = chunkInfo
          await worker.uploadChunk(
            pf.id,
            chunkIndex,
            chunkEncrypted,
            (e) => {
              const totalLoadedForChunk = uploadedBytes + e.loaded
              perFileLoaded[index] = totalLoadedForChunk

              if (updateOptimisticState) {
                const approxTotalEncrypted = pf.file.size + (pf.chunkCount * 28)
                const p = approxTotalEncrypted > 0 ? totalLoadedForChunk / approxTotalEncrypted : 0
                updateOptimisticState(pf.id, { status: 'uploading', progress: Math.min(p, 0.99), error: null })
              }
              emitProgress(index, 'uploading')
            }
          )

          uploadedBytes += chunkEncrypted.byteLength
          perFileLoaded[index] = uploadedBytes

          if (updateOptimisticState) {
            const approxTotalEncrypted = pf.file.size + (pf.chunkCount * 28)
            const p = approxTotalEncrypted > 0 ? uploadedBytes / approxTotalEncrypted : 0
            updateOptimisticState(pf.id, { status: 'uploading', progress: Math.min(p, 0.99), error: null })
          }
          emitProgress(index, 'uploading')
        }

        perFileLoaded[index] = pf.file.size
      } else {
        // Call uploadEncryptedFile with commit = false to defer the Git commit
        const uploadRes = await uploadEncryptedFile(pf.id, pf.encrypted, (e) => {
          perFileLoaded[index] = e.loaded
          // V3: update fine-grained upload progress
          if (updateOptimisticState) {
            const p = pf.encrypted.byteLength > 0 ? e.loaded / pf.encrypted.byteLength : 0
            updateOptimisticState(pf.id, { status: 'uploading', progress: p, error: null })
          }
          emitProgress(index, 'uploading')
        }, false)

        // Retrieve sha256 and size
        let sha256, size
        if (uploadRes instanceof ArrayBuffer) {
          const json = JSON.parse(new TextDecoder().decode(uploadRes))
          sha256 = json.sha256
          size = json.size
        } else if (uploadRes && uploadRes.sha256) {
          sha256 = uploadRes.sha256
          size = uploadRes.size
        } else {
          sha256 = await computeSha256Hex(pf.encrypted)
          size = pf.encrypted.byteLength
        }

        commitDescriptors[index] = { id: pf.id, sha256, size }
        perFileLoaded[index] = pf.encrypted.byteLength

        // Dequeue successfully uploaded file from IndexedDB background sync queue
        await dequeueUpload(pf.id)
      }
    } catch (err) {
      // V3: mark error on the optimistic card
      if (markOptimisticError) markOptimisticError(pf.id, err.message)
      throw err
    }
  }

  const queue = [...processedFiles.entries()]
  const inFlight = new Set()

  function startNext() {
    while (inFlight.size < BATCH_CONCURRENCY && queue.length > 0) {
      const [index, pf] = queue.shift()
      const p = uploadOne(pf, index)
        .then(() => {
          uploadResults[index] = { ok: true }
          completedFiles++
          emitProgress(index, 'done')
        })
        .catch((err) => {
          uploadResults[index] = { ok: false, err }
          errors.push({ file: pf.file, error: err })
          completedFiles++
          emitProgress(index, 'error')
        })
        .finally(() => {
          inFlight.delete(p)
          startNext()
        })
      inFlight.add(p)
    }
  }

  await new Promise((resolve) => {
    startNext()
    const check = setInterval(() => {
      if (inFlight.size === 0 && queue.length === 0) {
        clearInterval(check)
        resolve()
      }
    }, 50)
  })

  // ------------------------------------------------------------------
  // Step 3 — Build updated manifest and bundle locally, then commit everything bulk
  // ------------------------------------------------------------------
  report({
    totalFiles,
    completedFiles,
    currentFile: '',
    stage: 'finalizing',
    overallPercent: 1,
    etaDisplay: '',
    errors,
  })

  const succeededIndices = processedFiles
    .map((_, i) => i)
    .filter((i) => uploadResults[i]?.ok)

  if (succeededIndices.length > 0) {
    // 1. Fetch current bundle
    let rawBundleBuffer
    try {
      const encBuf = await worker.getBundle()
      rawBundleBuffer = await decryptPacked(encBuf, getActiveKey())
    } catch (e) {
      if (e.status === 404) rawBundleBuffer = createEmptyBundle()
      else throw e
    }

    // 2. Append thumbnails locally to get new offsets
    const thumbEntries = []
    let currentBuffer = rawBundleBuffer
    for (const idx of succeededIndices) {
      const pf = processedFiles[idx]
      const result = appendBundleEntry(currentBuffer, { id: pf.id, bytes: pf.thumbBytes })
      thumbEntries.push({
        pf,
        thumb_offset: result.thumb_offset,
        thumb_length: result.thumb_length,
      })
      currentBuffer = result.bundle
    }

    // 3. Encrypt bundle locally
    const encryptedBundle = new Uint8Array(await encryptPackedCrypto(currentBuffer, getActiveKey()))

    // 4. Update manifest locally
    const manifest = await loadManifest()
    const newEntries = thumbEntries.map(({ pf, thumb_offset, thumb_length }) => {
      const entry = {
        id: pf.id,
        name: pf.file.name,
        type: pf.meta.type,
        date_taken: pf.meta.date_taken,
        size: pf.file.size,
        duration: pf.meta.duration,
        thumb_offset,
        thumb_length,
      }
      if (pf.isLarge) {
        entry.chunked = true
        entry.chunk_size = pf.chunkSize
        entry.chunk_count = pf.chunkCount
      }
      return entry
    })

    for (const entry of newEntries) {
      manifest.files.push(entry)
    }
    manifest.updated_at = new Date().toISOString()

    // 5. Compress + encrypt manifest (gzip then AES-GCM — same path as saveManifest)
    const manifestCompressedBytes = await serializeManifestCompressed(manifest)
    const encryptedManifest = new Uint8Array(await encryptPackedCrypto(manifestCompressedBytes, getActiveKey()))

    // 6. Make ONE SINGLE Git commit on the worker to finalize the batch
    const filesToCommitInBatch = succeededIndices
      .map((i) => commitDescriptors[i])
      .filter(Boolean)

    const commitPayload = {
      files: filesToCommitInBatch,
      manifestBytesBase64: bytesToBase64(encryptedManifest),
      bundleBytesBase64: bytesToBase64(encryptedBundle),
    }

    await worker.commitBatch(commitPayload)
  }

  // ------------------------------------------------------------------
  // Step 4 — Clear session cache; remove optimistic entries for succeeded files
  // ------------------------------------------------------------------
  await clearCache()

  // V3: remove optimistic entries for all succeeded files — the real manifest
  // reload (triggered by Gallery.jsx after isUploading → false) will show real entries.
  if (removeOptimisticEntry) {
    for (const i of succeededIndices) {
      removeOptimisticEntry(processedFiles[i].id)
    }
  }

  const succeededFiles = succeededIndices.map((i) => processedFiles[i])
  return { entries: succeededFiles, errors }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Upload an encrypted file buffer, choosing the proxy or direct-to-S3 path
 * based on the buffer size.
 *
 * @param {string} id — 16-hex file id
 * @param {Uint8Array} encryptedBytes
 * @param {(e: {loaded:number,total:number,percent:number}) => void} [onProgress]
 * @param {boolean} [commit] — whether to commit the file pointer immediately
 */
export async function uploadEncryptedFile(id, encryptedBytes, onProgress, commit = true) {
  if (encryptedBytes.byteLength < DIRECT_UPLOAD_THRESHOLD) {
    // Small file — proxy through the worker via XHR.
    return await worker.uploadFile(id, encryptedBytes, onProgress, commit)
  } else {
    // Large file — browser PUTs directly to S3; worker only authorizes + commits.
    return await uploadDirect(id, encryptedBytes, onProgress, commit)
  }
}

/**
 * Direct-to-S3 upload path for large encrypted files.
 * Worker negotiates LFS credentials; browser PUTs raw bytes directly to S3.
 */
async function uploadDirect(id, encryptedBytes, onProgress, commit = true) {
  const sha256 = await computeSha256Hex(encryptedBytes)
  const size = encryptedBytes.byteLength

  const preauth = await worker.preauthUpload(id, size, sha256)

  if (!preauth.alreadyExists) {
    const { uploadUrl, uploadHeaders } = preauth
    await xhrPut(uploadUrl, uploadHeaders || {}, encryptedBytes, onProgress)
  }

  if (commit) {
    await worker.commitUpload(id, sha256, size, preauth.verifyUrl ?? null, preauth.verifyHeaders ?? null)
  }

  return { sha256, size }
}

/**
 * PUT bytes directly to an S3 presigned URL via XHR (for real upload progress).
 */
function xhrPut(uploadUrl, uploadHeaders, bytes, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', uploadUrl)
    Object.entries(uploadHeaders).forEach(([k, v]) => xhr.setRequestHeader(k, v))

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress({ loaded: e.loaded, total: e.total, percent: e.loaded / e.total })
        }
      }
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(`S3 PUT failed: ${xhr.status}`))
    }
    xhr.onerror = () => reject(new Error('S3 PUT network error'))
    xhr.send(bytes)
  })
}

/**
 * Compute a lowercase hex SHA-256 digest.
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
async function computeSha256Hex(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Helper to convert Uint8Array bytes to base64.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToBase64(bytes) {
  let binary = ''
  const len = bytes.byteLength
  const chunkSize = 0x8000
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode.apply(null, chunk)
  }
  return btoa(binary)
}
