/**
 * VaultPhotos Service Worker — Background Sync
 *
 * Handles the 'vault-upload-queue' Background Sync tag. When the browser fires
 * a sync event (after tab close or network reconnect), processUploadQueue reads
 * any pending encrypted blobs from IndexedDB and retries their upload.
 *
 * NOTE: Background Sync is not supported on Safari (as of 2025). The upload
 * queue in IndexedDB still provides value even without sync — on next app open
 * the app can detect incomplete uploads and prompt the user.
 *
 * The service worker intentionally does NOT hold or know the AES key. It only
 * retries the raw binary upload to the worker — the encrypted bytes are already
 * pre-encrypted before they enter the queue.
 */

const DB_NAME = 'vaultphotos-session'
const DB_VERSION = 2
const QUEUE_STORE = 'uploadQueue'

// ---------------------------------------------------------------------------
// Sync event — triggered by browser after connectivity resumes
// ---------------------------------------------------------------------------

self.addEventListener('sync', (event) => {
  if (event.tag === 'vault-upload-queue') {
    event.waitUntil(processUploadQueue())
  }
})

// ---------------------------------------------------------------------------
// Queue processor
// ---------------------------------------------------------------------------

async function processUploadQueue() {
  const workerUrl = await getWorkerUrl()
  if (!workerUrl) {
    console.warn('[SW] VITE_WORKER_URL not stored — cannot retry uploads')
    return
  }

  const db = await openDB()
  const items = await getAllQueueItems(db)

  for (const item of items) {
    try {
      await retryUpload(workerUrl, item.id, item.encryptedBytes)
      await deleteQueueItem(db, item.id)
    } catch (err) {
      console.warn(`[SW] Retry failed for ${item.id}:`, err)
      // Leave in queue — will retry on next sync event.
    }
  }
}

/**
 * Retry sending an encrypted blob through the worker proxy.
 * The SW cannot use the direct-to-S3 path (no SHA-256 recomputation needed;
 * the blob is already encrypted and we just send it as-is to the proxy).
 */
async function retryUpload(workerUrl, id, encryptedBytes) {
  const res = await fetch(`${workerUrl}/upload-file?id=${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: encryptedBytes,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Worker returned ${res.status}: ${text.slice(0, 200)}`)
  }
}

// ---------------------------------------------------------------------------
// Read the worker URL stored at install time from cache/IDB
// ---------------------------------------------------------------------------

/**
 * The main app stores VITE_WORKER_URL in a dedicated IDB entry so the SW can
 * read it without access to import.meta.env (which is not available in SW).
 * Stored by UploadContext before the first upload.
 */
async function getWorkerUrl() {
  try {
    const db = await openDB()
    const tx = db.transaction('kv', 'readonly')
    const store = tx.objectStore('kv')
    return await store.get('workerUrl')
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Minimal IndexedDB helpers (no idb library in SW context)
// ---------------------------------------------------------------------------

function openDB() {
  return new Promise((resolve, reject) => {
    const req = self.indexedDB.open(DB_NAME, DB_VERSION)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv')
      }
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { keyPath: 'id' })
      }
    }
  })
}

function getAllQueueItems(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readonly')
    const store = tx.objectStore(QUEUE_STORE)
    const req = store.getAll()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function deleteQueueItem(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readwrite')
    const store = tx.objectStore(QUEUE_STORE)
    const req = store.delete(id)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}
