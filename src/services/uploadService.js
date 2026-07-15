/**
 * Client-side media upload pipeline.
 *
 * Local work is parallelized, encrypted objects upload with bounded network
 * concurrency, and one final HF commit publishes all file/chunk pointers,
 * changed thumbnail bundle data, and the encrypted manifest atomically.
 */

import { encryptPacked, encryptWithPool } from '../crypto/encrypt'
import { decryptPacked } from '../crypto/decrypt'
import { CHUNK_SIZE, encryptFileChunks } from '../crypto/chunkEncrypt'
import { getActiveKey } from '../crypto/keyDerivation'
import {
  BUNDLE_PAGE_SIZE,
  appendBundleEntry,
  createEmptyBundle,
  serializeBundlePage,
} from '../schema/bundleSchema'
import { loadBundlePage } from '../storage/bundle'
import { loadManifest, serializeManifestCompressed } from '../storage/manifest'
import * as worker from '../storage/workerClient'
import {
  clearCache,
  dequeueUpload,
  getCachedThumb,
  getUploadQueue,
  queueUpload,
  registerUploadSync,
  setCachedThumb,
} from '../session/cache'
import { EtaTracker } from '../utils/eta'
import { readMediaMetadata } from '../utils/exif'
import { generateThumbnail } from '../utils/thumbnail'
import { generateMediaId } from '../utils/uuid'

const CHUNK_THRESHOLD = 50 * 1024 * 1024
const CHUNK_WIRE_OVERHEAD = 4 + 12 + 16
const BATCH_CONCURRENCY = 3

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
) {
  const sourceFiles = Array.from(files || [])
  const errors = []
  const totalFiles = sourceFiles.length
  const report = (update) => onBatchProgress?.({
    totalFiles,
    completedFiles: 0,
    currentFile: '',
    stage: 'reading',
    overallPercent: 0,
    etaDisplay: 'calculating...',
    errors,
    ...update,
  })

  if (totalFiles === 0) return { entries: [], errors }

  report({ currentFile: sourceFiles[0].name })

  const settled = await Promise.allSettled(
    sourceFiles.map((file) => processFile(file, report, optimisticCallbacks)),
  )

  const processed = []
  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index]
    if (result.status === 'fulfilled') {
      processed.push(result.value)
    } else {
      const error = normalizeError(result.reason, 'Unable to prepare this file')
      errors.push({ file: sourceFiles[index], error })
    }
  }

  if (processed.length === 0) {
    report({ completedFiles: totalFiles, stage: 'error', errors })
    return { entries: [], errors }
  }

  const totalEncryptedBytes = processed.reduce((sum, item) => {
    if (!item.isChunked) return sum + item.encrypted.byteLength
    return sum + item.file.size + item.chunkCount * CHUNK_WIRE_OVERHEAD
  }, 0)
  const perFileLoaded = new Array(processed.length).fill(0)
  const eta = new EtaTracker(totalEncryptedBytes)
  const uploadResults = new Array(processed.length).fill(null)
  let completedFiles = totalFiles - processed.length

  const emitNetworkProgress = (index, stage = 'uploading') => {
    const loaded = perFileLoaded.reduce((sum, value) => sum + value, 0)
    eta.update(loaded)
    report({
      completedFiles,
      currentFile: processed[index]?.file.name ?? '',
      stage,
      overallPercent: totalEncryptedBytes === 0 ? 0 : loaded / totalEncryptedBytes,
      etaDisplay: stage === 'waiting' ? 'Waiting for connection' : eta.getEta().etaDisplay,
      errors,
    })
  }

  await runWithConcurrency(processed, BATCH_CONCURRENCY, async (item, index) => {
    try {
      uploadResults[index] = await uploadOne(
        item,
        index,
        perFileLoaded,
        emitNetworkProgress,
        optimisticCallbacks,
      )
    } catch (reason) {
      const error = normalizeError(reason, 'Upload failed')
      errors.push({ file: item.file, error })
      optimisticCallbacks.markOptimisticError?.(item.id, error.message)
      uploadResults[index] = { ok: false, error }
    } finally {
      completedFiles += 1
      emitNetworkProgress(index, uploadResults[index]?.ok ? 'done' : 'error')
    }
  })

  const succeeded = processed.filter((_, index) => uploadResults[index]?.ok)
  if (succeeded.length === 0) return { entries: [], errors }

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
    entries = await finalizeUploads(succeeded, uploadResults, processed)
  } catch (reason) {
    const error = normalizeError(reason, 'Unable to finalize the vault update')
    for (const item of succeeded) {
      errors.push({ file: item.file, error })
      optimisticCallbacks.markOptimisticError?.(item.id, error.message)
    }
    return { entries: [], errors }
  }

  for (const item of succeeded) {
    if (!item.isChunked) await dequeueUpload(item.id).catch(() => {})
    optimisticCallbacks.updateOptimisticState?.(item.id, {
      status: 'done',
      progress: 1,
      error: null,
    })
    optimisticCallbacks.removeOptimisticEntry?.(item.id)
  }

  await clearCache().catch(() => {})
  return { entries, errors }
}

/**
 * Finish small encrypted uploads left by an interrupted tab. A service worker
 * may already have uploaded the LFS object; the in-RAM key is only needed now
 * to rebuild and atomically publish the bundle and manifest.
 */
export async function resumeQueuedUploads(onBatchProgress, optimisticCallbacks = {}) {
  const queued = await getUploadQueue()
  if (queued.length === 0) return { entries: [], errors: [] }

  const errors = []
  const items = []
  for (const row of queued) {
    const thumbnail = row.thumbnail || await getCachedThumb(row.id).catch(() => null)
    if (!thumbnail) {
      errors.push({
        file: { name: row.entry?.name || row.id },
        error: new Error('The queued upload is missing its thumbnail cache'),
      })
      continue
    }

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
      encrypted: row.encryptedBytes instanceof Uint8Array
        ? row.encryptedBytes
        : new Uint8Array(row.encryptedBytes),
      isChunked: false,
      queuedReceipt: row.uploaded || null,
    }
    items.push(item)
    optimisticCallbacks.addOptimisticEntry?.(
      makeMediaEntry({
        id: item.id,
        file: item.file,
        metadata: item.metadata,
        thumbOffset: 0,
        thumbLength: item.thumbBytes.byteLength,
        isChunked: false,
      }),
      thumbnail,
    )
  }

  if (items.length === 0) return { entries: [], errors }

  const totalBytes = items.reduce((sum, item) => sum + item.encrypted.byteLength, 0)
  let loadedBytes = 0
  const uploadResults = new Array(items.length).fill(null)

  await runWithConcurrency(items, BATCH_CONCURRENCY, async (item, index) => {
    try {
      let receipt = item.queuedReceipt
      if (!receipt?.sha256) {
        const response = await withNetworkRecovery(
          () => worker.uploadFile(item.id, item.encrypted, (event) => {
            const current = loadedBytes + event.loaded
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
              overallPercent: current / totalBytes,
              etaDisplay: 'Resuming upload',
              errors,
            })
          }, false),
          () => optimisticCallbacks.updateOptimisticState?.(item.id, {
            status: 'waiting',
            progress: 0,
            error: null,
          }),
        )
        receipt = parseUploadResponse(response, item.id)
      }
      loadedBytes += item.encrypted.byteLength
      uploadResults[index] = { ok: true, file: {
        id: item.id,
        sha256: receipt.sha256,
        size: receipt.size,
      } }
    } catch (reason) {
      const error = normalizeError(reason, 'Unable to resume upload')
      errors.push({ file: item.file, error })
      optimisticCallbacks.markOptimisticError?.(item.id, error.message)
      uploadResults[index] = { ok: false, error }
    }
  })

  const succeeded = items.filter((_, index) => uploadResults[index]?.ok)
  if (succeeded.length === 0) return { entries: [], errors }

  onBatchProgress?.({
    totalFiles: items.length,
    completedFiles: items.length,
    currentFile: '',
    stage: 'finalizing',
    overallPercent: 1,
    etaDisplay: '',
    errors,
  })

  const entries = await finalizeUploads(succeeded, uploadResults, items)
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
  return { entries, errors }
}

async function processFile(file, report, optimisticCallbacks) {
  const id = generateMediaId()
  report({ currentFile: file.name, stage: 'reading' })

  const metadata = await readMediaMetadata(file)
  const thumbnail = await generateThumbnail(file, metadata.type)
  const thumbBytes = new Uint8Array(await thumbnail.arrayBuffer())
  const isChunked = file.size >= CHUNK_THRESHOLD
  let encrypted = null

  report({ currentFile: file.name, stage: 'encrypting' })
  if (!isChunked) {
    encrypted = new Uint8Array(
      await encryptWithPool(await file.arrayBuffer(), getActiveKey()),
    )
  }

  const optimisticEntry = makeMediaEntry({
    id,
    file,
    metadata,
    thumbOffset: 0,
    thumbLength: thumbBytes.byteLength,
    isChunked,
    chunkCount: isChunked ? Math.ceil(file.size / CHUNK_SIZE) : undefined,
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
    }, thumbnail).catch(() => {})
  }

  optimisticCallbacks.addOptimisticEntry?.(optimisticEntry, thumbnail, file)

  return {
    id,
    file,
    metadata,
    thumbnail,
    thumbBytes,
    encrypted,
    isChunked,
    chunkCount: isChunked ? Math.ceil(file.size / CHUNK_SIZE) : undefined,
  }
}

async function uploadOne(
  item,
  index,
  perFileLoaded,
  emitProgress,
  optimisticCallbacks,
) {
  const totalBytes = item.isChunked
    ? item.file.size + item.chunkCount * CHUNK_WIRE_OVERHEAD
    : item.encrypted.byteLength

  const updateState = (status, progress, error = null) => {
    optimisticCallbacks.updateOptimisticState?.(item.id, { status, progress, error })
  }

  updateState(item.isChunked ? 'encrypting' : 'uploading', 0)
  emitProgress(index)

  if (!item.isChunked) {
    const response = await withNetworkRecovery(
      () => worker.uploadFile(item.id, item.encrypted, (event) => {
        perFileLoaded[index] = event.loaded
        updateState('uploading', event.percent)
        emitProgress(index)
      }, false),
      () => {
        updateState('waiting', perFileLoaded[index] / totalBytes)
        emitProgress(index, 'waiting')
      },
    )

    perFileLoaded[index] = totalBytes
    updateState('uploading', 1)
    return { ok: true, file: parseUploadResponse(response, item.id) }
  }

  const chunks = []
  let uploadedBytes = 0
  for await (const chunk of encryptFileChunks(item.file, getActiveKey(), CHUNK_SIZE)) {
    updateState('uploading', uploadedBytes / totalBytes)
    const response = await withNetworkRecovery(
      () => worker.uploadChunk(item.id, chunk.index, chunk.encrypted, (event) => {
        perFileLoaded[index] = uploadedBytes + event.loaded
        updateState('uploading', perFileLoaded[index] / totalBytes)
        emitProgress(index)
      }, false),
      () => {
        updateState('waiting', uploadedBytes / totalBytes)
        emitProgress(index, 'waiting')
      },
    )

    const descriptor = parseUploadResponse(response, item.id)
    chunks.push({ ...descriptor, index: chunk.index })
    uploadedBytes += chunk.encrypted.byteLength
    perFileLoaded[index] = uploadedBytes
    emitProgress(index)
  }

  perFileLoaded[index] = totalBytes
  updateState('uploading', 1)
  return { ok: true, chunks }
}

async function finalizeUploads(succeeded, uploadResults, allProcessed) {
  const manifest = await loadManifest()
  const existingIds = new Set(manifest.files.map((entry) => entry.id))
  const pending = succeeded.filter((item) => !existingIds.has(item.id))
  if (pending.length === 0) return []

  let usePagedBundles = manifest.bundle_pages !== undefined || manifest.files.length === 0
  let initialPageEntries
  if (
    manifest.bundle_pages === 1 &&
    manifest.files.length > 0
  ) {
    initialPageEntries = await loadBundlePage(0)
    if (initialPageEntries.length === 0) {
      usePagedBundles = false
      delete manifest.bundle_pages
    }
  }
  let entries
  let bundleBytesBase64
  let bundlePages = []

  if (usePagedBundles) {
    const result = await buildPagedBundle(manifest, pending, initialPageEntries)
    entries = result.entries
    bundlePages = result.bundlePages
  } else {
    const result = await buildLegacyBundle(pending)
    entries = result.entries
    bundleBytesBase64 = result.bundleBytesBase64
  }

  manifest.files.push(...entries)
  manifest.updated_at = new Date().toISOString()
  const compressedManifest = await serializeManifestCompressed(manifest)
  const encryptedManifest = new Uint8Array(
    await encryptPacked(compressedManifest, getActiveKey()),
  )

  const files = []
  const chunks = []
  for (const item of pending) {
    const originalIndex = allProcessed.indexOf(item)
    const upload = uploadResults[originalIndex]
    if (upload.file) files.push(upload.file)
    if (upload.chunks) chunks.push(...upload.chunks)
  }

  await worker.commitBatch({
    files,
    chunks,
    manifestBytesBase64: bytesToBase64(encryptedManifest),
    bundleBytesBase64,
    bundlePages,
  })

  return entries
}

async function buildLegacyBundle(items) {
  let buffer
  try {
    buffer = await decryptPacked(await worker.getBundle(), getActiveKey())
  } catch (error) {
    if (error.status !== 404) throw error
    buffer = createEmptyBundle()
  }

  const entries = []
  for (const item of items) {
    const appended = appendBundleEntry(buffer, { id: item.id, bytes: item.thumbBytes })
    entries.push(makeMediaEntry({
      id: item.id,
      file: item.file,
      metadata: item.metadata,
      thumbOffset: appended.thumb_offset,
      thumbLength: appended.thumb_length,
      isChunked: item.isChunked,
      chunkCount: item.chunkCount,
    }))
    buffer = appended.bundle
  }

  const encrypted = new Uint8Array(await encryptPacked(buffer, getActiveKey()))
  return { entries, bundleBytesBase64: bytesToBase64(encrypted) }
}

async function buildPagedBundle(manifest, items, initialPageEntries) {
  let pageIndex = Math.max(0, (manifest.bundle_pages ?? 1) - 1)
  let pageEntries = initialPageEntries ?? await loadBundlePage(pageIndex)
  const changedPages = new Map()
  const entries = []

  for (const item of items) {
    if (pageEntries.length >= BUNDLE_PAGE_SIZE) {
      changedPages.set(pageIndex, pageEntries)
      pageIndex += 1
      pageEntries = await loadBundlePage(pageIndex)
    }

    const currentBuffer = serializeBundlePage(pageEntries)
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
    entry.chunk_size = CHUNK_SIZE
    entry.chunk_count = chunkCount
  }
  return entry
}

export function uploadEncryptedFile(id, encryptedBytes, onProgress, commit = true) {
  return worker.uploadFile(id, encryptedBytes, onProgress, commit)
}

async function withNetworkRecovery(operation, onWaiting) {
  let onlineFailures = 0

  while (true) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      onWaiting()
      void registerUploadSync()
      await waitForConnectivity()
    }

    try {
      return await operation()
    } catch (error) {
      const offline = (
        error?.status === 0 ||
        (typeof navigator !== 'undefined' && navigator.onLine === false)
      )
      if (!offline) throw error

      onWaiting()
      void registerUploadSync()
      if (typeof navigator !== 'undefined' && navigator.onLine !== false) {
        onlineFailures += 1
        if (onlineFailures >= 3) throw error
      }
      await waitForConnectivity()
    }
  }
}

function waitForConnectivity() {
  if (typeof window === 'undefined') return Promise.resolve()
  if (navigator.onLine !== false) {
    return new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return new Promise((resolve) => {
    window.addEventListener('online', resolve, { once: true })
  })
}

async function runWithConcurrency(items, limit, handler) {
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
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
