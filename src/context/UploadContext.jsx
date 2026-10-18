/**
 * UploadContext — global upload state.
 *
 * Holds the in-progress batch upload state so the PersistentUploadBar can
 * render on any route while an upload is running. Also owns the wake lock
 * lifecycle and triggers visibilitychange re-acquisition.
 *
 * V3 adds optimistic UI state:
 *   optimisticEntries   — MediaEntry objects locally ready, not yet on HF
 *   optimisticThumbs    — Map<id, Blob> for their thumbnails
 *   optimisticStates    — Map<id, { status, progress, error }>
 *
 * Correctness fixes (Feb 2026 pass):
 *   - LOCKING PRESERVES THE QUEUE: lockInSession aborts with a lock reason but
 *     never deletes queue rows; only an explicit cancel deletes. Interrupted
 *     uploads resume after the next unlock (ciphertext-only rows).
 *   - Retry clicks are never dropped: while an upload runs they are queued
 *     (bounded) and drained when the slot frees.
 *   - Stale guards: optimistic-removal timers and wake-lock re-acquisition
 *     check the upload generation before mutating state.
 *   - pendingUploadCount refreshes live while queue rows appear mid-session
 *     (onUploadQueueChanged subscription), not only at batch end.
 *   - reselectUploadSource(id, file) verifies a re-selected source against the
 *     recorded plaintext hashes before attaching it to a needs-source row.
 *
 * The useUploadContext hook lives in ./useUploadContext.js (separated so this
 * file only exports a component, satisfying react-refresh).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  resumeQueuedUploads,
  uploadMediaBatch,
} from '../services/uploadService'
import { verifyReselectedFile } from '../services/uploadRecovery'
import {
  clearUploadQueue,
  getQueuedUpload,
  getUploadQueue,
  onUploadQueueChanged,
  setWorkerUrl,
} from '../session/cache'
import { requestWakeLock, releaseWakeLock } from '../utils/wakeLock'
import { UploadContext } from './uploadContextValue'
import { cryptoPool } from '../workers/cryptoWorkerPool'
import { isAbortError } from '../utils/abort'
import { createLockAbortError } from '../utils/vaultLock'
import { enqueueSelectedFiles } from '../utils/uploadQueue'

/**
 * @typedef {Object} BatchProgress
 * @property {number} totalFiles
 * @property {number} completedFiles
 * @property {string} currentFile
 * @property {string} stage
 * @property {number} overallPercent   0..1
 * @property {string} etaDisplay
 * @property {{ file: File, error: Error }[]} errors
 */

/**
 * @typedef {{ status: 'encrypting'|'uploading'|'waiting'|'needs-source'|'done'|'error', progress: number, error: string|null }} OptimisticState
 */

// Retry clicks queued while an upload runs are bounded (U3): overflow is
// rejected with an explicit error instead of growing invisibly.
const RETRY_QUEUE_LIMIT = 50

export function UploadProvider({ children }) {
  const [isUploading, setIsUploading] = useState(false)
  const [batchProgress, setBatchProgress] = useState(/** @type {BatchProgress|null} */ (null))

  // ---------------------------------------------------------------------------
  // V3 — Optimistic UI state
  // ---------------------------------------------------------------------------
  const [optimisticEntries, setOptimisticEntries] = useState(/** @type {object[]} */ ([]))
  const [optimisticThumbs, setOptimisticThumbs] = useState(() => new Map())
  const [optimisticStates, setOptimisticStates] = useState(() => new Map())
  const [pendingUploadCount, setPendingUploadCount] = useState(0)
  const [pendingUploads, setPendingUploads] = useState(/** @type {object[]} */ ([]))
  const sourceFilesRef = useRef(new Map())
  const retryQueueRef = useRef([])
  const progressTimerRef = useRef(null)
  const optimisticRemovalTimersRef = useRef(new Map())
  const uploadGenerationRef = useRef(0)
  const uploadRunningRef = useRef(false)
  const activeControllerRef = useRef(null)
  const activeUploadIdsRef = useRef(new Set())
  const queueCleanupRef = useRef(Promise.resolve())

  const refreshPendingCount = useCallback(async () => {
    const rows = await getUploadQueue().catch(() => [])
    setPendingUploadCount(rows.length)
    // Decorate rows with the in-RAM source file (if the user re-selected one
    // this session) so the recovery UI can offer a direct resume instead of
    // always asking for the source again.
    setPendingUploads(rows.map((row) => ({
      ...row,
      sourceFile: sourceFilesRef.current.get(row.id) ?? null,
    })))
    return rows.length
  }, [])

  useEffect(() => {
    Promise.resolve().then(() => refreshPendingCount())
  }, [refreshPendingCount])

  // Queue rows can appear mid-session (encryption finishes -> row persisted).
  // Keep the interrupted banner count live instead of waiting for batch end.
  useEffect(() => onUploadQueueChanged(() => {
    void refreshPendingCount()
  }), [refreshPendingCount])

  /**
   * Called as soon as a file finishes local encryption — before any network upload.
   * The photo appears in the gallery immediately.
   */
  const addOptimisticEntry = useCallback((entry, thumbBlob, sourceFile) => {
    if (uploadRunningRef.current) activeUploadIdsRef.current.add(entry.id)
    setOptimisticEntries((prev) => (
      prev.some((item) => item.id === entry.id) ? prev : [...prev, entry]
    ))
    setOptimisticThumbs((prev) => new Map(prev).set(entry.id, thumbBlob))
    setOptimisticStates((prev) => new Map(prev).set(entry.id, { status: 'encrypting', progress: 0, error: null }))
    if (sourceFile) sourceFilesRef.current.set(entry.id, sourceFile)
  }, [])

  /**
   * Update upload progress for an in-flight optimistic entry.
   * @param {string} id
   * @param {{ status: string, progress: number, error: string|null }} state
   */
  const updateOptimisticState = useCallback((id, state) => {
    setOptimisticStates((prev) => {
      const next = new Map(prev)
      next.set(id, { ...next.get(id), ...state })
      return next
    })
  }, [])

  /**
   * Remove an optimistic entry after the real manifest confirms it.
   * The real entry is now in the manifest so this is no longer needed.
   * @param {string} id
   */
  const removeOptimisticEntry = useCallback((id) => {
    clearTimeout(optimisticRemovalTimersRef.current.get(id))
    const generation = uploadGenerationRef.current
    const timer = setTimeout(() => {
      // Stale guard: a timer set by a cancelled/locked generation must not
      // mutate the state of the current one.
      if (generation !== uploadGenerationRef.current) {
        optimisticRemovalTimersRef.current.delete(id)
        return
      }
      setOptimisticEntries((prev) => prev.filter((e) => e.id !== id))
      setOptimisticThumbs((prev) => { const m = new Map(prev); m.delete(id); return m })
      setOptimisticStates((prev) => { const m = new Map(prev); m.delete(id); return m })
      sourceFilesRef.current.delete(id)
      optimisticRemovalTimersRef.current.delete(id)
    }, 10_000)
    optimisticRemovalTimersRef.current.set(id, timer)
  }, [])

  /**
   * Mark an entry as failed with an error message.
   * @param {string} id
   * @param {string} errorMsg
   */
  const markOptimisticError = useCallback((id, errorMsg) => {
    setOptimisticStates((prev) => new Map(prev).set(id, { status: 'error', progress: 0, error: errorMsg }))
  }, [])

  /**
   * Mark an entry as explicitly blocked on a re-selected source file — never
   * silently finalized with partial chunk receipts.
   * @param {string} id
   * @param {string} errorMsg
   */
  const markOptimisticNeedsSource = useCallback((id, errorMsg) => {
    setOptimisticStates((prev) => new Map(prev).set(id, {
      status: 'needs-source',
      progress: prev.get(id)?.progress ?? 0,
      error: errorMsg,
    }))
  }, [])

  // current wake lock handle
  const wakeLockRef = useRef(null)

  // Bridge callbacks into generation-guarded versions for the current upload
  // slot (one place instead of the five-copy spread used previously).
  const makeOptimisticBridge = (generation, callbacks) => {
    const guard = (fn) => (...args) => {
      if (generation === uploadGenerationRef.current) fn(...args)
    }
    return {
      addOptimisticEntry: guard(callbacks.addOptimisticEntry),
      updateOptimisticState: guard(callbacks.updateOptimisticState),
      removeOptimisticEntry: guard(callbacks.removeOptimisticEntry),
      markOptimisticError: guard(callbacks.markOptimisticError),
      markOptimisticNeedsSource: guard(callbacks.markOptimisticNeedsSource),
    }
  }

  // Re-acquire wake lock when page regains visibility during an active upload.
  // Stale guard: visibility is evaluated against the live upload state so a
  // cancelled/locked upload never writes a lock after its cleanup released it.
  useEffect(() => {
    async function onVisibilityChange() {
      if (document.visibilityState !== 'visible' || !uploadRunningRef.current) return
      const generation = uploadGenerationRef.current
      const lock = await requestWakeLock()
      if (generation !== uploadGenerationRef.current || !uploadRunningRef.current) {
        void releaseWakeLock(lock)
        return
      }
      wakeLockRef.current = lock
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [])

  /**
   * Store VITE_WORKER_URL in IndexedDB so the service worker can read it.
   * The SW cannot access import.meta.env, so we bridge it via IDB.
   */
  async function storeWorkerUrl() {
    try {
      await setWorkerUrl(import.meta.env.VITE_WORKER_URL)
    } catch {
      // Non-fatal.
    }
  }

  /**
   * Common upload loop tail: run `body` with the wake-lock + optimistic
   * callbacks wired up, then release the lock and refresh the pending count.
   */
  const runUploadSlot = useCallback(async (body) => {
    if (uploadRunningRef.current) return
    const generation = uploadGenerationRef.current
    const controller = new AbortController()
    uploadRunningRef.current = true
    activeControllerRef.current = controller
    setIsUploading(true)
    const wakeLock = await requestWakeLock()
    if (generation !== uploadGenerationRef.current) {
      void releaseWakeLock(wakeLock)
      uploadRunningRef.current = false
      activeControllerRef.current = null
      setIsUploading(false)
      return
    }
    wakeLockRef.current = wakeLock
    try {
      await body(controller, generation)
    } finally {
      await releaseWakeLock(wakeLock)
      if (
        generation === uploadGenerationRef.current &&
        wakeLockRef.current &&
        wakeLockRef.current !== wakeLock
      ) {
        await releaseWakeLock(wakeLockRef.current)
        wakeLockRef.current = null
      } else if (wakeLockRef.current === wakeLock) {
        wakeLockRef.current = null
      }
      if (generation === uploadGenerationRef.current) {
        uploadRunningRef.current = false
        activeUploadIdsRef.current.clear()
        if (activeControllerRef.current === controller) activeControllerRef.current = null
        setIsUploading(false)
        clearTimeout(progressTimerRef.current)
        // Keep the tail state (100% / errors / needs-source) briefly visible.
        progressTimerRef.current = setTimeout(() => setBatchProgress(null), 3000)
        void refreshPendingCount()
      }
    }
  }, [refreshPendingCount])

  /**
   * Start a batch upload. Returns immediately — upload runs in background.
   * @param {File[]} files
   */
  const startBatch = useCallback(async (files) => {
    if (uploadRunningRef.current) {
      enqueueSelectedFiles(retryQueueRef.current, files, RETRY_QUEUE_LIMIT)
      return
    }
    clearTimeout(progressTimerRef.current)
    await queueCleanupRef.current.catch(() => {})
    // Another start (e.g. the retry drain) may have claimed the slot while we
    // waited for cleanup — queue instead of racing/dropping.
    if (uploadRunningRef.current) {
      enqueueSelectedFiles(retryQueueRef.current, files, RETRY_QUEUE_LIMIT)
      return
    }
    await runUploadSlot(async (controller, generation) => {
      await storeWorkerUrl()
      if (generation !== uploadGenerationRef.current) return
      try {
        await uploadMediaBatch(files, (progress) => {
          if (generation === uploadGenerationRef.current) setBatchProgress(progress)
        }, makeOptimisticBridge(generation, {
          addOptimisticEntry,
          updateOptimisticState,
          removeOptimisticEntry,
          markOptimisticError,
          markOptimisticNeedsSource,
        }), { signal: controller.signal })
      } catch (error) {
        if (isAbortError(error)) return
        if (generation === uploadGenerationRef.current) setBatchProgress({
          totalFiles: files.length,
          completedFiles: files.length,
          currentFile: '',
          stage: 'error',
          overallPercent: 0,
          etaDisplay: '',
          errors: [{ file: files[0], error }],
        })
      }
    })
  }, [addOptimisticEntry, updateOptimisticState, removeOptimisticEntry, markOptimisticError, markOptimisticNeedsSource, runUploadSlot])

  const resumePendingUploads = useCallback(async (ids = null, sourceFiles = null) => {
    // A re-selected source (or one retained from this session) is attached to
    // the recovery queue BEFORE the resume runs — including the queued path —
    // so an interrupted chunked row never resumes source-less by accident.
    if (sourceFiles instanceof Map) {
      for (const [id, file] of sourceFiles) {
        if (id && file) sourceFilesRef.current.set(id, file)
      }
    }
    if (uploadRunningRef.current) {
      if (retryQueueRef.current.length < RETRY_QUEUE_LIMIT) {
        retryQueueRef.current.push({ type: 'resume', ids })
      }
      return
    }
    clearTimeout(progressTimerRef.current)
    await runUploadSlot(async (controller, generation) => {
      try {
        const result = await resumeQueuedUploads((progress) => {
          if (generation === uploadGenerationRef.current) setBatchProgress(progress)
        }, makeOptimisticBridge(generation, {
          addOptimisticEntry,
          updateOptimisticState,
          removeOptimisticEntry,
          markOptimisticError,
          markOptimisticNeedsSource,
        }), {
          signal: controller.signal,
          ids,
          sourceFiles: sourceFilesRef.current,
        })
        if (generation === uploadGenerationRef.current) {
          if (result.needsSource.length > 0) {
            // rows stay queued + explicitly needs-source (not finalize-sparse);
            // the pending count still reflects them until resolved.
            void refreshPendingCount()
          }
          if (result.errors.length > 0 && result.entries.length === 0) {
            setBatchProgress({
              totalFiles: result.entries.length + result.errors.length,
              completedFiles: result.entries.length + result.errors.length,
              currentFile: '',
              stage: 'error',
              overallPercent: result.entries.length > 0 ? 1 : 0,
              etaDisplay: '',
              errors: result.errors,
            })
          }
        }
      } catch (error) {
        if (generation !== uploadGenerationRef.current) return
        if (isAbortError(error)) return
        setBatchProgress({
          totalFiles: 1,
          completedFiles: 1,
          currentFile: '',
          stage: 'error',
          overallPercent: 0,
          etaDisplay: '',
          errors: [{ file: { name: 'Queued upload' }, error }],
        })
      }
    })
  }, [addOptimisticEntry, updateOptimisticState, removeOptimisticEntry, markOptimisticError, markOptimisticNeedsSource, refreshPendingCount, runUploadSlot])

  // (bridged callbacks already exist in makeOptimisticBridge above)

  /**
   * Attach a re-selected source file to a needs-source queue row. The row
   * keeps its media id; the file is verified STRONGLY (per-chunk plaintext
   * hashes / whole-file plaintext hash) before it is accepted — file
   * size/name alone are never treated as sufficient.
   *
   * @param {string} id
   * @param {File} file
   * @returns {Promise<boolean>} — true when the source was accepted
   */
  const reselectUploadSource = useCallback(async (id, file) => {
    const row = await getQueuedUpload(id).catch(() => null)
    let verification = { ok: true }
    if (row) {
      verification = await verifyReselectedFile(row, file).catch((error) => ({
        ok: false,
        reason: 'error',
        detail: error?.message,
      }))
    }
    if (!verification.ok) {
      markOptimisticNeedsSource(id, verification.reason === 'hash-mismatch'
        ? 'The selected file does not match the original upload'
        : verification.reason === 'size-mismatch'
          ? 'The selected file has a different size — pick the exact original file'
          : 'This upload cannot verify a re-selected file (missing integrity records)')
      return false
    }

    // Keep the same id; the row stays in the queue and resumes with the
    // remaining-chunk flow.
    sourceFilesRef.current.set(id, file)
    if (uploadRunningRef.current) {
      if (retryQueueRef.current.length < RETRY_QUEUE_LIMIT) {
        retryQueueRef.current.push({ type: 'resume', ids: [id] })
      }
    } else {
      await resumePendingUploads([id])
    }
    return true
  }, [markOptimisticNeedsSource, resumePendingUploads])

  const retryOptimistic = useCallback((id) => {
    void (async () => {
      clearTimeout(optimisticRemovalTimersRef.current.get(id))
      optimisticRemovalTimersRef.current.delete(id)

      // Small uploads retain their encrypted queue row and media id; chunked
      // uploads retain their sparse receipt row. Retrying the same row is
      // idempotent even if HF committed before a 502. While an upload runs the
      // click is QUEUED, never dropped.
      if (uploadRunningRef.current) {
        if (retryQueueRef.current.length < RETRY_QUEUE_LIMIT) {
          retryQueueRef.current.push({ type: 'resume', ids: [id] })
        } else {
          markOptimisticError(id, 'Retry queue is full — try again after the current batch')
        }
        return
      }
      if (await getQueuedUpload(id).catch(() => null)) {
        updateOptimisticState(id, { status: 'uploading', progress: 0, error: null })
        await resumePendingUploads([id])
        return
      }

      const sourceFile = sourceFilesRef.current.get(id)
      setOptimisticEntries((prev) => prev.filter((entry) => entry.id !== id))
      setOptimisticThumbs((prev) => { const next = new Map(prev); next.delete(id); return next })
      setOptimisticStates((prev) => { const next = new Map(prev); next.delete(id); return next })
      sourceFilesRef.current.delete(id)

      if (!sourceFile) return
      if (uploadRunningRef.current) retryQueueRef.current.push({ type: 'file', file: sourceFile })
      else await startBatch([sourceFile])
    })()
  }, [resumePendingUploads, startBatch, updateOptimisticState, markOptimisticError])

  // Drain queued retries once the upload slot frees. Resume actions run
  // first, then fresh file batches.
  useEffect(() => {
    if (isUploading || retryQueueRef.current.length === 0) return
    const queued = retryQueueRef.current.splice(0)
    Promise.resolve().then(async () => {
      const resumeIds = []
      const files = []
      for (const action of queued) {
        if (action.type === 'resume') {
          resumeIds.push(...(action.ids ?? []))
        } else if (action.file) {
          files.push(action.file)
        }
      }
      if (resumeIds.length > 0) await resumePendingUploads(resumeIds)
      if (files.length > 0) await startBatch(files)
    })
  }, [isUploading, startBatch, resumePendingUploads])

  const cancelBatch = useCallback(() => {
    const activeIds = [...activeUploadIdsRef.current]
    activeControllerRef.current?.abort()
    activeControllerRef.current = null
    uploadRunningRef.current = false
    activeUploadIdsRef.current.clear()
    uploadGenerationRef.current += 1
    cryptoPool.terminate()
    retryQueueRef.current = []
    // A cancel deletes its queue rows; a LOCK must not (see lockUploadSession).
    queueCleanupRef.current = activeIds.length > 0
      ? clearUploadQueue(activeIds).catch(() => {})
      : Promise.resolve()
    void queueCleanupRef.current.then(() => refreshPendingCount())
    void releaseWakeLock(wakeLockRef.current)
    wakeLockRef.current = null
    setIsUploading(false)
    setOptimisticEntries([])
    setOptimisticThumbs(new Map())
    setOptimisticStates(new Map())
    sourceFilesRef.current.clear()
    clearTimeout(progressTimerRef.current)
    // Cancel also clears optimistic-removal timers (U3).
    for (const timer of optimisticRemovalTimersRef.current.values()) clearTimeout(timer)
    optimisticRemovalTimersRef.current.clear()
    setBatchProgress((previous) => previous ? {
      ...previous,
      currentFile: '',
      stage: 'cancelled',
      etaDisplay: '',
    } : null)
    progressTimerRef.current = setTimeout(() => setBatchProgress(null), 2500)
  }, [refreshPendingCount])

  const dismissBatchProgress = useCallback(() => {
    clearTimeout(progressTimerRef.current)
    setBatchProgress(null)
  }, [])

  const discardPendingUploads = useCallback(async (ids = null) => {
    const targets = Array.isArray(ids) && ids.length > 0 ? ids : null
    await clearUploadQueue(targets ?? undefined).catch(() => {})
    if (targets) {
      // Selective discard: only the named rows leave the queue/optimistic UI.
      for (const id of targets) {
        sourceFilesRef.current.delete(id)
        clearTimeout(optimisticRemovalTimersRef.current.get(id))
        optimisticRemovalTimersRef.current.delete(id)
      }
      setOptimisticEntries((prev) => prev.filter((entry) => !targets.includes(entry.id)))
      setOptimisticThumbs((prev) => {
        const next = new Map(prev)
        for (const id of targets) next.delete(id)
        return next
      })
      setOptimisticStates((prev) => {
        const next = new Map(prev)
        for (const id of targets) next.delete(id)
        return next
      })
    } else {
      setOptimisticEntries([])
      setOptimisticThumbs(new Map())
      setOptimisticStates(new Map())
      sourceFilesRef.current.clear()
      setBatchProgress(null)
    }
    await refreshPendingCount()
  }, [refreshPendingCount])

  const lockUploadSession = useCallback(() => {
    // Abort with a LOCK reason: the service pipeline keeps every queue row
    // (they are ciphertext-only + thumbnails) so the interrupted uploads are
    // resumable after the next unlock. Only cancelBatch deletes rows.
    activeControllerRef.current?.abort(createLockAbortError())
    activeControllerRef.current = null
    uploadRunningRef.current = false
    activeUploadIdsRef.current.clear()
    uploadGenerationRef.current += 1
    cryptoPool.terminate()
    queueCleanupRef.current = Promise.resolve()
    void releaseWakeLock(wakeLockRef.current)
    wakeLockRef.current = null
    setIsUploading(false)
    setBatchProgress(null)
    setOptimisticEntries([])
    setOptimisticThumbs(new Map())
    setOptimisticStates(new Map())
    sourceFilesRef.current.clear()
    retryQueueRef.current = []
    clearTimeout(progressTimerRef.current)
    for (const timer of optimisticRemovalTimersRef.current.values()) clearTimeout(timer)
    optimisticRemovalTimersRef.current.clear()
    // Queue rows survive the lock — refresh the visible count from disk.
    void refreshPendingCount()
  }, [refreshPendingCount])

  // ---------------------------------------------------------------------------
  // V3 — terminate crypto worker pool on vault lock (UploadProvider unmounts)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      cryptoPool.terminate()
    }
  }, [])

  return (
    <UploadContext.Provider value={{
      isUploading,
      batchProgress,
      startBatch,
      cancelBatch,
      dismissBatchProgress,
      // V3 optimistic state
      optimisticEntries,
      optimisticThumbs,
      optimisticStates,
      addOptimisticEntry,
      updateOptimisticState,
      removeOptimisticEntry,
      markOptimisticError,
      markOptimisticNeedsSource,
      retryOptimistic,
      resumePendingUploads,
      reselectUploadSource,
      pendingUploadCount,
      pendingUploads,
      discardPendingUploads,
      lockUploadSession,
    }}>
      {children}
    </UploadContext.Provider>
  )
}
