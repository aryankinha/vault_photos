/**
 * Session cache. Holds only the *decrypted raw bytes* of the manifest and
 * thumbnail bundle in IndexedDB so the gallery loads instantly after the first
 * unlock in a session. The encryption key is NEVER written here — only RAM.
 *
 * The cache is wiped on lock and there is no TTL; if the worker returns a
 * fresher copy the caller can overwrite via setManifestCache/setBundleCache.
 */
import { openDB } from 'idb'

const DB_NAME = 'vaultphotos-session'
const DB_VERSION = 1
const STORE = 'kv'
const MANIFEST_KEY = 'manifest'
const BUNDLE_KEY = 'bundle'

let dbPromise = null

function db() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(STORE)) {
          database.createObjectStore(STORE)
        }
      },
    })
  }
  return dbPromise
}

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
