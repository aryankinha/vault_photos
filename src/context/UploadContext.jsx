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
import { openDB } from 'idb'
import { uploadMediaBatch } from '../services/uploadService'
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
 * @typedef {{ status: 'encrypting'|'uploading'|'done'|'error', progress: number, error: string|null }} OptimisticState
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

  /**
   * Called as soon as a file finishes local encryption — before any network upload.
   * The photo appears in the gallery immediately.
   */
  const addOptimisticEntry = useCallback((entry, thumbBlob) => {
    setOptimisticEntries((prev) => [...prev, entry])
    setOptimisticThumbs((prev) => new Map(prev).set(entry.id, thumbBlob))
    setOptimisticStates((prev) => new Map(prev).set(entry.id, { status: 'encrypting', progress: 0, error: null }))
  }, [])

  /**
   * Update upload progress for an in-flight optimistic entry.
   * @param {string} id
   * @param {{ status: string, progress: number, error: string|null }} state
   */
  const updateOptimisticState = useCallback((id, state) => {
    setOptimisticStates((prev) => new Map(prev).set(id, state))
  }, [])

  /**
   * Remove an optimistic entry after the real manifest confirms it.
   * The real entry is now in the manifest so this is no longer needed.
   * @param {string} id
   */
  const removeOptimisticEntry = useCallback((id) => {
    setOptimisticEntries((prev) => prev.filter((e) => e.id !== id))
    setOptimisticThumbs((prev) => { const m = new Map(prev); m.delete(id); return m })
    setOptimisticStates((prev) => { const m = new Map(prev); m.delete(id); return m })
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
   * Re-attempt a failed upload. Resets its state to 'encrypting' and triggers
   * the upload service for that single entry. For now this is a stub that clears
   * the error state — full retry logic is an exercise for a future settings pass.
   * @param {string} id
   */
  const retryOptimistic = useCallback((id) => {
    setOptimisticStates((prev) => new Map(prev).set(id, { status: 'encrypting', progress: 0, error: null }))
    // TODO: re-enqueue the encrypted file from the IDB upload queue and retry.
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
      const db = await openDB('vaultphotos-session', 3)
      await db.put('kv', import.meta.env.VITE_WORKER_URL, 'workerUrl')
    } catch {
      // Non-fatal.
    }
  }

  /**
   * Start a batch upload. Returns immediately — upload runs in background.
   * @param {File[]} files
   */
  const startBatch = useCallback(async (files) => {
    if (isUploading) return
    cancelRef.current = false
    setIsUploading(true)
    setBatchProgress(null)

    await storeWorkerUrl()
    wakeLockRef.current = await requestWakeLock()

    try {
      await uploadMediaBatch(files, (progress) => {
        setBatchProgress(progress)
      }, {
        addOptimisticEntry,
        updateOptimisticState,
        removeOptimisticEntry,
        markOptimisticError,
      })
    } finally {
      await releaseWakeLock(wakeLockRef.current)
      wakeLockRef.current = null
      setIsUploading(false)
      // Keep batchProgress visible briefly so the user sees 100% / errors.
      setTimeout(() => setBatchProgress(null), 3000)
    }
  }, [isUploading, addOptimisticEntry, updateOptimisticState, removeOptimisticEntry, markOptimisticError])

  const cancelBatch = useCallback(() => {
    cancelRef.current = true
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
    }}>
      {children}
    </UploadContext.Provider>
  )
}

