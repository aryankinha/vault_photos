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
 * The useUploadContext hook lives in ./useUploadContext.js (separated so this
 * file only exports a component, satisfying react-refresh).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { resumeQueuedUploads, uploadMediaBatch } from '../services/uploadService'
import { dequeueUpload, setWorkerUrl } from '../session/cache'
import { requestWakeLock, releaseWakeLock } from '../utils/wakeLock'
import { UploadContext } from './uploadContextValue'
import { cryptoPool } from '../workers/cryptoWorkerPool'

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
 * @typedef {{ status: 'encrypting'|'uploading'|'waiting'|'done'|'error', progress: number, error: string|null }} OptimisticState
 */

export function UploadProvider({ children }) {
  const [isUploading, setIsUploading] = useState(false)
  const [batchProgress, setBatchProgress] = useState(/** @type {BatchProgress|null} */ (null))

  // ---------------------------------------------------------------------------
  // V3 — Optimistic UI state
  // ---------------------------------------------------------------------------
  const [optimisticEntries, setOptimisticEntries] = useState(/** @type {object[]} */ ([]))
  const [optimisticThumbs, setOptimisticThumbs] = useState(() => new Map())
  const [optimisticStates, setOptimisticStates] = useState(() => new Map())
  const sourceFilesRef = useRef(new Map())
  const retryQueueRef = useRef([])
  const resumeAttemptedRef = useRef(false)
  const progressTimerRef = useRef(null)
  const optimisticRemovalTimersRef = useRef(new Map())
  const uploadGenerationRef = useRef(0)

  /**
   * Called as soon as a file finishes local encryption — before any network upload.
   * The photo appears in the gallery immediately.
   */
  const addOptimisticEntry = useCallback((entry, thumbBlob, sourceFile) => {
    setOptimisticEntries((prev) => [...prev, entry])
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
    const timer = setTimeout(() => {
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

  // cancel flag — checked between file uploads
  const cancelRef = useRef(false)
  // current wake lock handle
  const wakeLockRef = useRef(null)

  // Re-acquire wake lock when page regains visibility during an active upload.
  useEffect(() => {
    async function onVisibilityChange() {
      if (document.visibilityState === 'visible' && isUploading) {
        wakeLockRef.current = await requestWakeLock()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [isUploading])

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
   * Start a batch upload. Returns immediately — upload runs in background.
   * @param {File[]} files
   */
  const startBatch = useCallback(async (files) => {
    if (isUploading) {
      retryQueueRef.current.push(...files)
      return
    }
    clearTimeout(progressTimerRef.current)
    const generation = uploadGenerationRef.current
    cancelRef.current = false
    setIsUploading(true)
    setBatchProgress(null)

    await storeWorkerUrl()
    const wakeLock = await requestWakeLock()
    wakeLockRef.current = wakeLock

    try {
      if (generation !== uploadGenerationRef.current) return
      await uploadMediaBatch(files, (progress) => {
        if (generation === uploadGenerationRef.current) setBatchProgress(progress)
      }, {
        addOptimisticEntry: (...args) => {
          if (generation === uploadGenerationRef.current) addOptimisticEntry(...args)
        },
        updateOptimisticState: (...args) => {
          if (generation === uploadGenerationRef.current) updateOptimisticState(...args)
        },
        removeOptimisticEntry: (...args) => {
          if (generation === uploadGenerationRef.current) removeOptimisticEntry(...args)
        },
        markOptimisticError: (...args) => {
          if (generation === uploadGenerationRef.current) markOptimisticError(...args)
        },
      })
    } catch (error) {
      if (generation === uploadGenerationRef.current) setBatchProgress({
        totalFiles: files.length,
        completedFiles: files.length,
        currentFile: '',
        stage: 'error',
        overallPercent: 0,
        etaDisplay: '',
        errors: [{ file: files[0], error }],
      })
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
        setIsUploading(false)
        // Keep batchProgress visible briefly so the user sees 100% / errors.
        progressTimerRef.current = setTimeout(() => setBatchProgress(null), 3000)
      }
    }
  }, [isUploading, addOptimisticEntry, updateOptimisticState, removeOptimisticEntry, markOptimisticError])

  const resumePendingUploads = useCallback(async () => {
    if (resumeAttemptedRef.current || isUploading) return
    resumeAttemptedRef.current = true
    const generation = uploadGenerationRef.current
    setIsUploading(true)
    const wakeLock = await requestWakeLock()
    wakeLockRef.current = wakeLock
    try {
      const result = await resumeQueuedUploads((progress) => {
        if (generation === uploadGenerationRef.current) setBatchProgress(progress)
      }, {
        addOptimisticEntry: (...args) => {
          if (generation === uploadGenerationRef.current) addOptimisticEntry(...args)
        },
        updateOptimisticState: (...args) => {
          if (generation === uploadGenerationRef.current) updateOptimisticState(...args)
        },
        removeOptimisticEntry: (...args) => {
          if (generation === uploadGenerationRef.current) removeOptimisticEntry(...args)
        },
        markOptimisticError: (...args) => {
          if (generation === uploadGenerationRef.current) markOptimisticError(...args)
        },
      })
      if (generation === uploadGenerationRef.current && result.errors.length > 0) {
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
    } catch (error) {
      if (generation !== uploadGenerationRef.current) return
      // Do NOT reset resumeAttemptedRef here — if commitBatch returns 502 we
      // must not restart the whole loop. The user must explicitly retry.
      setBatchProgress({
        totalFiles: 1,
        completedFiles: 1,
        currentFile: '',
        stage: 'error',
        overallPercent: 0,
        etaDisplay: '',
        errors: [{ file: { name: 'Queued upload' }, error }],
      })
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
        setIsUploading(false)
        clearTimeout(progressTimerRef.current)
        progressTimerRef.current = setTimeout(() => setBatchProgress(null), 3000)
      }
    }
  }, [isUploading, addOptimisticEntry, updateOptimisticState, removeOptimisticEntry, markOptimisticError])

  const retryOptimistic = useCallback((id) => {
    const sourceFile = sourceFilesRef.current.get(id)

    clearTimeout(optimisticRemovalTimersRef.current.get(id))
    optimisticRemovalTimersRef.current.delete(id)
    setOptimisticEntries((prev) => prev.filter((entry) => entry.id !== id))
    setOptimisticThumbs((prev) => { const next = new Map(prev); next.delete(id); return next })
    setOptimisticStates((prev) => { const next = new Map(prev); next.delete(id); return next })
    sourceFilesRef.current.delete(id)

    if (!sourceFile) {
      resumeAttemptedRef.current = false
      if (!isUploading) void resumePendingUploads()
      return
    }

    // Retrying creates a fresh media id. Remove the failed encrypted queue row
    // first so recovery cannot later publish both attempts as separate files.
    void dequeueUpload(id).catch(() => {})

    if (isUploading) {
      retryQueueRef.current.push(sourceFile)
      return
    }
    void startBatch([sourceFile])
  }, [isUploading, resumePendingUploads, startBatch])

  useEffect(() => {
    if (isUploading || retryQueueRef.current.length === 0) return
    const queued = retryQueueRef.current.splice(0)
    Promise.resolve().then(() => startBatch(queued))
  }, [isUploading, startBatch])

  const cancelBatch = useCallback(() => {
    cancelRef.current = true
    uploadGenerationRef.current += 1
    cryptoPool.terminate()
    setIsUploading(false)
  }, [])

  const lockUploadSession = useCallback(() => {
    cancelRef.current = true
    uploadGenerationRef.current += 1
    cryptoPool.terminate()
    void releaseWakeLock(wakeLockRef.current)
    wakeLockRef.current = null
    setIsUploading(false)
    setBatchProgress(null)
    setOptimisticEntries([])
    setOptimisticThumbs(new Map())
    setOptimisticStates(new Map())
    sourceFilesRef.current.clear()
    retryQueueRef.current = []
    resumeAttemptedRef.current = false
    clearTimeout(progressTimerRef.current)
    for (const timer of optimisticRemovalTimersRef.current.values()) clearTimeout(timer)
    optimisticRemovalTimersRef.current.clear()
  }, [])

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
      // V3 optimistic state
      optimisticEntries,
      optimisticThumbs,
      optimisticStates,
      addOptimisticEntry,
      updateOptimisticState,
      removeOptimisticEntry,
      markOptimisticError,
      retryOptimistic,
      resumePendingUploads,
      lockUploadSession,
    }}>
      {children}
    </UploadContext.Provider>
  )
}
