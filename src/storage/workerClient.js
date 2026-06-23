/**
 * Thin fetch wrapper for the Cloudflare Worker. This is the only module in the
 * app that knows how to talk to the network — no HF URLs live anywhere else.
 *
 * All binary moves as raw `application/octet-stream`, not base64. Uploads send
 * ArrayBuffer/Uint8Array bodies; downloads return ArrayBuffer. JSON helpers are
 * provided for the few JSON routes.
 */

const WORKER_URL = import.meta.env.VITE_WORKER_URL

if (!WORKER_URL) {
  // Fail loud in dev if the env var is missing — every call below would 404.
  console.warn(
    'VITE_WORKER_URL is not set. Copy .env.example to .env and point it at your worker.',
  )
}

export async function getSalt() {
  return getBytes('/get-salt')
}

export async function uploadSalt(bytes) {
  return postBytes('/upload-salt', bytes)
}

export async function getManifest() {
  return getBytes('/get-manifest')
}

export async function uploadManifest(bytes) {
  return postBytes('/upload-manifest', bytes)
}

export async function getBundle() {
  return getBytes('/get-bundle')
}

export async function uploadBundle(bytes) {
  return postBytes('/upload-bundle', bytes)
}

export async function getFile(id) {
  return getBytes(`/get-file/${id}`)
}

export async function uploadFile(id, bytes) {
  return postBytes(`/upload-file?id=${encodeURIComponent(id)}`, bytes)
}

/**
 * Direct-to-S3 path, step 1. Ask the worker to negotiate LFS credentials for a
 * large file. The browser passes its precomputed sha256 + size; the worker
 * replies with an S3 upload URL (or `{ alreadyExists: true }` if S3 already has
 * that sha256). No file bytes cross this call.
 */
export async function preauthUpload(id, size, sha256) {
  return postJson('/preauth-upload', { id, size, sha256 })
}

/**
 * Direct-to-S3 path, step 2. After the browser PUTs the bytes to S3, ask the
 * worker to run the optional LFS verify and commit the LFS pointer.
 * `verifyUrl` may be null/absent (some batch responses omit verify).
 */
export async function commitUpload(id, sha256, size, verifyUrl, verifyHeaders) {
  return postJson('/commit-upload', { id, sha256, size, verifyUrl, verifyHeaders })
}

export async function listIds() {
  const res = await fetch(`${WORKER_URL}/list`)
  if (!res.ok) throw await httpError(res, 'list')
  return res.json()
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function getBytes(path) {
  const res = await fetch(`${WORKER_URL}${path}`)
  if (!res.ok) throw await httpError(res, `GET ${path}`)
  return res.arrayBuffer()
}

async function postBytes(path, bytes) {
  const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  })
  if (!res.ok) throw await httpError(res, `POST ${path}`)
  return res
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
