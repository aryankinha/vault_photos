/**
 * UploadContext — global upload state.
 *
 * Holds the in-progress batch upload state so the PersistentUploadBar can
 * render on any route while an upload is running. Also owns the wake lock
 * lifecycle and triggers visibilitychange re-acquisition.
 *
 * The useUploadContext hook lives in ./useUploadContext.js (separated so this
 * file only exports a component, satisfying react-refresh).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { openDB } from 'idb'
import { uploadMediaBatch } from '../services/uploadService'
import { requestWakeLock, releaseWakeLock } from '../utils/wakeLock'
import { UploadContext } from './uploadContextValue'

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

export function UploadProvider({ children }) {
  const [isUploading, setIsUploading] = useState(false)
  const [batchProgress, setBatchProgress] = useState(/** @type {BatchProgress|null} */ (null))

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
      const db = await openDB('vaultphotos-session', 2)
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
      })
    } finally {
      await releaseWakeLock(wakeLockRef.current)
      wakeLockRef.current = null
      setIsUploading(false)
      // Keep batchProgress visible briefly so the user sees 100% / errors.
      setTimeout(() => setBatchProgress(null), 3000)
    }
  }, [isUploading])

  const cancelBatch = useCallback(() => {
    cancelRef.current = true
  }, [])

  return (
    <UploadContext.Provider value={{ isUploading, batchProgress, startBatch, cancelBatch }}>
      {children}
    </UploadContext.Provider>
  )
}
