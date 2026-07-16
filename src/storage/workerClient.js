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

const WORKER_URL = import.meta.env.VITE_WORKER_URL

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
  return getBytes('/get-salt')
}

export async function getManifest() {
  return getBytes('/get-manifest')
}

export async function getBundle() {
  return getBytes('/get-bundle')
}

export async function getFile(id) {
  return getBytes(`/get-file/${id}`)
}

export async function listIds() {
  const res = await fetch(`${WORKER_URL}/list`)
  if (!res.ok) throw await httpError(res, 'list')
  return res.json()
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
export async function uploadFile(id, bytes, onProgress, commit = true, options = {}) {
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
 * @returns {Promise<ArrayBuffer>}
 */
export async function getBundlePage(pageIndex) {
  return getBytes(`/get-bundle-page/${pageIndex}`)
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
export async function getChunk(id, index) {
  return getBytes(`/get-chunk/${id}/${index}`)
}

/**
 * Upload a single encrypted chunk of a chunked media file.
 * @param {string} id — 16-hex file id
 * @param {number} index — zero-based chunk index
 * @param {Uint8Array|ArrayBuffer} bytes — encrypted chunk bytes
 * @param {((e: {loaded:number,total:number,percent:number}) => void) | undefined} onProgress
 * @returns {Promise<ArrayBuffer>}
 */
export async function uploadChunk(id, index, bytes, onProgress, commit = true, options = {}) {
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
 * @param {object} payload
 * @param {Array<{id:string, sha256:string, size:number}>} payload.files
 * @param {string} [payload.manifestBytesBase64]
 * @param {string} [payload.bundleBytesBase64]
 */
export async function commitBatch(payload, options = {}) {
  return postJson('/commit-batch', payload, options)
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function getBytes(path) {
  const res = await fetch(`${WORKER_URL}${path}`)
  if (!res.ok) throw await httpError(res, `GET ${path}`)
  return res.arrayBuffer()
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
        } catch { /* ignore */ }
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: options.signal,
  })
  if (!res.ok) throw await httpError(res, `POST ${path}`)
  return res.json()
}

async function httpError(res, context) {
  let message = `${context} failed (${res.status})`
  const errorDetails = {}
  try {
    const body = await res.json()
    if (body && body.error) message = body.error
    if (body && body.code) errorDetails.code = body.code
    if (body && body.retryable !== undefined) errorDetails.retryable = body.retryable
    if (body && body.upstreamStatus) errorDetails.upstreamStatus = body.upstreamStatus
  } catch {
    // Response wasn't JSON — keep the default message.
  }
  const error = new Error(message)
  error.status = res.status
  Object.assign(error, errorDetails)
  return error
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
