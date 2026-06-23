/**
 * Session cache. Holds only the *decrypted raw bytes* of the manifest and
 * thumbnail bundle in IndexedDB so the gallery loads instantly after the first
 * unlock in a session. The encryption key is NEVER written here — only RAM.
 *
 * The cache is wiped on lock and there is no TTL; if the worker returns a
 * fresher copy the caller can overwrite via setManifestCache/setBundleCache.
 *
 * V2 adds a separate 'uploadQueue' object store for background sync. Each entry
 * is { id, encryptedBytes, entry } — the already-encrypted file bytes and the
 * manifest entry, persisted before the network upload begins so a service worker
 * can retry them if the tab closes mid-upload.
 */
import { openDB } from 'idb'

const DB_NAME = 'vaultphotos-session'
// Bump version to 2 so the upgrade callback can create the new store.
const DB_VERSION = 2
const STORE = 'kv'
const MANIFEST_KEY = 'manifest'
const BUNDLE_KEY = 'bundle'
const QUEUE_STORE = 'uploadQueue'

let dbPromise = null

function db() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(database, oldVersion) {
        // v1 → create the kv store (original)
        if (oldVersion < 1) {
          if (!database.objectStoreNames.contains(STORE)) {
            database.createObjectStore(STORE)
          }
        }
        // Support opening a DB that was created at v1 without the kv store
        // (shouldn't happen, but be defensive).
        if (!database.objectStoreNames.contains(STORE)) {
          database.createObjectStore(STORE)
        }
        // v2 → create the uploadQueue store keyed by file id
        if (oldVersion < 2) {
          if (!database.objectStoreNames.contains(QUEUE_STORE)) {
            database.createObjectStore(QUEUE_STORE, { keyPath: 'id' })
          }
        }
        if (!database.objectStoreNames.contains(QUEUE_STORE)) {
          database.createObjectStore(QUEUE_STORE, { keyPath: 'id' })
        }
      },
    })
  }
  return dbPromise
}

// ---------------------------------------------------------------------------
// Existing functions — DO NOT CHANGE SIGNATURES
// ---------------------------------------------------------------------------

export async function getManifestCache() {
  return (await db()).get(STORE, MANIFEST_KEY)
}

export async function setManifestCache(bytes) {
  await (await db()).put(STORE, bytes, MANIFEST_KEY)
}

export async function getBundleCache() {
  return (await db()).get(STORE, BUNDLE_KEY)
}

export async function setBundleCache(bytes) {
  await (await db()).put(STORE, bytes, BUNDLE_KEY)
}

export async function clearCache() {
  await (await db()).clear(STORE)
}

// ---------------------------------------------------------------------------
// V2 — upload queue (for background sync / tab-close recovery)
// ---------------------------------------------------------------------------

/**
 * Persist an already-encrypted upload to the queue so a service worker can
 * retry it if the tab closes before the network upload completes.
 *
 * @param {string} id — 16-hex file id
 * @param {Uint8Array} encryptedBytes
 * @param {object} entry — manifest entry object (without thumb_offset/thumb_length yet)
 */
export async function queueUpload(id, encryptedBytes, entry) {
  await (await db()).put(QUEUE_STORE, { id, encryptedBytes, entry })
}

/**
 * Remove a completed upload from the queue.
 * @param {string} id
 */
export async function dequeueUpload(id) {
  await (await db()).delete(QUEUE_STORE, id)
}

/**
 * Return all pending uploads in the queue.
 * @returns {Promise<{ id: string, encryptedBytes: Uint8Array, entry: object }[]>}
 */
export async function getUploadQueue() {
  return (await db()).getAll(QUEUE_STORE)
}
