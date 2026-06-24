/**
 * cryptoWorkerPool.js — Pool of crypto Web Workers.
 *
 * Maintains up to POOL_SIZE parallel workers and distributes encrypt/decrypt
 * jobs across them using a simple round-robin dispatcher. Each job is
 * identified by a unique id so out-of-order completions (via Transferable
 * zero-copy postMessage) resolve to the correct Promise.
 *
 * Usage:
 *   import { encryptWithPool, decryptWithPool, shutdownPool } from './cryptoWorkerPool'
 *
 *   const encrypted = await encryptWithPool(arrayBuffer, cryptoKey)
 *   const decrypted = await decryptWithPool(encryptedBuffer, cryptoKey)
 *
 * The pool is lazily initialised on first use and reused for the lifetime
 * of the JS module. Call shutdownPool() only if you need to free the threads
 * explicitly (e.g., in tests).
 *
 * Transferable contract:
 *   Input ArrayBuffer is transferred to the worker (ownership moves, zero-copy).
 *   The caller MUST NOT use the input buffer after calling these functions.
 *   The returned ArrayBuffer is a new buffer owned by the caller.
 */

import CryptoWorker from './cryptoWorker.js?worker'

// Number of parallel worker threads. navigator.hardwareConcurrency is capped
// at 4 to avoid saturating mobile devices.
const POOL_SIZE = Math.min(typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 2) : 2, 4)

// ---------------------------------------------------------------------------
// Pool state
// ---------------------------------------------------------------------------

/** @type {Worker[]} */
let workers = []

/** @type {Map<string, { resolve: (buf: ArrayBuffer) => void, reject: (err: Error) => void }>} */
const pending = new Map()

let nextWorkerIndex = 0
let poolInitialised = false

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

function ensurePool() {
  if (poolInitialised) return
  poolInitialised = true

  for (let i = 0; i < POOL_SIZE; i++) {
    const w = new CryptoWorker()
    w.onmessage = handleWorkerMessage
    w.onerror = handleWorkerError
    workers.push(w)
  }
}

function handleWorkerMessage(event) {
  const { type, id, result, message } = event.data
  const handler = pending.get(id)
  if (!handler) return // stale message — ignore

  pending.delete(id)

  if (type === 'result') {
    handler.resolve(result)
  } else {
    handler.reject(new Error(message || 'Crypto worker error'))
  }
}

function handleWorkerError(event) {
  // A worker-level error (script exception before postMessage). We can't
  // know which job it belongs to — reject all pending jobs and reinitialise.
  console.error('[CryptoWorkerPool] Worker error:', event.message)
  const err = new Error(`Crypto worker crashed: ${event.message}`)
  for (const handler of pending.values()) {
    handler.reject(err)
  }
  pending.clear()
  // Reinitialise the pool so future calls aren't broken.
  poolInitialised = false
  workers = []
}

// ---------------------------------------------------------------------------
// Job dispatch
// ---------------------------------------------------------------------------

let jobCounter = 0

/**
 * JWK representation of the raw key, computed once.
 * @type {JsonWebKey|null}
 */
let cachedKeyJwk = null

/**
 * Register the raw AES-256 key material so the worker pool can use it.
 * Must be called immediately after key derivation, before any pool operations.
 *
 * @param {Uint8Array} rawKey — 32 raw key bytes from Argon2id hash output
 */
export function setPoolKey(rawKey) {
  // Build the JWK eagerly so workers don't have to do it per-job.
  cachedKeyJwk = {
    kty: 'oct',
    k: uint8ToBase64Url(rawKey),
    alg: 'A256GCM',
    key_ops: ['encrypt', 'decrypt'],
    ext: true,
  }
}

/**
 * Clear the pool's copy of the key (call on vault lock).
 */
export function clearPoolKey() {
  cachedKeyJwk = null
}

/**
 * Dispatch a job to the next available worker.
 * @param {'encrypt'|'decrypt'} type
 * @param {ArrayBuffer} payload — ownership transferred to worker
 * @returns {Promise<ArrayBuffer>}
 */
function dispatch(type, payload) {
  if (!cachedKeyJwk) {
    throw new Error('CryptoWorkerPool: no key set — call setPoolKey() first')
  }

  ensurePool()

  const id = `job_${++jobCounter}`

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })

    const workerIndex = nextWorkerIndex % workers.length
    nextWorkerIndex = (nextWorkerIndex + 1) % workers.length

    const worker = workers[workerIndex]
    // Transfer payload buffer to worker (zero-copy).
    worker.postMessage({ type, id, payload, keyData: cachedKeyJwk }, [payload])
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encrypt an ArrayBuffer off the main thread.
 * The input buffer is transferred — do not use it after this call.
 *
 * @param {ArrayBuffer} buffer — plaintext
 * @returns {Promise<ArrayBuffer>} — [12-byte nonce | ciphertext+tag]
 */
export async function encryptWithPool(buffer) {
  return dispatch('encrypt', buffer instanceof ArrayBuffer ? buffer : buffer.buffer)
}

/**
 * Decrypt a packed [nonce|ct+tag] ArrayBuffer off the main thread.
 * The input buffer is transferred — do not use it after this call.
 *
 * @param {ArrayBuffer} buffer — packed encrypted payload
 * @returns {Promise<ArrayBuffer>} — plaintext
 */
export async function decryptWithPool(buffer) {
  return dispatch('decrypt', buffer instanceof ArrayBuffer ? buffer : buffer.buffer)
}

/**
 * Terminate all workers and reset the pool.
 * After calling this, the pool will reinitialise on next use.
 */
export function shutdownPool() {
  for (const w of workers) w.terminate()
  workers = []
  pending.clear()
  poolInitialised = false
  nextWorkerIndex = 0
}

/**
 * Singleton pool instance — import this to call terminate() on vault lock.
 */
export const cryptoPool = {
  terminate: shutdownPool,
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Encode a Uint8Array as a Base64URL string (no padding).
 * Used to build the JWK 'k' field.
 */
function uint8ToBase64Url(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}
