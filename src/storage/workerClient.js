import { connectionHeaders } from '../session/connection'
/**
 * Thin fetch/XHR wrapper for the Cloudflare Worker. This is the only module in
 * the app that knows how to talk to the network — no HF URLs live anywhere else.
 *
 * Binary downloads use fetch (GET, no progress needed). Binary uploads that
 * benefit from per-byte progress use XMLHttpRequest so we can wire
 * xhr.upload.onprogress. The optional `onProgress` callback receives:
 *   { loaded: number, total: number, percent: number }
 *
 * JSON routes (preauth/commit) use fetch with JSON bodies.
 */

const WORKER_URL = import.meta.env.VITE_WORKER_URL?.replace(/\/$/, '')

/**
 * When the worker sits behind Cloudflare Access, requests must carry the
 * visitor's Access session cookies. Configure via VITE_ACCESS_CREDENTIALS:
 *   'include'     — send cookies cross-origin (Access-protected deployments)
 *   'same-origin' — same-origin deployments only
 *   'omit'
 */
const ACCESS_CREDENTIALS = ['omit', 'same-origin', 'include'].includes(
  import.meta.env.VITE_ACCESS_CREDENTIALS,
)
  ? import.meta.env.VITE_ACCESS_CREDENTIALS
  : 'include'

if (!WORKER_URL) {
  // Fail loud in dev if the env var is missing — every call below would 404.
  if (import.meta.env.DEV) {
    console.warn(
      'VITE_WORKER_URL is not set. Copy .env.example to .env and point it at your worker.',
    )
  }
}

// ---------------------------------------------------------------------------
// Public API — GET routes (unchanged signatures)
// ---------------------------------------------------------------------------

export async function getSalt() {
  const bytes = await getBytes('/get-salt', { maxBytes: 16 })
  if (bytes.byteLength !== 16) throw new Error('The vault salt is damaged; restore the original salt from a backup.')
  return bytes
}

/**
 * Read the current tip commit of the vault dataset.
 * Inbound contract (worker session): GET /vault-head → { oid: string }.
 * @returns {Promise<{ oid: string | null }>} parsed via parseVaultHead
 */
export async function getVaultHead(options) {
  return getJson('/vault-head', options)
}

/**
 * @param {string} [revision] — head commit oid to pin the read to (snapshot
 * consistency during finalize). Omitted/undefined keeps legacy unpinned reads.
 */
export async function getManifest(revision) {
  return getBytes('/get-manifest', { revision })
}

/**
 * @param {string} [revision] — keeps the read pinned to the finalize snapshot.
 */
export async function getBundle(revision) {
  return getBytes('/get-bundle', { revision })
}

export async function getFile(id, options = {}) {
  return getBytes(`/get-file/${id}`, { maxBytes: 256 * 1024 * 1024, ...options })
}

export async function listIds() {
  return getJson('/list')
}

// ---------------------------------------------------------------------------
// Public API — small POST routes (no progress needed, use fetch)
// ---------------------------------------------------------------------------

export async function uploadSalt(bytes) {
  return xhrPost('/upload-salt', bytes)
}

export async function initializeVault(saltBytes, manifestBytes, bundlePageBytes) {
  return postJson('/initialize-vault', {
    saltBytesBase64: bytesToBase64(saltBytes),
    manifestBytesBase64: bytesToBase64(manifestBytes),
    bundlePageBytesBase64: bytesToBase64(bundlePageBytes),
  })
}

// ---------------------------------------------------------------------------
// Public API — binary upload routes with optional XHR progress
// ---------------------------------------------------------------------------

/**
 * Upload an encrypted media file to the worker proxy.
 * @param {string} id — 16-hex file id
 * @param {Uint8Array|ArrayBuffer} bytes — encrypted blob
 * @param {((e: {loaded:number,total:number,percent:number}) => void) | undefined} onProgress
 * @param {boolean} [commit] — whether to commit the file to HF in this request
 */
export async function uploadFile(id, bytes, onProgress, commit = false, options = {}) {
  const commitParam = commit ? '' : '&commit=false'
  return xhrPost(
    `/upload-file?id=${encodeURIComponent(id)}${commitParam}`,
    bytes,
    onProgress,
    options,
  )
}

/**
 * Upload the encrypted manifest blob.
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {((e: {loaded:number,total:number,percent:number}) => void) | undefined} onProgress
 */
export async function uploadManifest(bytes, onProgress) {
  return xhrPost('/upload-manifest', bytes, onProgress)
}

/**
 * Upload the encrypted thumbnail bundle.
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {((e: {loaded:number,total:number,percent:number}) => void) | undefined} onProgress
 */
export async function uploadBundle(bytes, onProgress) {
  return xhrPost('/upload-bundle', bytes, onProgress)
}

// ---------------------------------------------------------------------------
// V3 — Paginated bundle routes (added alongside existing bundle functions)
// ---------------------------------------------------------------------------

/**
 * Fetch a single paginated bundle page by index.
 * Returns the raw encrypted bytes of thumbs_page_N.bundle.
 * Throws with error.status === 404 if the page does not exist yet.
 *
 * @param {number} pageIndex — zero-based integer
 * @param {string} [revision] — pin the read to a finalize snapshot
 * @returns {Promise<ArrayBuffer>}
 */
export async function getBundlePage(pageIndex, revision) {
  return getBytes(`/get-bundle-page/${pageIndex}`, { revision })
}

/**
 * Upload an encrypted bundle page.
 * @param {number} pageIndex — zero-based integer
 * @param {Uint8Array|ArrayBuffer} bytes — encrypted page bytes
 * @param {((e: {loaded:number,total:number,percent:number}) => void) | undefined} onProgress
 * @returns {Promise<ArrayBuffer>} — response body (JSON with ok:true)
 */
export async function uploadBundlePage(pageIndex, bytes, onProgress) {
  return xhrPost(`/upload-bundle-page/${pageIndex}`, bytes, onProgress)
}

// ---------------------------------------------------------------------------
// V3 — Chunked file routes (Feature 5)
// ---------------------------------------------------------------------------

/**
 * Fetch a single encrypted chunk of a chunked media file.
 * @param {string} id — 16-hex file id
 * @param {number} index — zero-based chunk index
 * @returns {Promise<ArrayBuffer>}
 */
export async function getChunk(id, index, options = {}) {
  return getBytes(`/get-chunk/${id}/${index}`, { maxBytes: 32 * 1024 * 1024 + 32, ...options })
}

/**
 * Upload a single encrypted chunk of a chunked media file.
 * @param {string} id — 16-hex file id
 * @param {number} index — zero-based chunk index
 * @param {Uint8Array|ArrayBuffer} bytes — encrypted chunk bytes
 * @param {((e: {loaded:number,total:number,percent:number}) => void) | undefined} onProgress
 * @returns {Promise<ArrayBuffer>}
 */
export async function uploadChunk(id, index, bytes, onProgress, commit = false, options = {}) {
  const commitParam = commit ? '' : '&commit=false'
  return xhrPost(
    `/upload-chunk?id=${encodeURIComponent(id)}&index=${index}${commitParam}`,
    bytes,
    onProgress,
    options,
  )
}

// ---------------------------------------------------------------------------
// Public API — direct-to-S3 JSON handshake (preauthUpload / commitUpload)
// These already existed in V1.5 — signatures unchanged.
// ---------------------------------------------------------------------------

/**
 * Direct-to-S3 step 1. Ask the worker to negotiate LFS credentials.
 * @param {string} id
 * @param {number} size — encrypted byte length
 * @param {string} sha256 — hex SHA-256 of encrypted bytes
 * @returns {{ uploadUrl: string, verifyUrl: string|null, uploadHeaders: object } | { alreadyExists: true }}
 */
export async function preauthUpload(id, size, sha256) {
  return postJson('/preauth-upload', { id, size, sha256 })
}

/**
 * Direct-to-S3 step 2. Commit the LFS pointer after the browser PUTs to S3.
 * @param {string} id
 * @param {string} sha256
 * @param {number} size
 * @param {string|null} verifyUrl
 * @param {object|null} verifyHeaders
 */
export async function commitUpload(id, sha256, size, verifyUrl, verifyHeaders) {
  return postJson('/commit-upload', { id, sha256, size, verifyUrl, verifyHeaders })
}

/**
 * Bulk commit route. Commits multiple LFS file pointers and standard files
 * (manifest and bundle) in a single Git commit transaction.
 *
 * Inbound contract (worker session): `parentCommit` (the head oid read before
 * the finalize snapshots were loaded) is REQUIRED; a stale head returns 409
 * with `code: 'VAULT_STALE'`, `retryable: false`.
 *
 * @param {object} payload
 * @param {Array<{id:string, sha256:string, size:number}>} payload.files
 * @param {Array<{index:number, sha256:string, size:number}>} [payload.chunks]
 * @param {string} [payload.manifestBytesBase64]
 * @param {string} [payload.bundleBytesBase64]
 * @param {Array<{pageIndex:number, bytesBase64:string}>} [payload.bundlePages]
 * @param {string} payload.parentCommit — head commit oid (`/vault-head`)
 */
export async function commitBatch(payload, options = {}) {
  return postJson('/commit-batch', payload, options)
}

/**
 * Pointer-delete route (delete flow, W3 sibling contract). The worker takes a
 * manifest rewrite under the same CAS discipline as commitBatch: stale
 * parentCommit → 409 `code: 'VAULT_STALE'`.
 *
 * @param {object} payload
 * @param {string} payload.parentCommit — head commit oid (`/vault-head`)
 * @param {Array<{ id: string, chunk_count?: number }>} payload.ids
 * @param {string} payload.manifestBytesBase64 — encrypted rewritten manifest
 */
export async function deleteMedia(payload, options = {}) {
  return postJson('/delete-media', payload, options)
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function buildPath(path, { revision } = {}) {
  if (!revision) return path
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}revision=${encodeURIComponent(revision)}`
}

async function getBytes(path, options = {}) {
  const res = await fetch(`${WORKER_URL}${buildPath(path, options)}`, {
    headers: connectionHeaders(),
    credentials: ACCESS_CREDENTIALS,
    signal: options.signal,
  })
  if (!res.ok) throw await httpError(res, `GET ${path}`)
  return boundedBytes(res, options.maxBytes ?? 64 * 1024 * 1024)
}

async function getJson(path, options = {}) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    headers: connectionHeaders(),
    credentials: ACCESS_CREDENTIALS,
    signal: options.signal,
  })
  if (!res.ok) throw await httpError(res, `GET ${path}`)
  return res.json()
}

/**
 * XHR POST with raw octet-stream body and optional upload progress.
 * Returns the response body as ArrayBuffer (for callers that don't need it,
 * this is fine — same shape as the old postBytes helper returned Response).
 */
function xhrPost(path, bytes, onProgress, options = {}) {
  const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const { signal, sha256 } = options
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError())
      return
    }

    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${WORKER_URL}${path}`)
    xhr.timeout = 30 * 60 * 1000
    if (ACCESS_CREDENTIALS === 'include') xhr.withCredentials = true
    for (const [name, value] of Object.entries(connectionHeaders())) xhr.setRequestHeader(name, value)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.setRequestHeader('X-Vault-Size', String(body.byteLength))
    if (sha256) xhr.setRequestHeader('X-Vault-SHA256', sha256)
    xhr.responseType = 'arraybuffer'

    const cleanup = () => signal?.removeEventListener('abort', abortUpload)
    const abortUpload = () => xhr.abort()
    signal?.addEventListener('abort', abortUpload, { once: true })

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress({ loaded: e.loaded, total: e.total, percent: e.loaded / e.total })
        }
      }
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        cleanup()
        resolve(xhr.response)
      } else {
        // Try to parse JSON error body.
        let message = `POST ${path} failed (${xhr.status})`
        const details = {}
        try {
          const responseBody = JSON.parse(new TextDecoder().decode(xhr.response))
          if (responseBody && responseBody.error) message = responseBody.error
          if (responseBody && responseBody.code) details.code = responseBody.code
          if (responseBody && responseBody.retryable !== undefined) {
            details.retryable = responseBody.retryable
          }
          if (responseBody && responseBody.upstreamStatus) {
            details.upstreamStatus = responseBody.upstreamStatus
          }
        } catch { /* opaque body (e.g. 5xx gateway error page) */ }
        // Opaque/non-JSON 5xx bodies are gateway transient failures (U5).
        if (details.retryable === undefined && negativeBodyCheck(xhr.status)) {
          details.retryable = true
        }
        const retryAfter = parseRetryAfter(xhr.getResponseHeader('Retry-After'))
        if (retryAfter !== null) details.retryAfterMs = retryAfter
        const err = new Error(message)
        err.status = xhr.status
        Object.assign(err, details)
        cleanup()
        reject(err)
      }
    }

    xhr.onerror = () => {
      const err = new Error(`POST ${path} network error`)
      err.status = 0
      cleanup()
      reject(err)
    }

    xhr.onabort = () => {
      cleanup()
      reject(createAbortError())
    }

    xhr.ontimeout = () => {
      cleanup()
      const error = new Error('Encrypted upload timed out. The recovery queue is retained.')
      error.status = 408
      error.retryable = true
      reject(error)
    }

    xhr.send(body)
  })
}

/**
 * POST a JSON body and parse the JSON response. Used by the direct-to-S3
 * handshake routes (preauth/commit), which carry only metadata, no file bytes.
 */
async function postJson(path, payload, options = {}) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...connectionHeaders() },
    credentials: ACCESS_CREDENTIALS,
    body: JSON.stringify(payload),
    signal: options.signal,
  })
  if (!res.ok) throw await httpError(res, `POST ${path}`)
  return res.json()
}

async function httpError(res, context) {
  let message = `${context} failed (${res.status})`
  const errorDetails = {}
  let hadJson = true
  try {
    const body = await res.json()
    if (body && body.error) message = body.error
    if (body && body.code) errorDetails.code = body.code
    if (body && body.retryable !== undefined) errorDetails.retryable = body.retryable
    if (body && body.upstreamStatus) errorDetails.upstreamStatus = body.upstreamStatus
  } catch {
    // Response wasn't JSON — keep the default message.
    hadJson = false
  }
  // Opaque 5xx bodies are usually gateway transient failures (U5).
  if (!hadJson && negativeBodyCheck(res.status)) {
    errorDetails.retryable = true
  }
  const retryAfter = parseRetryAfter(res.headers.get('Retry-After'))
  if (retryAfter !== null) errorDetails.retryAfterMs = retryAfter
  const error = new Error(message)
  error.status = res.status
  Object.assign(error, errorDetails)
  return error
}

function negativeBodyCheck(status) {
  return status === 502 || status === 503 || status === 504
}

/** @param {string | null} value — HTTP Retry-After header (seconds) */
function parseRetryAfter(value) {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null
}

async function boundedBytes(response, maximum) {
  if (Number(response.headers.get('Content-Length')) > maximum) {
    await response.body?.cancel()
    throw new Error('This encrypted object exceeds the browser download safety limit.')
  }
  if (!response.body) throw new Error('Storage returned an empty response')
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maximum) {
        await reader.cancel()
        throw new Error('This encrypted object exceeds the browser download safety limit.')
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes.buffer
}

function createAbortError() {
  return new DOMException('Upload cancelled', 'AbortError')
}

function bytesToBase64(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.byteLength; index += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}
