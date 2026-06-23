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
  console.warn(
    'VITE_WORKER_URL is not set. Copy .env.example to .env and point it at your worker.',
  )
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

// ---------------------------------------------------------------------------
// Public API — binary upload routes with optional XHR progress
// ---------------------------------------------------------------------------

/**
 * Upload an encrypted media file to the worker proxy.
 * @param {string} id — 16-hex file id
 * @param {Uint8Array|ArrayBuffer} bytes — encrypted blob
 * @param {((e: {loaded:number,total:number,percent:number}) => void) | undefined} onProgress
 */
export async function uploadFile(id, bytes, onProgress) {
  return xhrPost(`/upload-file?id=${encodeURIComponent(id)}`, bytes, onProgress)
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
function xhrPost(path, bytes, onProgress) {
  const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${WORKER_URL}${path}`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.responseType = 'arraybuffer'

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress({ loaded: e.loaded, total: e.total, percent: e.loaded / e.total })
        }
      }
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response)
      } else {
        // Try to parse JSON error body.
        let message = `POST ${path} failed (${xhr.status})`
        try {
          const body = JSON.parse(new TextDecoder().decode(xhr.response))
          if (body && body.error) message = body.error
        } catch { /* ignore */ }
        const err = new Error(message)
        err.status = xhr.status
        reject(err)
      }
    }

    xhr.onerror = () => {
      const err = new Error(`POST ${path} network error`)
      err.status = 0
      reject(err)
    }

    xhr.send(body)
  })
}

/**
 * POST a JSON body and parse the JSON response. Used by the direct-to-S3
 * handshake routes (preauth/commit), which carry only metadata, no file bytes.
 */
async function postJson(path, payload) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw await httpError(res, `POST ${path}`)
  return res.json()
}

async function httpError(res, context) {
  let message = `${context} failed (${res.status})`
  try {
    const body = await res.json()
    if (body && body.error) message = body.error
  } catch {
    // Response wasn't JSON — keep the default message.
  }
  const error = new Error(message)
  error.status = res.status
  return error
}
