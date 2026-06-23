/**
 * VaultPhotos Cloudflare Worker
 *
 * Stateless auth proxy between the React app and Hugging Face. The worker is the
 * only thing that holds the HF token. It never sees decrypted content and never
 * stores anything. All binary is transported as raw `application/octet-stream`
 * (not base64) so we stay well under the CF Worker body limit and avoid 33%
 * inflation. The worker base64-encodes internally only when HF's git commit
 * endpoint requires it (manifest, bundle, salt — all small). Media files route
 * through LFS as raw bytes.
 *
 * HF wire format verified against @huggingface/hub source (commit + LFS batch).
 */

const HF_API = 'https://huggingface.co'
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
}
// files/** are stored via LFS so large videos don't bloat the git repo.
const GITATTRIBUTES_CONTENT = 'files/** filter=lfs diff=lfs merge=lfs -text\n'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    if (!env.HF_TOKEN || !env.HF_REPO) {
      return json({ error: 'Worker misconfigured: HF_TOKEN and HF_REPO must be set' }, 500)
    }

    try {
      const handler = route(url.pathname, request.method)
      if (!handler) return json({ error: 'Not found' }, 404)
      const response = await handler({ request, url, env })
      // Attach CORS to every real response.
      const headers = new Headers(response.headers)
      for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v)
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    } catch (error) {
      const status = error.status || 500
      const message = error.message || 'Worker error'
      console.error('VaultPhotos worker error:', message)
      return json({ error: message }, status)
    }
  },
}

function route(path, method) {
  if (path === '/get-salt' && method === 'GET') return getSalt
  if (path === '/upload-salt' && method === 'POST') return uploadSalt
  if (path === '/get-manifest' && method === 'GET') return getManifest
  if (path === '/upload-manifest' && method === 'POST') return uploadManifest
  if (path === '/get-bundle' && method === 'GET') return getBundle
  if (path === '/upload-bundle' && method === 'POST') return uploadBundle
  const fileMatch = path.match(/^\/get-file\/([0-9a-f]{16})$/i)
  if (fileMatch && method === 'GET') return (ctx) => getFile(ctx, fileMatch[1])
  if (path === '/upload-file' && method === 'POST') return uploadFile
  if (path === '/preauth-upload' && method === 'POST') return preauthUpload
  if (path === '/commit-upload' && method === 'POST') return commitUpload
  if (path === '/list' && method === 'GET') return listFiles
  return null
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function getSalt({ env }) {
  return hfResolve(env, 'salt.bin')
}

async function uploadSalt({ request, env }) {
  const bytes = await readRawBody(request)
  await ensureGitAttributes(env)
  await hfGitCommit(env, 'salt.bin', bytes, 'Update salt')
  return json({ ok: true }, 200)
}

async function getManifest({ env }) {
  return hfResolve(env, 'manifest.enc')
}

async function uploadManifest({ request, env }) {
  const bytes = await readRawBody(request)
  await ensureGitAttributes(env)
  await hfGitCommit(env, 'manifest.enc', bytes, 'Update manifest')
  return json({ ok: true }, 200)
}

async function getBundle({ env }) {
  return hfResolve(env, 'thumbs.bundle')
}

async function uploadBundle({ request, env }) {
  const bytes = await readRawBody(request)
  await ensureGitAttributes(env)
  await hfGitCommit(env, 'thumbs.bundle', bytes, 'Update thumbnail bundle')
  return json({ ok: true }, 200)
}

async function getFile({ env }, id) {
  return hfResolve(env, `files/${id}.enc`)
}

async function uploadFile({ request, url, env }) {
  const id = url.searchParams.get('id')
  if (!id || !/^[0-9a-f]{16}$/i.test(id)) {
    return json({ error: 'Missing or invalid id query param' }, 400)
  }

  const bytes = await readRawBody(request)
  const path = `files/${id}.enc`
  await ensureGitAttributes(env)
  await hfUploadFile(env, path, bytes)
  return json({ ok: true, id }, 200)
}

/**
 * Direct-to-S3 path, step 1 of 2. The browser sends { id, size, sha256 } only —
 * no file bytes. The worker negotiates LFS credentials (preupload + batch) and
 * returns the S3 upload URL + headers for the browser to PUT directly. The
 * worker never sees the (large) file body. This is the first half of
 * hfUploadFile's LFS branch, with the sha256 supplied by the caller.
 *
 * If S3 already has an object with that sha256, the batch returns no upload
 * action and we reply { alreadyExists: true } — the browser skips the PUT.
 */
async function preauthUpload({ request, env }) {
  const body = await request.json()
  const { id, size, sha256 } = body
  if (!id || !/^[0-9a-f]{16}$/i.test(id)) {
    return json({ error: 'Missing or invalid id' }, 400)
  }
  if (!Number.isFinite(size) || size <= 0) {
    return json({ error: 'Missing or invalid size' }, 400)
  }
  if (!sha256 || !/^[0-9a-f]{64}$/i.test(sha256)) {
    return json({ error: 'Missing or invalid sha256' }, 400)
  }

  const path = `files/${id}.enc`
  await ensureGitAttributes(env)

  // The browser does not send file bytes; use a 512-byte zero sample. HF uses
  // the sample only for content sniffing on public repos — for encrypted blobs
  // it has no effect, and .gitattributes routes files/** to LFS regardless.
  const sample = bytesToBase64(new Uint8Array(512))

  const preuploadRes = await fetch(
    `${HF_API}/api/datasets/${env.HF_REPO}/preupload/main`,
    {
      method: 'POST',
      headers: authHeaders(env, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ files: [{ path, size, sample }] }),
    },
  )
  if (!preuploadRes.ok) throw await hfError(preuploadRes, `preupload ${path}`)
  const preupload = await preuploadRes.json()

  const file = preupload.files && preupload.files[0]
  if (!file || file.uploadMode !== 'lfs') {
    // files/** is LFS-backed via .gitattributes; if HF disagrees, the caller
    // should fall back to the proxy path. Surface this explicitly.
    return json({
      error: `HF did not select LFS for ${path} (got mode ${file && file.uploadMode}); use the proxy path`,
    }, 409)
  }

  // oid is the sha256 the browser already computed — do NOT re-hash here.
  const oid = sha256
  const batchRes = await fetch(
    `${HF_API}/datasets/${env.HF_REPO.replace(/\//g, '/')}.git/info/lfs/objects/batch`,
    {
      method: 'POST',
      headers: authHeaders(env, {
        Accept: 'application/vnd.git-lfs+json',
        'Content-Type': 'application/vnd.git-lfs+json',
      }),
      body: JSON.stringify({
        operation: 'upload',
        transfers: ['basic'],
        hash_algo: 'sha_256',
        ref: { name: 'main' },
        objects: [{ oid, size }],
      }),
    },
  )
  if (!batchRes.ok) throw await hfError(batchRes, `lfs batch ${path}`)
  const batch = await batchRes.json()

  const object = batch.objects && batch.objects[0]
  if (!object) throw new Error(`LFS batch returned no object for ${path}`)
  if (object.error) {
    const err = new Error(`LFS batch error for ${path}: ${object.error.message}`)
    err.status = 502
    throw err
  }

  const upload = object.actions && object.actions.upload
  if (!upload) {
    // Object already stored on S3 with this sha256 — browser can skip the PUT.
    return json({ alreadyExists: true }, 200)
  }

  const verify = object.actions && object.actions.verify
  return json({
    uploadUrl: upload.href,
    uploadHeaders: upload.header || {},
    verifyUrl: verify ? verify.href : null,
    verifyHeaders: verify ? (verify.header || {}) : null,
  }, 200)
}

/**
 * Direct-to-S3 path, step 2 of 2. After the browser has PUT the bytes to S3, it
 * asks the worker to finalize: optional LFS verify, then git-commit the LFS
 * pointer. Mirrors the second half of hfUploadFile's LFS branch.
 */
async function commitUpload({ request, env }) {
  const body = await request.json()
  const { id, sha256, size, verifyUrl, verifyHeaders } = body
  if (!id || !/^[0-9a-f]{16}$/i.test(id)) {
    return json({ error: 'Missing or invalid id' }, 400)
  }
  if (!sha256 || !/^[0-9a-f]{64}$/i.test(sha256)) {
    return json({ error: 'Missing or invalid sha256' }, 400)
  }
  if (!Number.isFinite(size) || size <= 0) {
    return json({ error: 'Missing or invalid size' }, 400)
  }

  if (verifyUrl) {
    // Optional verify — ignore failures, the commit will surface real problems.
    await fetch(verifyUrl, { method: 'POST', headers: verifyHeaders || {} }).catch(() => {})
  }

  const path = `files/${id}.enc`
  const ndjson = [
    JSON.stringify({ key: 'header', value: { summary: `Add ${path}` } }),
    JSON.stringify({
      key: 'lfsFile',
      value: { path, algo: 'sha256', size, oid: sha256 },
    }),
  ].join('\n')

  const commitRes = await fetch(
    `${HF_API}/api/datasets/${env.HF_REPO}/commit/main`,
    {
      method: 'POST',
      headers: authHeaders(env, { 'Content-Type': 'application/x-ndjson' }),
      body: ndjson,
    },
  )
  if (!commitRes.ok) throw await hfError(commitRes, `commit lfs ${path}`)
  return json({ ok: true }, 200)
}

async function listFiles({ env }) {
  const tree = await hfListTree(env, 'files')
  const ids = tree.map((entry) => entry.path.replace(/^files\//, '').replace(/\.enc$/, ''))
  return json(ids, 200)
}

// ---------------------------------------------------------------------------
// Hugging Face backend primitives
// ---------------------------------------------------------------------------

function authHeaders(env, extra = {}) {
  return {
    Authorization: `Bearer ${env.HF_TOKEN}`,
    ...extra,
  }
}

/**
 * Resolve a raw file from HF and stream it back. HF 302-redirects LFS pointers
 * to S3 automatically, so this transparently works for both git and LFS files.
 * Returns the upstream response directly so the body streams without buffering.
 */
async function hfResolve(env, path) {
  const res = await fetch(`${HF_API}/datasets/${env.HF_REPO}/resolve/main/${path}`, {
    headers: authHeaders(env),
  })
  if (res.status === 404) {
    const err = new Error('Not found in HF repo')
    err.status = 404
    throw err
  }
  if (!res.ok) {
    throw await hfError(res, `resolve ${path}`)
  }
  // Clone headers we want to keep, let the body stream.
  const headers = new Headers()
  headers.set('Content-Type', res.headers.get('Content-Type') || 'application/octet-stream')
  const length = res.headers.get('Content-Length')
  if (length) headers.set('Content-Length', length)
  return new Response(res.body, { status: 200, headers })
}

/**
 * Commit a small file to HF via the git commit endpoint using base64 content.
 * Uses the verified NDJSON wire format: a header line, then a file line.
 */
async function hfGitCommit(env, path, bytes, summary) {
  const base64 = bytesToBase64(bytes)
  const ndjson = [
    JSON.stringify({ key: 'header', value: { summary: summary || `Update ${path}` } }),
    JSON.stringify({
      key: 'file',
      value: { path, content: base64, encoding: 'base64' },
    }),
  ].join('\n')

  const res = await fetch(
    `${HF_API}/api/datasets/${env.HF_REPO}/commit/main`,
    {
      method: 'POST',
      headers: authHeaders(env, { 'Content-Type': 'application/x-ndjson' }),
      body: ndjson,
    },
  )
  if (!res.ok) throw await hfError(res, `commit ${path}`)
  return res.json()
}

/**
 * Upload any file. Small files go straight to git commit. Large files (or files
 * under an LFS path) follow the LFS flow: preupload → batch → S3 PUT → commit
 * as lfsFile. Mirrors @huggingface/hub's commit implementation.
 */
async function hfUploadFile(env, path, bytes) {
  const size = bytes.byteLength
  const sample = bytesToBase64(bytes.slice(0, 512))

  const preuploadRes = await fetch(
    `${HF_API}/api/datasets/${env.HF_REPO}/preupload/main`,
    {
      method: 'POST',
      headers: authHeaders(env, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ files: [{ path, size, sample }] }),
    },
  )
  if (!preuploadRes.ok) throw await hfError(preuploadRes, `preupload ${path}`)
  const preupload = await preuploadRes.json()

  const file = preupload.files && preupload.files[0]
  const uploadMode = file && file.uploadMode

  if (uploadMode !== 'lfs') {
    // Regular git blob.
    await hfGitCommit(env, path, bytes, `Add ${path}`)
    return
  }

  // LFS flow.
  const oid = await sha256Hex(bytes)
  const batchRes = await fetch(
    `${HF_API}/datasets/${env.HF_REPO.replace(/\//g, '/')}.git/info/lfs/objects/batch`,
    {
      method: 'POST',
      headers: authHeaders(env, {
        Accept: 'application/vnd.git-lfs+json',
        'Content-Type': 'application/vnd.git-lfs+json',
      }),
      body: JSON.stringify({
        operation: 'upload',
        transfers: ['basic'],
        hash_algo: 'sha_256',
        ref: { name: 'main' },
        objects: [{ oid, size }],
      }),
    },
  )
  if (!batchRes.ok) throw await hfError(batchRes, `lfs batch ${path}`)
  const batch = await batchRes.json()

  const object = batch.objects && batch.objects[0]
  if (!object) throw new Error(`LFS batch returned no object for ${path}`)
  if (object.error) {
    const err = new Error(`LFS batch error for ${path}: ${object.error.message}`)
    err.status = 502
    throw err
  }

  const upload = object.actions && object.actions.upload
  if (upload) {
    // Object not already stored — PUT the raw bytes to the S3 endpoint.
    const putRes = await fetch(upload.href, {
      method: 'PUT',
      headers: upload.header || {},
      body: bytes,
    })
    if (!putRes.ok) throw await hfError(putRes, `lfs put ${path}`)
    const verify = object.actions && object.actions.verify
    if (verify) {
      // Optional verify call — ignore failures, the commit will catch issues.
      await fetch(verify.href, { method: 'POST', headers: verify.header || {} }).catch(() => {})
    }
  }

  // Commit the LFS pointer.
  const ndjson = [
    JSON.stringify({ key: 'header', value: { summary: `Add ${path}` } }),
    JSON.stringify({
      key: 'lfsFile',
      value: { path, algo: 'sha256', size, oid },
    }),
  ].join('\n')

  const commitRes = await fetch(
    `${HF_API}/api/datasets/${env.HF_REPO}/commit/main`,
    {
      method: 'POST',
      headers: authHeaders(env, { 'Content-Type': 'application/x-ndjson' }),
      body: ndjson,
    },
  )
  if (!commitRes.ok) throw await hfError(commitRes, `commit lfs ${path}`)
}

/**
 * List a folder in the HF repo at main. Returns [{path, type, size, ...}].
 */
async function hfListTree(env, folder) {
  const res = await fetch(
    `${HF_API}/api/datasets/${env.HF_REPO}/tree/main/${folder}`,
    { headers: authHeaders(env) },
  )
  if (res.status === 404) return []
  if (!res.ok) throw await hfError(res, `tree ${folder}`)
  return res.json()
}

/**
 * Ensure `.gitattributes` marks `files/**` as LFS. Idempotent — only commits
 * once. Checked via a lightweight tree listing of the repo root.
 */
let gitAttributesEnsured = false
async function ensureGitAttributes(env) {
  if (gitAttributesEnsured) return
  const tree = await hfListTree(env, '')
  const exists = tree.some((entry) => entry.path === '.gitattributes')
  if (!exists) {
    const bytes = new TextEncoder().encode(GITATTRIBUTES_CONTENT)
    await hfGitCommit(env, '.gitattributes', bytes, 'Initialize LFS for files/')
  }
  gitAttributesEnsured = true
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readRawBody(request) {
  const buffer = await request.arrayBuffer()
  return new Uint8Array(buffer)
}

function bytesToBase64(bytes) {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode.apply(null, chunk)
  }
  return btoa(binary)
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function hfError(res, context) {
  let detail = ''
  try {
    const text = await res.text()
    detail = text ? ` — ${text.slice(0, 500)}` : ''
  } catch { /* ignore */ }
  const err = new Error(`HF ${res.status} ${context}${detail}`)
  err.status = res.status === 404 ? 404 : 502
  return err
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}
