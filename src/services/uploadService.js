/**
 * Upload orchestration — V2.
 *
 * Two upload paths, chosen by encrypted size:
 *   < DIRECT_UPLOAD_THRESHOLD  → proxy through the worker (XHR with progress)
 *   >= DIRECT_UPLOAD_THRESHOLD → direct-to-S3 (preauth → XHR PUT → commit)
 *
 * Exports:
 *   uploadMedia(file, onProgress)         — V1 single-file path, UNCHANGED
 *   uploadMediaBatch(files, onBatchProgress) — V2 batch path (parallel uploads,
 *                                            one manifest+bundle round-trip)
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
import { encryptPacked } from '../crypto/encrypt'
import { getActiveKey } from '../crypto/keyDerivation'
import { addEntry } from '../storage/manifest'
import { appendThumb } from '../storage/bundle'
import {
  commitUpload,
  preauthUpload,
  uploadFile,
} from '../storage/workerClient'
import { readMediaMetadata } from '../utils/exif'
import { generateThumbnail } from '../utils/thumbnail'
import { generateMediaId } from '../utils/uuid'
import { clearCache } from '../session/cache'
import { EtaTracker } from '../utils/eta'
import { loadManifest, saveManifest } from '../storage/manifest'
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

  emit('encrypting')
  const fileBytes = new Uint8Array(await file.arrayBuffer())
  const encrypted = new Uint8Array(await encryptPacked(fileBytes, getActiveKey()))

  emit('uploading')
  const id = generateMediaId()

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
 * @param {File[]} files
 * @param {(progress: BatchProgress) => void} onBatchProgress
 * @returns {Promise<{ entries: object[], errors: { file: File, error: Error }[] }>}
 */
export async function uploadMediaBatch(files, onBatchProgress) {
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
      const thumbBytes = new Uint8Array(await thumbnail.arrayBuffer())
      const fileBytes = new Uint8Array(await file.arrayBuffer())
      const encrypted = new Uint8Array(await encryptPacked(fileBytes, getActiveKey()))
      const id = generateMediaId()
      return { file, meta, thumbBytes, encrypted, id }
    }),
  )

  // ------------------------------------------------------------------
  // Step 2 — upload encrypted blobs with concurrency limit
  // ------------------------------------------------------------------
  // Track per-file loaded bytes for overall ETA calculation.
  const totalEncryptedBytes = processedFiles.reduce((s, p) => s + p.encrypted.byteLength, 0)
  const eta = new EtaTracker(totalEncryptedBytes)
  const perFileLoaded = new Array(processedFiles.length).fill(0)
  let completedFiles = 0

  // Results accumulate here; some may be errors.
  const uploadResults = new Array(processedFiles.length).fill(null)

  /**
   * Emit current overall progress.
   * @param {number} fileIndex — index of the file currently active
   * @param {string} stage
   */
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

  /**
   * Upload one processed file. Returns the resolved entry or throws.
   */
  async function uploadOne(pf, index) {
    emitProgress(index, 'uploading')
    await uploadEncryptedFile(pf.id, pf.encrypted, (e) => {
      perFileLoaded[index] = e.loaded
      emitProgress(index, 'uploading')
    })
    perFileLoaded[index] = pf.encrypted.byteLength
  }

  // Concurrency queue.
  const queue = [...processedFiles.entries()] // [[index, pf], ...]
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
    // Poll until all tasks are done. We resolve when inFlight empties and
    // queue is empty. The startNext + finally loop drives this naturally.
    const check = setInterval(() => {
      if (inFlight.size === 0 && queue.length === 0) {
        clearInterval(check)
        resolve()
      }
    }, 50)
  })

  // ------------------------------------------------------------------
  // Step 3 — one single manifest update
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

  // Only commit successful uploads.
  const succeeded = processedFiles.filter((_, i) => uploadResults[i]?.ok)

  if (succeeded.length > 0) {
    // ------------------------------------------------------------------
    // Step 4 — one single bundle update (fetch → decrypt → append all → re-encrypt → upload)
    // ------------------------------------------------------------------
    let rawBundleBuffer
    try {
      const encBuf = await worker.getBundle()
      rawBundleBuffer = await decryptPacked(encBuf, getActiveKey())
    } catch (e) {
      if (e.status === 404) rawBundleBuffer = createEmptyBundle()
      else throw e
    }

    // Compute thumb offsets/lengths for all new entries at once.
    const thumbEntries = []
    let currentBuffer = rawBundleBuffer
    for (const pf of succeeded) {
      const result = appendBundleEntry(currentBuffer, { id: pf.id, bytes: pf.thumbBytes })
      thumbEntries.push({
        pf,
        thumb_offset: result.thumb_offset,
        thumb_length: result.thumb_length,
      })
      // Update currentBuffer for the next iteration so offsets chain correctly.
      currentBuffer = result.bundle
    }

    // Encrypt and upload the final bundle in one shot.
    const encryptedBundle = await encryptPackedCrypto(currentBuffer, getActiveKey())
    await worker.uploadBundle(encryptedBundle)

    // Build manifest entries now that we have correct thumb offsets.
    const newEntries = thumbEntries.map(({ pf, thumb_offset, thumb_length }) => ({
      id: pf.id,
      name: pf.file.name,
      type: pf.meta.type,
      date_taken: pf.meta.date_taken,
      size: pf.file.size,
      duration: pf.meta.duration,
      thumb_offset,
      thumb_length,
    }))

    // Step 3 (continued) — load manifest once, push all new entries, save once.
    const manifest = await loadManifest()
    for (const entry of newEntries) {
      manifest.files.push(entry)
    }
    manifest.updated_at = new Date().toISOString()
    await saveManifest(manifest)
  }

  // ------------------------------------------------------------------
  // Step 5 — clearCache once
  // ------------------------------------------------------------------
  await clearCache()

  return { entries: succeeded, errors }
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
 */
export async function uploadEncryptedFile(id, encryptedBytes, onProgress) {
  if (encryptedBytes.byteLength < DIRECT_UPLOAD_THRESHOLD) {
    // Small file — proxy through the worker via XHR.
    await uploadFile(id, encryptedBytes, onProgress)
  } else {
    // Large file — browser PUTs directly to S3; worker only authorizes + commits.
    await uploadDirect(id, encryptedBytes, onProgress)
  }
}

/**
 * Direct-to-S3 upload path for large encrypted files.
 * Worker negotiates LFS credentials; browser PUTs raw bytes directly to S3.
 */
async function uploadDirect(id, encryptedBytes, onProgress) {
  const sha256 = await computeSha256Hex(encryptedBytes)
  const size = encryptedBytes.byteLength

  const preauth = await preauthUpload(id, size, sha256)

  if (!preauth.alreadyExists) {
    const { uploadUrl, uploadHeaders } = preauth
    await xhrPut(uploadUrl, uploadHeaders || {}, encryptedBytes, onProgress)
  }

  await commitUpload(id, sha256, size, preauth.verifyUrl ?? null, preauth.verifyHeaders ?? null)
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
