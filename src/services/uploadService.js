import { checkManifestRevision } from '../session/revision.js'
/**
 * Client-side media upload pipeline.
 *
 * Local work is parallelized with bounded memory, encrypted objects upload
 * with bounded network concurrency, and one atomic HF commit publishes all
 * file/chunk pointers, changed thumbnail bundle data, and the encrypted
 * manifest.
 *
 * Finalize is a snapshot-consistent transaction (W1):
 *   1. GET /vault-head            → current head commit oid
 *   2. all reads (manifest, bundle pages) pinned to ?revision=<oid>
 *   3. commitBatch { ..., parentCommit: <oid> }
 *   4. 409 VAULT_STALE → bounded rebase (re-read head/manifest, drop
 *      already-present ids, recommit), never last-writer-wins.
 * A Web Lock serializes tabs on top of the worker-side CAS.
 *
 * Chunked uploads queue FIRST with a sparse receipt row (U1): the row exists
 * from the moment local processing finishes, each landing chunk persists its
 * receipt atomically, and resume uploads only the missing chunks. Without the
 * source an interrupted row stays explicitly `needs-source` — it is never
 * silently finalized half-covered.
 */

import { encryptPacked, encryptWithPool } from '../crypto/encrypt'
import { decryptPacked } from '../crypto/decrypt'
import { CHUNK_SIZE, encryptFileChunk } from '../crypto/chunkEncrypt'
import { chunkContext, fileContext } from '../crypto/context'
import { getActiveKey } from '../crypto/keyDerivation'
import {
  BUNDLE_PAGE_SIZE,
  appendBundleEntry,
  createEmptyBundle,
  parseBundle,
  serializeBundlePage,
} from '../schema/bundleSchema'
import { loadBundlePage } from '../storage/bundle'
import { loadManifest, serializeManifestCompressed } from '../storage/manifest'
import * as worker from '../storage/workerClient'
import {
  clearCache,
  deleteCachedThumb,
  dequeueUpload,
  getCachedThumb,
  getUploadQueue,
  markChunkUploaded,
  markQueuedUploadUploaded,
  queueChunkedUploadPending,
  queueUpload,
  registerUploadSync,
  saveChunkPlaintextHash,
  setCachedThumb,
} from '../session/cache'
import {
  collectCommitReceipts,
  isVaultStaleError,
  MAX_FINALIZE_REBASE,
  parseVaultHead,
  selectPendingItems,
} from './vaultCommit'
import { groupPublications } from '../utils/publicationGroups.js'
import {
  isTransientUploadError,
  MAX_TRANSIENT_RETRIES,
  missingChunkIndexes,
  transientRetryDelayMs,
  UPLOAD_WINDOW_SIZE,
} from './uploadRecovery'
import { EtaTracker } from '../utils/eta'
import { abortableDelay, createAbortError, isAbortError, throwIfAborted } from '../utils/abort'
import { readMediaMetadata } from '../utils/exif'
import { generateThumbnail } from '../utils/thumbnail'
import { generateMediaId } from '../utils/uuid'
import { sha256Hex } from '../utils/hash'
import { withVaultLock } from '../utils/vaultLock'

const CHUNK_THRESHOLD = 50 * 1024 * 1024
const CHUNK_WIRE_OVERHEAD = 4 + 12 + 16
const PACKED_WIRE_OVERHEAD = 12 + 16
const CHUNK_UPLOAD_CONCURRENCY = 2

export async function uploadMedia(file, onProgress) {
  const emit = (phase, extra = {}) => onProgress?.({ phase, ...extra })

  const result = await uploadMediaBatch([file], (progress) => {
    if (progress.stage === 'reading') emit('reading')
    if (progress.stage === 'encrypting') emit('encrypting')
    if (progress.stage === 'uploading' || progress.stage === 'waiting') {
      emit('uploading', { percent: progress.overallPercent })
    }
    if (progress.stage === 'finalizing') emit('finalizing')
  })

  if (result.errors.length > 0) throw result.errors[0].error
  emit('done')
  return result.entries[0]
}

export async function uploadMediaBatch(
  files,
  onBatchProgress,
  optimisticCallbacks = {},
  options = {},
) {
  const { signal } = options
  const sourceFiles = Array.from(files || [])
  const errors = []
  const totalFiles = sourceFiles.length
  let progressSnapshot = {
    totalFiles,
    completedFiles: 0,
    currentFile: '',
    stage: 'reading',
    overallPercent: 0,
    etaDisplay: 'calculating...',
    errors,
  }
  const report = (update) => {
    progressSnapshot = {
      ...progressSnapshot,
      ...update,
      // Retries may restart a transfer; keep the displayed batch high-water
      // mark while the stage communicates waiting/retry/finalization.
      overallPercent: Math.max(progressSnapshot.overallPercent, update.overallPercent ?? 0),
    }
    onBatchProgress?.(progressSnapshot)
  }

  if (totalFiles === 0) return { entries: [], errors, needsSource: [] }
  throwIfAborted(signal)

  report({ currentFile: sourceFiles[0].name })

  const totalEncryptedBytes = sourceFiles.reduce((sum, file) => {
    const chunked = file.type.startsWith('video/') || file.size >= CHUNK_THRESHOLD
    if (!chunked) return sum + file.size + PACKED_WIRE_OVERHEAD
    return sum + file.size + Math.ceil(file.size / CHUNK_SIZE) * CHUNK_WIRE_OVERHEAD
  }, 0)
  const processed = new Array(totalFiles).fill(null)
  const perFileLoaded = new Array(totalFiles).fill(0)
  const eta = new EtaTracker(totalEncryptedBytes)
  const uploadResults = new Array(totalFiles).fill(null)
  let completedFiles = 0

  const emitNetworkProgress = (index, stage = 'uploading') => {
    const loaded = perFileLoaded.reduce((sum, value) => sum + value, 0)
    eta.update(loaded)
    report({
      completedFiles,
      currentFile: processed[index]?.file.name ?? sourceFiles[index]?.name ?? '',
      stage,
      overallPercent: totalEncryptedBytes === 0 ? 0 : Math.min(1, loaded / totalEncryptedBytes),
      etaDisplay: stage === 'waiting' ? 'Waiting for connection' : eta.getEta().etaDisplay,
      errors,
    })
  }

  try {
    // Stage large selections in windows (U4): only UPLOAD_WINDOW_SIZE files
    // are prepared + uploaded per window, bounding transient buffers.
    for (
      let windowStart = 0;
      windowStart < totalFiles;
      windowStart += UPLOAD_WINDOW_SIZE
    ) {
      throwIfAborted(signal)
      const windowIndexes = Array.from(
        { length: Math.min(UPLOAD_WINDOW_SIZE, totalFiles - windowStart) },
        (_, offset) => windowStart + offset,
      )
      await runWithConcurrency(
        windowIndexes,
        batchConcurrency(),
        async (index, positionInWindow) => {
          if (positionInWindow === 0) {
            report({ currentFile: sourceFiles[index].name })
          }
          let item = null
          try {
            throwIfAborted(signal)
            item = await processFile(sourceFiles[index], report, optimisticCallbacks, signal)
            processed[index] = item
            uploadResults[index] = await uploadOne(
              item,
              index,
              perFileLoaded,
              emitNetworkProgress,
              optimisticCallbacks,
              signal,
            )
          } catch (reason) {
            if (isAbortError(reason)) throw reason
            const error = normalizeError(reason, item ? 'Upload failed' : 'Unable to prepare this file')
            errors.push({ file: sourceFiles[index], error })
            if (item) optimisticCallbacks.markOptimisticError?.(item.id, error.message)
            uploadResults[index] = { ok: false, error }
          } finally {
            completedFiles += 1
            if (!signal?.aborted) {
              emitNetworkProgress(index, uploadResults[index]?.ok ? 'done' : 'error')
            }
          }
        },
        signal,
      )
    }

    throwIfAborted(signal)
    const succeeded = processed.filter((item, index) => item && uploadResults[index]?.ok)
    if (succeeded.length === 0) return { entries: [], errors, needsSource: [] }

    report({
      completedFiles,
      currentFile: '',
      stage: 'finalizing',
      overallPercent: 1,
      etaDisplay: '',
      errors,
    })

    let entries
    try {
      entries = await finalizeUploads(succeeded, uploadResults, processed, signal)
    } catch (reason) {
      if (isAbortError(reason)) throw reason
      const error = finalizeError(reason)
      for (const item of succeeded) {
        errors.push({ file: item.file, error })
        optimisticCallbacks.markOptimisticError?.(item.id, error.message)
      }
      return { entries: [], errors, needsSource: [] }
    }

    for (const item of succeeded) {
      // Receipts are already durable in the queue row; safe to drop the row
      // and the in-RAM ciphertext (U4).
      item.encrypted = null
      await dequeueUpload(item.id).catch(() => {})
      optimisticCallbacks.updateOptimisticState?.(item.id, {
        status: 'done',
        progress: 1,
        error: null,
      })
      optimisticCallbacks.removeOptimisticEntry?.(item.id)
    }

    await clearCache().catch(() => {})
    return { entries, errors, needsSource: [] }
  } catch (error) {
    if (isAbortError(error)) {
      if (!isLockAbort(signal)) {
        await Promise.all(processed.filter(Boolean).map(async (item) => {
          await dequeueUpload(item.id).catch(() => {})
          await deleteCachedThumb(item.id).catch(() => {})
        }))
      }
    }
    throw error
  }
}

/**
 * Finish uploads left by an interrupted tab/session.
 *
 * @param {Function} onBatchProgress
 * @param {object} optimisticCallbacks — add/update/remove/markError plus
 *   optional markOptimisticNeedsSource(id, message)
 * @param {object} options
 * @param {AbortSignal} [options.signal]
 * @param {string[]} [options.ids] — restrict to specific queued rows
 * @param {Map<string, File>} [options.sourceFiles] — id → source File for
 *   chunked rows that still miss chunks. Rows whose source is absent (or
 *   fails verification) are returned under `needsSource` instead of being
 *   finalized with partial receipts (U1).
 * @returns {Promise<{ entries: object[], errors: {file: object, error: Error}[], needsSource: {id: string, name: string}[] }>}
 */
export async function resumeQueuedUploads(
  onBatchProgress,
  optimisticCallbacks = {},
  options = {},
) {
  const { signal, ids, sourceFiles } = options
  throwIfAborted(signal)
  const requestedIds = ids?.length ? new Set(ids) : null
  const queued = (await getUploadQueue()).filter((row) => (
    row && (!requestedIds || requestedIds.has(row.id))
  ))
  if (queued.length === 0) return { entries: [], errors: [], needsSource: [] }

  const errors = []
  const needsSource = []
  const items = []

  for (const row of queued) {
    let thumbnail = row.thumbnail || await getCachedThumb(row.id).catch(() => null)
    if (!thumbnail) {
      // A missing thumbnail must not strand the row forever — fall back to a
      // generic safe JPEG placeholder so finalization can still proceed.
      thumbnail = placeholderThumbnail()
    }

    const isChunked = Boolean(row.chunked)
    const item = {
      id: row.id,
      file: { name: row.entry.name, size: row.entry.size },
      metadata: {
        type: row.entry.type,
        date_taken: row.entry.date_taken,
        duration: row.entry.duration ?? null,
      },
      thumbnail,
      thumbBytes: new Uint8Array(await thumbnail.arrayBuffer()),
      encrypted: isChunked
        ? null
        : row.encryptedBytes instanceof Uint8Array
          ? row.encryptedBytes
          : new Uint8Array(row.encryptedBytes),
      isChunked,
      chunkCount: isChunked ? row.entry.chunk_count : undefined,
      chunkSize: isChunked ? row.chunk_size ?? row.entry.chunk_size : undefined,
      chunkIndexes: isChunked ? missingChunkIndexes(row.chunks) : null,
      uploadedChunks: isChunked ? row.chunks : null,
      chunkHashes: isChunked ? row.chunkHashes ?? null : null,
      queuedReceipt: row.uploaded || null,
      sha256: row.sha256 || null,
      fileHash: row.fileHash || null,
      // Rows queued before context binding existed resume as legacy (v1).
      cryptoVersion: row.cryptoVersion === 2 ? 2 : 1,
      sourceFile: sourceFiles?.get(row.id) ?? null,
    }
    items.push(item)
    optimisticCallbacks.addOptimisticEntry?.(
      makeMediaEntry({
        id: item.id,
        file: item.file,
        metadata: item.metadata,
        thumbOffset: 0,
        thumbLength: item.thumbBytes.byteLength,
        isChunked,
        chunkCount: isChunked ? row.entry.chunk_count : undefined,
        chunkSize: isChunked ? item.chunkSize : undefined,
      }),
      thumbnail,
    )
  }

  if (items.length === 0) return { entries: [], errors, needsSource }

  const totalBytes = items.reduce(
    (sum, item) => sum + (item.encrypted?.byteLength || item.file.size),
    0,
  )
  let loadedBytes = 0
  const uploadResults = new Array(items.length).fill(null)

  await runWithConcurrency(items, batchConcurrency(), async (item, index) => {
    try {
      throwIfAborted(signal)
      if (item.isChunked) {
        if (item.chunkIndexes.length === 0) {
          // Fully covered by receipts — no source needed, straight to finalize.
          uploadResults[index] = { ok: true, chunks: item.uploadedChunks }
          loadedBytes += item.file.size
          return
        }
        if (!item.sourceFile) {
          throwIfAborted(signal)
          needsSource.push({ id: item.id, name: item.file.name })
          optimisticCallbacks.markOptimisticNeedsSource?.(
            item.id,
            'Re-select the original file to finish this upload',
          )
          uploadResults[index] = { ok: true, chunks: item.uploadedChunks, incomplete: true }
          return
        }
        uploadResults[index] = await resumeMissingChunks(item, {
          signal,
          totalFiles: items.length,
          index,
          errors,
          updateOptimisticState: optimisticCallbacks.updateOptimisticState,
          onBatchProgress: (event) => {
            optimisticCallbacks.updateOptimisticState?.(item.id, {
              status: event.status,
              progress: event.percent,
              error: null,
            })
            onBatchProgress?.({
              totalFiles: items.length,
              completedFiles: index,
              currentFile: item.file.name,
              stage: event.status === 'waiting' ? 'waiting' : 'uploading',
              overallPercent: Math.min(1, event.percent),
              etaDisplay: 'Resuming upload',
              errors,
            })
          },
        })
        loadedBytes += item.file.size
        return
      }

      let receipt = item.queuedReceipt
      if (!receipt?.sha256) {
        const sha256 = item.sha256 || await sha256Hex(item.encrypted)
        const response = await withNetworkRecovery(
          () => worker.uploadFile(item.id, item.encrypted, (event) => {
            optimisticCallbacks.updateOptimisticState?.(item.id, {
              status: 'uploading',
              progress: event.percent,
              error: null,
            })
            onBatchProgress?.({
              totalFiles: items.length,
              completedFiles: index,
              currentFile: item.file.name,
              stage: 'uploading',
              overallPercent: totalBytes === 0 ? 1 : (loadedBytes + event.loaded) / totalBytes,
              etaDisplay: 'Resuming upload',
              errors,
            })
          }, false, { signal, sha256 }),
          () => optimisticCallbacks.updateOptimisticState?.(item.id, {
            status: 'waiting',
            progress: 0,
            error: null,
          }),
          signal,
        )
        receipt = parseUploadResponse(response, item.id)
        // Receipt is durable; SW must never re-PUT this file (U1/U4).
        await markQueuedUploadUploaded(item.id, receipt).catch(() => {})
        item.encrypted = null
      }
      loadedBytes += item.file.size
      uploadResults[index] = { ok: true, file: receipt }
    } catch (reason) {
      if (isAbortError(reason)) throw reason
      const error = normalizeError(reason, 'Unable to resume upload')
      errors.push({ file: item.file, error })
      optimisticCallbacks.markOptimisticError?.(item.id, error.message)
      optimisticCallbacks.updateOptimisticState?.(item.id, {
        status: 'error',
        error: error.message,
      })
      uploadResults[index] = { ok: false, error }
    }
  }, signal)

  // Only items WITHOUT an explicit needsSource marker may reach finalize; a
  // partial chunked row is never finalized sparse (U1).
  const finalized = items
    .map((item, index) => ({ item, index }))
    .filter(({ index }) => {
      const result = uploadResults[index]
      return result?.ok && !result.incomplete
    })
  const succeeded = finalized.map(({ item }) => item)
  const finalizeResults = finalized.map(({ index }) => uploadResults[index])
  if (succeeded.length === 0) return { entries: [], errors, needsSource }

  onBatchProgress?.({
    totalFiles: items.length,
    completedFiles: items.length,
    currentFile: '',
    stage: 'finalizing',
    overallPercent: 1,
    etaDisplay: '',
    errors,
  })

  let entries
  try {
    const coverage = collectCommitReceipts(succeeded, finalizeResults)
    if (coverage.uncoveredItemIds.length > 0) {
      throw new Error('Chunk uploads are incomplete — re-select the source files to finish')
    }
    entries = await finalizeUploads(succeeded, uploadResults, items, signal)
  } catch (reason) {
    if (isAbortError(reason)) throw reason
    // commitBatch returned a non-OK status (e.g. 502). Mark every item that
    // had a successful file upload as failed so the UI shows an error card
    // instead of looping forever.
    const error = finalizeError(reason, 'Unable to finalize the vault update — server error')
    for (const item of succeeded) {
      errors.push({ file: item.file, error })
      optimisticCallbacks.markOptimisticError?.(item.id, error.message)
    }
    return { entries: [], errors, needsSource }
  }

  for (const item of succeeded) {
    await dequeueUpload(item.id).catch(() => {})
    optimisticCallbacks.updateOptimisticState?.(item.id, {
      status: 'done',
      progress: 1,
      error: null,
    })
    optimisticCallbacks.removeOptimisticEntry?.(item.id)
  }
  await clearCache().catch(() => {})
  return { entries, errors, needsSource }
}

async function processFile(file, report, optimisticCallbacks, signal) {
  const id = generateMediaId()
  try {
    throwIfAborted(signal)
    report({ currentFile: file.name, stage: 'reading' })

    const metadata = await readMediaMetadata(file, { signal })
    throwIfAborted(signal)
    const thumbnail = await generateThumbnail(file, metadata.type, { signal })
    const thumbBytes = new Uint8Array(await thumbnail.arrayBuffer())
    const isChunked = metadata.type === 'video' || file.size >= CHUNK_THRESHOLD
    // New uploads are context-bound (S3): AES-GCM AAD includes kind+id+index
    // so objects can never be swapped between files. Rows queued by older
    // versions stay legacy (no cryptoVersion) and resume in their own mode.
    const cryptoVersion = 2
    let encrypted = null
    let sha256 = null
    let fileHash = null
    let chunkCount
    let chunkHashes = null
    const chunkSize = isChunked ? CHUNK_SIZE : undefined

    report({ currentFile: file.name, stage: 'encrypting' })
    if (!isChunked) {
      // Bound peak memory: hash the plaintext before encryption, release the
      // plaintext copy as soon as the pool returns ciphertext (U4).
      let plaintext = new Uint8Array(await file.arrayBuffer())
      throwIfAborted(signal)
      fileHash = await sha256Hex(plaintext)
      encrypted = new Uint8Array(await encryptWithPool(plaintext, getActiveKey(), {
        context: fileContext(id),
      }))
      plaintext = null
      throwIfAborted(signal)
      sha256 = await sha256Hex(encrypted)
    } else {
      chunkCount = Math.ceil(file.size / CHUNK_SIZE)
      // Preflight: compute EVERY plaintext chunk hash (bounded to one 8 MiB
      // chunk in memory at a time) BEFORE any network chunk upload, so a
      // crashed partial row is strongly verifiable on source re-selection.
      chunkHashes = new Array(chunkCount)
      for (let index = 0; index < chunkCount; index += 1) {
        throwIfAborted(signal)
        const start = index * CHUNK_SIZE
        const end = Math.min(start + CHUNK_SIZE, file.size)
        chunkHashes[index] = await sha256Hex(await file.slice(start, end).arrayBuffer())
      }
      // Queue the sparse row only after the full fingerprint is ready.
      await queueChunkedUploadPending(
        id,
        {
          id,
          name: file.name,
          type: metadata.type,
          date_taken: metadata.date_taken,
          size: file.size,
          duration: metadata.duration ?? null,
          chunked: true,
          chunk_size: chunkSize,
          chunk_count: chunkCount,
        },
        thumbnail,
        chunkCount,
        chunkSize,
        chunkHashes,
        { chunkHashesReady: true, cryptoVersion },
      ).catch((error) => {
        optimisticCallbacks.markOptimisticError?.(id, error.message)
      })
    }
    const optimisticEntry = makeMediaEntry({
      id,
      file,
      metadata,
      thumbOffset: 0,
      thumbLength: thumbBytes.byteLength,
      isChunked,
      chunkCount: isChunked ? chunkCount : undefined,
      chunkSize: isChunked ? chunkSize : undefined,
      chunkHashes,
    })

    await setCachedThumb(id, thumbnail).catch(() => {})

    if (!isChunked) {
      await queueUpload(id, encrypted, {
        id,
        name: file.name,
        type: metadata.type,
        date_taken: metadata.date_taken,
        size: file.size,
        duration: metadata.duration ?? null,
      }, thumbnail, sha256, { fileHash, cryptoVersion }).catch(() => {})
    }

    throwIfAborted(signal)
    optimisticCallbacks.addOptimisticEntry?.(optimisticEntry, thumbnail, file)

    return {
      id,
      file,
      metadata,
      thumbnail,
      thumbBytes,
      encrypted,
      sha256,
      fileHash,
      isChunked,
      cryptoVersion,
      chunkCount: isChunked ? chunkCount : undefined,
      chunkSize: isChunked ? chunkSize : undefined,
      chunkHashes,
    }
  } catch (error) {
    if (isAbortError(error) && !isLockAbort(signal)) {
      await dequeueUpload(id).catch(() => {})
      await deleteCachedThumb(id).catch(() => {})
    }
    throw error
  }
}

async function uploadOne(
  item,
  index,
  perFileLoaded,
  emitProgress,
  optimisticCallbacks,
  signal,
) {
  if (item.isChunked) {
    const totalBytes = item.file.size + item.chunkCount * CHUNK_WIRE_OVERHEAD
    const chunks = new Array(item.chunkCount).fill(null)
    const updateState = (status, progress, error = null) => {
      optimisticCallbacks.updateOptimisticState?.(item.id, { status, progress, error })
    }

    updateState('encrypting', 0)
    perFileLoaded[index] = 0
    emitProgress(index)

    await uploadChunkIndexes(item, item.file, allChunkIndexes(item.chunkCount), item.chunkHashes, {
      onState: (status, progress) => updateState(status, progress),
      onProgress: (loaded) => {
        perFileLoaded[index] = loaded
        updateState('uploading', Math.min(1, loaded / totalBytes))
        emitProgress(index)
      },
      onWaiting: () => {
        updateState('waiting', perFileLoaded[index] / totalBytes)
        emitProgress(index, 'waiting')
      },
      onChunkDone: (chunkIndex, receipt) => {
        if (!chunks[chunkIndex]) chunks[chunkIndex] = receipt
        // Durable per-chunk receipt, one atomic readwrite tx (U1).
        void markChunkUploaded(item.id, chunkIndex, receipt).catch(() => {})
      },
    }, signal)

    perFileLoaded[index] = totalBytes
    updateState('uploading', 1)
    return { ok: true, chunks }
  }

  const totalBytes = item.encrypted.byteLength
  const updateState = (status, progress, error = null) => {
    optimisticCallbacks.updateOptimisticState?.(item.id, { status, progress, error })
  }

  updateState('uploading', 0)
  perFileLoaded[index] = 0
  emitProgress(index)

  const response = await withNetworkRecovery(
    () => worker.uploadFile(item.id, item.encrypted, (event) => {
      perFileLoaded[index] = event.loaded
      updateState('uploading', event.percent)
      emitProgress(index)
    }, false, { signal, sha256: item.sha256 }),
    () => {
      updateState('waiting', perFileLoaded[index] / totalBytes)
      emitProgress(index, 'waiting')
    },
    signal,
  )

  const receipt = parseUploadResponse(response, item.id)
  perFileLoaded[index] = totalBytes
  updateState('uploading', 1)
  // Receipt now reachable from the queue row even if finalize is interrupted.
  await markQueuedUploadUploaded(item.id, receipt).catch(() => {})
  // Free ciphertext early — finalize only needs receipts (U4).
  item.encrypted = null
  return { ok: true, file: receipt }
}

function allChunkIndexes(chunkCount) {
  return Array.from({ length: chunkCount }, (_, index) => index)
}

/**
 * Upload a set of chunk indexes with bounded concurrency. Shared by fresh
 * chunked uploads and sparse resume so both persist plaintext hashes before
 * the PUT and receipts after it, the same way.
 *
 * @param {object} item
 * @param {File} file — plaintext source (fresh upload or re-selected/resumed)
 * @param {number[]} indexes — chunk indexes to upload
 * @param {string[]|null} chunkHashes — expected PLAINTEXT sha256 per chunk
 *   (resume verification); null disables the cross-check
 * @param {object} callbacks — onState/onProgress/onWaiting/onChunkDone
 * @param {AbortSignal} [signal]
 */
async function uploadChunkIndexes(item, file, indexes, chunkHashes, callbacks, signal) {
  let uploadedBytes = 0
  const inflight = new Map()
  let inflightBytes = 0
  const chunkController = new AbortController()
  const abortChunks = () => chunkController.abort()
  signal?.addEventListener('abort', abortChunks, { once: true })

  const report = () => {
    callbacks.onProgress?.(uploadedBytes + inflightBytes)
  }

  try {
    await runWithConcurrency(
      indexes,
      CHUNK_UPLOAD_CONCURRENCY,
      async (chunkIndex, position) => {
        throwIfAborted(chunkController.signal)
        if (position === 0) callbacks.onState?.('encrypting', 0)
        const start = chunkIndex * CHUNK_SIZE
        const end = Math.min(start + CHUNK_SIZE, file.size)

        // Hash the plaintext slice BEFORE encrypting and persist it so source
        // re-selection stays verifiable even for chunk indexes that never
        // complete (U1).
        const plaintextHash = await fileSliceSha256(file, start, end)
        await saveChunkPlaintextHash(item.id, chunkIndex, plaintextHash).catch(() => {})
        const expectedHash = Array.isArray(chunkHashes) ? chunkHashes[chunkIndex] : null
        if (expectedHash && expectedHash !== plaintextHash) {
          throw new Error('The selected file does not match the original upload')
        }

        const chunk = await encryptFileChunk(
          file,
          getActiveKey(),
          chunkIndex,
          CHUNK_SIZE,
          item.cryptoVersion === 2 ? { context: chunkContext(item.id, chunkIndex) } : {},
        )
        throwIfAborted(chunkController.signal)
        const sha256 = await sha256Hex(chunk.encrypted)
        callbacks.onState?.('uploading', (uploadedBytes + inflightBytes) / (file.size + item.chunkCount * CHUNK_WIRE_OVERHEAD))

        const response = await withNetworkRecovery(
          () => {
            inflight.set(chunk.index, 0)
            report()
            return worker.uploadChunk(
              item.id,
              chunk.index,
              chunk.encrypted,
              (event) => {
                inflightBytes += event.loaded - (inflight.get(chunk.index) ?? 0)
                inflight.set(chunk.index, event.loaded)
                report()
              },
              false,
              { signal: chunkController.signal, sha256 },
            ).catch((error) => {
              inflightBytes -= inflight.get(chunk.index) ?? 0
              inflight.delete(chunk.index)
              report()
              throw error
            })
          },
          () => callbacks.onWaiting?.(),
          chunkController.signal,
        )

        const descriptor = parseUploadResponse(response, item.id)
        const receipt = { ...descriptor, index: chunk.index }
        // Exchange in-flight bytes for confirmed bytes in one synchronous
        // step. Removing them in `finally` caused a visible dip on every chunk.
        inflightBytes -= inflight.get(chunk.index) ?? 0
        inflight.delete(chunk.index)
        uploadedBytes += chunk.encrypted.byteLength
        report()
        await callbacks.onChunkDone?.(chunk.index, receipt)
      },
      chunkController.signal,
    )
  } catch (error) {
    // Landed receipts are already durable; abort stops new chunks (U1).
    chunkController.abort()
    throw error
  } finally {
    signal?.removeEventListener('abort', abortChunks)
  }
}

/**
 * Resume ONLY the missing chunks of a durable sparse chunked row (U1).
 * The re-encrypted plaintext of every missing chunk is cross-checked against
 * the hashes recorded during the original upload; a mismatch fails the item.
 *
 * @returns {Promise<{ ok: boolean, incomplete: boolean, chunks: object[] }>}
 */
async function resumeMissingChunks(item, options = {}) {
  const missing = item.chunkIndexes
  const source = item.sourceFile
  const resumeChunks = Array.from(
    item.uploadedChunks ?? new Array(item.chunkCount).fill(null),
    (entry) => entry ?? null,
  )
  let settledCount = item.chunkCount - missing.length
  let waiting = false

  const emitProgress = () => {
    options.onBatchProgress?.({
      status: waiting ? 'waiting' : 'uploading',
      percent: item.chunkCount === 0 ? 1 : Math.min(1, settledCount / item.chunkCount),
    })
  }

  await uploadChunkIndexes(item, source, missing, item.chunkHashes, {
    onState: (status, value) => {
      options.updateOptimisticState?.(item.id, {
        status: status === 'encrypting' ? 'uploading' : status,
        progress: value,
        error: null,
      })
    },
    onProgress: () => emitProgress(),
    onWaiting: () => {
      waiting = true
      emitProgress()
    },
    onChunkDone: (chunkIndex, receipt) => {
      resumeChunks[chunkIndex] = receipt
      settledCount += 1
      waiting = false
      // Receipt persistence mirrors the fresh-upload path (U1).
      void markChunkUploaded(item.id, chunkIndex, receipt).catch(() => {})
      options.updateOptimisticState?.(item.id, {
        status: 'uploading',
        progress: Math.min(1, settledCount / item.chunkCount),
        error: null,
      })
      emitProgress()
    },
  }, options.signal)

  const complete = isCoverageComplete(resumeChunks, item.chunkCount)
  if (complete) item.uploadedChunks = resumeChunks
  return { ok: true, incomplete: !complete, chunks: resumeChunks }
}

// chunk coverage helper (mirror of uploadRecovery.isChunkRowComplete typed for
// in-memory chunk receipt arrays)
function isCoverageComplete(chunks, count) {
  if (!Array.isArray(chunks) || chunks.length !== count) return false
  for (let index = 0; index < count; index += 1) if (!chunks[index]) return false
  return true
}

async function fileSliceSha256(file, start, end) {
  const slice = await file.slice(start, end).arrayBuffer()
  const hash = await sha256Hex(slice)
  return hash
}

/**
 * Snapshot-consistent finalize (W1). Runs under the Web Lock; reads one vault
 * head and pins every manifest/bundle read to that revision, then commits
 * with parentCommit. On 409 VAULT_STALE it rebases at most
 * MAX_FINALIZE_REBASE times: fresh head → fresh manifest → drop
 * already-present ids → recommit.
 */
async function finalizeUploads(succeeded, uploadResults, allProcessed, signal) {
  return withVaultLock(async () => {
    const groups = groupPublications(succeeded)
    const allEntries = []
    try {
      for (const group of groups) {
        let attempt = 0
        while (true) {
          throwIfAborted(signal)
          attempt += 1
          const head = await readVaultHead()
          const revision = head.oid

          // All reads below are pinned to the revision read just now.
          const manifest = await loadManifest(revision)
          const pending = selectPendingItems(group, manifest.files)
          if (pending.length === 0) break

          const receipts = collectCommitReceipts(
            pending,
            pending.map((item) => uploadResults[allProcessed.indexOf(item)] ?? {}),
          )
          if (receipts.uncoveredItemIds.length > 0) {
            throw new Error(
              `Chunk uploads incomplete for ${receipts.uncoveredItemIds.join(', ')} — finalize skipped`,
            )
          }

          // Attach worker-verified ciphertext digests so published entries
          // carry integrity metadata, and context-bound uploads publish the
          // `crypto_version` + digests the schema and decryptors require.
          annotatePendingItems(pending, receipts)

          let usePagedBundles = manifest.bundle_pages !== undefined || manifest.files.length === 0
          let initialPageEntries
          if (manifest.bundle_pages === 1 && manifest.files.length > 0) {
            initialPageEntries = await loadBundlePage(0, revision)
            if (initialPageEntries.length === 0) {
              usePagedBundles = false
              delete manifest.bundle_pages
            }
          }
          let entries
          let bundleBytesBase64
          let bundlePages = []

          if (usePagedBundles) {
            const result = await buildPagedBundle(manifest, pending, initialPageEntries, revision)
            entries = result.entries
            bundlePages = result.bundlePages
          } else {
            const result = await buildLegacyBundle(pending, revision)
            entries = result.entries
            bundleBytesBase64 = result.bundleBytesBase64
          }

          manifest.files.push(...entries)
          manifest.revision = (manifest.revision || 0) + 1
          manifest.updated_at = new Date().toISOString()
          const compressedManifest = await serializeManifestCompressed(manifest)
          const encryptedManifest = new Uint8Array(
            await encryptPacked(compressedManifest, getActiveKey()),
          )

          const payload = {
            files: receipts.files,
            chunks: receipts.chunks,
            manifestBytesBase64: bytesToBase64(encryptedManifest),
          }
          if (bundleBytesBase64) payload.bundleBytesBase64 = bundleBytesBase64
          if (bundlePages.length > 0) payload.bundlePages = bundlePages
          if (revision) payload.parentCommit = revision

          try {
            await worker.commitBatch(payload, { signal })
            await checkManifestRevision(manifest)
            allEntries.push(...entries)
            await clearCache().catch(() => {})
            break
          } catch (error) {
            if (!isVaultStaleError(error) || attempt > MAX_FINALIZE_REBASE) throw error
            // Head moved underneath us — loop re-reads head + manifest fresh and
            // drops ids the competing writer already committed.
          }
        }
      }
      await clearCache().catch(() => {})
      return allEntries
    } catch (error) {
      await clearCache().catch(() => {})
      throw error
    }
  })
}

/**
 * Copy worker-verified ciphertext digests from the (validated, complete)
 * receipts onto the pending items. `sha256` is whole-file only, `chunkSha256`
 * is index-aligned for chunked items — matching the manifest schema.
 */
function annotatePendingItems(pending, receipts) {
  for (const item of pending) {
    const fileReceipt = receipts.files.find((file) => file.id === item.id)
    if (fileReceipt) item.sha256 = fileReceipt.sha256
    const chunkReceipts = receipts.chunks
      .filter((chunk) => chunk.id === item.id)
      .sort((a, b) => a.index - b.index)
    if (chunkReceipts.length > 0) item.chunkSha256 = chunkReceipts.map((chunk) => chunk.sha256)
  }
}

async function buildLegacyBundle(items, revision) {
  let buffer
  try {
    buffer = await decryptPacked(await worker.getBundle(revision), getActiveKey())
  } catch (error) {
    if (error.status !== 404) throw error
    buffer = createEmptyBundle()
  }

  const entries = []
  const existingById = new Map(parseBundle(buffer).map((entry) => [entry.id, entry]))
  for (const item of items) {
    const existing = existingById.get(item.id)
    if (existing) {
      entries.push(makeMediaEntry({
        id: item.id,
        file: item.file,
        metadata: item.metadata,
        thumbOffset: existing.offset,
        thumbLength: existing.length,
        isChunked: item.isChunked,
        chunkCount: item.chunkCount,
        chunkSize: item.chunkSize,
        sha256: item.sha256,
        chunkSha256: item.chunkSha256,
        cryptoVersion: item.cryptoVersion,
      }))
      continue
    }

    const appended = appendBundleEntry(buffer, { id: item.id, bytes: item.thumbBytes })
    entries.push(makeMediaEntry({
      id: item.id,
      file: item.file,
      metadata: item.metadata,
      thumbOffset: appended.thumb_offset,
      thumbLength: appended.thumb_length,
      isChunked: item.isChunked,
      chunkCount: item.chunkCount,
      chunkSize: item.chunkSize,
      sha256: item.sha256,
      chunkSha256: item.chunkSha256,
      cryptoVersion: item.cryptoVersion,
    }))
    buffer = appended.bundle
    existingById.set(item.id, {
      id: item.id,
      offset: appended.thumb_offset,
      length: appended.thumb_length,
      bytes: item.thumbBytes,
    })
  }

  const encrypted = new Uint8Array(await encryptPacked(buffer, getActiveKey()))
  return { entries, bundleBytesBase64: bytesToBase64(encrypted) }
}

async function buildPagedBundle(manifest, items, initialPageEntries, revision) {
  let pageIndex = Math.max(0, (manifest.bundle_pages ?? 1) - 1)
  let pageEntries = initialPageEntries ?? await loadBundlePage(pageIndex, revision)
  const changedPages = new Map()
  const entries = []

  for (const item of items) {
    let currentBuffer = serializeBundlePage(pageEntries)
    let existing = parseBundle(currentBuffer).find((entry) => entry.id === item.id)

    if (!existing && pageEntries.length >= BUNDLE_PAGE_SIZE) {
      changedPages.set(pageIndex, pageEntries)
      pageIndex += 1
      pageEntries = await loadBundlePage(pageIndex, revision)
      currentBuffer = serializeBundlePage(pageEntries)
      existing = parseBundle(currentBuffer).find((entry) => entry.id === item.id)
    }

    if (existing) {
      entries.push(makeMediaEntry({
        id: item.id,
        file: item.file,
        metadata: item.metadata,
        thumbOffset: existing.offset,
        thumbLength: existing.length,
        pageIndex,
        isChunked: item.isChunked,
        chunkCount: item.chunkCount,
        chunkSize: item.chunkSize,
        sha256: item.sha256,
        chunkSha256: item.chunkSha256,
        cryptoVersion: item.cryptoVersion,
      }))
      continue
    }

    const appended = appendBundleEntry(currentBuffer, {
      id: item.id,
      bytes: item.thumbBytes,
    })
    pageEntries = [...pageEntries, { id: item.id, bytes: item.thumbBytes }]
    changedPages.set(pageIndex, pageEntries)

    entries.push(makeMediaEntry({
      id: item.id,
      file: item.file,
      metadata: item.metadata,
      thumbOffset: appended.thumb_offset,
      thumbLength: appended.thumb_length,
      pageIndex,
      isChunked: item.isChunked,
      chunkCount: item.chunkCount,
      chunkSize: item.chunkSize,
      sha256: item.sha256,
      chunkSha256: item.chunkSha256,
      cryptoVersion: item.cryptoVersion,
    }))
  }

  manifest.bundle_pages = Math.max(manifest.bundle_pages ?? 1, pageIndex + 1)

  const bundlePages = await Promise.all(
    [...changedPages.entries()].map(async ([index, page]) => {
      const encrypted = new Uint8Array(
        await encryptPacked(serializeBundlePage(page), getActiveKey()),
      )
      return { pageIndex: index, bytesBase64: bytesToBase64(encrypted) }
    }),
  )

  return { entries, bundlePages }
}

function makeMediaEntry({
  id,
  file,
  metadata,
  thumbOffset,
  thumbLength,
  pageIndex,
  isChunked,
  chunkCount,
  chunkSize,
  sha256,
  chunkSha256,
  cryptoVersion,
}) {
  const entry = {
    id,
    name: file.name,
    type: metadata.type,
    date_taken: metadata.date_taken,
    size: file.size,
    duration: metadata.duration ?? null,
    thumb_offset: thumbOffset,
    thumb_length: thumbLength,
  }

  if (pageIndex !== undefined) entry.page_index = pageIndex
  if (isChunked) {
    entry.chunked = true
    entry.chunk_size = chunkSize || CHUNK_SIZE
    entry.chunk_count = chunkCount
    // Index-aligned ciphertext digests (worker-verified). Only attach when the
    // array is complete — the schema rejects length !== chunk_count.
    if (Array.isArray(chunkSha256) && chunkSha256.length === chunkCount) {
      entry.chunk_sha256 = chunkSha256
    }
  } else if (typeof sha256 === 'string' && sha256.length > 0) {
    entry.sha256 = sha256
  }
  // Only new-format (context-bound) ciphertext may claim crypto_version 2;
  // legacy/resumed rows stay legacy so their decryption keeps working.
  if (cryptoVersion === 2) entry.crypto_version = 2
  return entry
}

export function uploadEncryptedFile(id, encryptedBytes, onProgress, commit = true) {
  return worker.uploadFile(id, encryptedBytes, onProgress, commit)
}

/**
 * GET /vault-head — required for snapshot-consistent finalize. There is no
 * legacy unpinned fallback: a missing/invalid head fails explicitly.
 */
async function readVaultHead() {
  const head = parseVaultHead(await worker.getVaultHead())
  if (!head || !head.oid || !/^[0-9a-f]{40}$/i.test(head.oid)) {
    throw new Error('Vault is not initialized — /vault-head returned no valid revision')
  }
  return head
}

/**
 * Transport-error recovery (U5): offline waits for connectivity (held at
 * 'waiting' in the UI), transient server failures (429, gateway 5xx, explicit
 * retryable) auto-retry at most MAX_TRANSIENT_RETRIES times with a bounded
 * backoff honoring Retry-After. Validation 4xx and aborts never retry.
 */
async function withNetworkRecovery(operation, onWaiting, signal) {
  let transientRetries = 0

  while (true) {
    throwIfAborted(signal)
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      onWaiting()
      void registerUploadSync()
      await waitForConnectivity(signal)
      continue
    }

    try {
      return await operation()
    } catch (error) {
      if (isAbortError(error)) throw error
      const offline = (
        error?.status === 0 ||
        (typeof navigator !== 'undefined' && navigator.onLine === false)
      )
      if (offline) {
        onWaiting()
        void registerUploadSync()
        if (typeof navigator !== 'undefined' && navigator.onLine !== false) {
          // status === 0 while claiming to be online: treat as transient
          // transport failure and fall through to the bounded retry below.
          transientRetries += 1
          if (transientRetries > MAX_TRANSIENT_RETRIES) throw error
        }
        await waitForConnectivity(signal)
        continue
      }

      if (!isTransientUploadError(error)) throw error
      transientRetries += 1
      if (transientRetries > MAX_TRANSIENT_RETRIES) throw error
      onWaiting()
      void registerUploadSync()
      await abortableDelay(transientRetryDelayMs(error, transientRetries), signal)
    }
  }
}

function waitForConnectivity(signal) {
  if (typeof window === 'undefined') return Promise.resolve()
  if (navigator.onLine !== false) {
    return abortableDelay(1000, signal)
  }
  return new Promise((resolve, reject) => {
    const onOnline = () => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    const onAbort = () => {
      window.removeEventListener('online', onOnline)
      reject(createAbortError())
    }
    window.addEventListener('online', onOnline, { once: true })
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function runWithConcurrency(items, limit, handler, signal) {
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        throwIfAborted(signal)
        const index = cursor
        cursor += 1
        await handler(items[index], index)
      }
    },
  )
  await Promise.all(workers)
}

function parseUploadResponse(response, id) {
  const data = response instanceof ArrayBuffer
    ? JSON.parse(new TextDecoder().decode(response))
    : response
  if (!data?.sha256 || !Number.isFinite(data.size)) {
    throw new Error('Storage returned an invalid upload receipt')
  }
  return { id, sha256: data.sha256, size: data.size }
}

function bytesToBase64(bytes) {
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.byteLength; index += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}

function normalizeError(reason, fallback) {
  if (reason instanceof Error) return reason
  return new Error(fallback)
}

function finalizeError(reason, fallback = 'Unable to finalize the vault update') {
  const error = normalizeError(reason, fallback)
  if (error === reason && !error.code && isVaultStaleError(error)) {
    // surface stale-vault conflicts distinctly for the UI
    error.code = 'VAULT_STALE'
  }
  return error
}

export function isLockAbort(signal) {
  return Boolean(signal?.reason?.vaultLock)
}

/**
 * Bounded per-batch network concurrency (U4): smaller pools on low-core /
 * mobile devices keep transient memory (decode + clone + encrypt) in check.
 */
export function batchConcurrency() {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 8
  if (Number.isFinite(cores) && cores > 0 && cores <= 4) return 2
  return 3
}


function placeholderThumbnail() {
  const base64 = '/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAyAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEoAAQAAAAAAAAAAAAAAAAAAAAABAQAAAAAAAAAAAAAAAAAAAAAQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAABAAEDASIAAhEAAxEA/9oADAMBAAIRAxEAPwAAD//Z'
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: 'image/jpeg' })
}
