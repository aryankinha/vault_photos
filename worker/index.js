import { planCommitBatches } from './commitPlan.js'

/**
 * VaultPhotos Cloudflare Worker
 *
 * Stateless auth proxy between the React app and Hugging Face. The worker is the
 * only thing that holds the HF token. It never sees decrypted content and never
 * stores anything. All binary is transported as raw `application/octet-stream`
 * (not base64) so we stay well under the CF Worker body limit and avoid 33%
 * inflation. The worker base64-encodes internally only when HF's git commit
 * endpoint requires it (manifest, bundle, salt — all small). Media files route
 * through LFS as fixed-length streams using browser-computed ciphertext hashes,
 * so the Worker does not retain another whole media buffer in memory.
 *
 * HF wire format verified against @huggingface/hub source (commit + LFS batch).
 */

const HF_API = 'https://huggingface.co'
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Vault-SHA256, X-Vault-Size',
  'Access-Control-Max-Age': '86400',
}
// files/** are stored via LFS so large videos don't bloat the git repo.
const GITATTRIBUTES_CONTENT = 'files/** filter=lfs diff=lfs merge=lfs -text\n'
const COMMIT_RETRY_DELAYS_MS = [300, 900, 1800]

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

      // Prevent browser caching on mutable routes
      const mutablePaths = [
        '/get-salt', '/get-manifest', '/get-bundle', '/list',
        // V3 bundle pages are also mutable — bust cache on every read.
        '/get-bundle-page',
      ]
      const isMutable = mutablePaths.some((p) => url.pathname === p || url.pathname.startsWith(p + '/'))
      if (isMutable) {
        headers.set('Cache-Control', 'no-cache, no-store, must-revalidate')
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    } catch (error) {
      const status = error.status || 500
      console.error('VaultPhotos storage request failed', {
        status,
        route: url.pathname,
        code: error.code || 'STORAGE_FAILED',
        upstreamStatus: error.upstreamStatus || null,
      })
      return json({
        error: publicStorageError(error, status),
        code: error.code || (status === 404 ? 'NOT_FOUND' : 'STORAGE_FAILED'),
        retryable: Boolean(error.retryable),
        ...(error.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}),
      }, status)
    }
  },
}

function route(path, method) {
  if (path === '/get-salt' && method === 'GET') return getSalt
  if (path === '/upload-salt' && method === 'POST') return uploadSalt
  if (path === '/initialize-vault' && method === 'POST') return initializeVault
  if (path === '/get-manifest' && method === 'GET') return getManifest
  if (path === '/upload-manifest' && method === 'POST') return uploadManifest
  if (path === '/get-bundle' && method === 'GET') return getBundle
  if (path === '/upload-bundle' && method === 'POST') return uploadBundle
  const fileMatch = path.match(/^\/get-file\/([0-9a-f]{16})$/i)
  if (fileMatch && method === 'GET') return (ctx) => getFile(ctx, fileMatch[1])
  if (path === '/upload-file' && method === 'POST') return uploadFile
  if (path === '/preauth-upload' && method === 'POST') return preauthUpload
  if (path === '/commit-upload' && method === 'POST') return commitUpload
  if (path === '/commit-batch' && method === 'POST') return commitBatch
  if (path === '/list' && method === 'GET') return listFiles
  // V3 — paginated bundle pages
  const bundlePageGetMatch = path.match(/^\/get-bundle-page\/(\d+)$/)
  if (bundlePageGetMatch && method === 'GET') return (ctx) => getBundlePage(ctx, Number(bundlePageGetMatch[1]))
  const bundlePagePostMatch = path.match(/^\/upload-bundle-page\/(\d+)$/)
  if (bundlePagePostMatch && method === 'POST') return (ctx) => uploadBundlePage(ctx, Number(bundlePagePostMatch[1]))
  // V3 — chunked file transfers
  const chunkGetMatch = path.match(/^\/get-chunk\/([0-9a-f]{16})\/(\d+)$/i)
  if (chunkGetMatch && method === 'GET') return (ctx) => getChunkHandler(ctx, chunkGetMatch[1], Number(chunkGetMatch[2]))
  if (path === '/upload-chunk' && method === 'POST') return uploadChunkHandler
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

async function initializeVault({ request, env }) {
  const {
    saltBytesBase64,
    manifestBytesBase64,
    bundlePageBytesBase64,
  } = await request.json()

  if (
    typeof saltBytesBase64 !== 'string' ||
    typeof manifestBytesBase64 !== 'string' ||
    typeof bundlePageBytesBase64 !== 'string'
  ) {
    return json({ error: 'Invalid initialization payload' }, 400)
  }
  if (base64ToBytes(saltBytesBase64).byteLength !== 16) {
    return json({ error: 'Salt must be exactly 16 bytes' }, 400)
  }

  const tree = await hfListTree(env, '')
  if (tree.some((entry) => entry.path === 'manifest.enc')) {
    return json({ error: 'Vault is already initialized' }, 409)
  }

  await ensureGitAttributes(env)
  const files = [
    { path: 'manifest.enc', content: manifestBytesBase64 },
    { path: 'thumbs_page_0.bundle', content: bundlePageBytesBase64 },
  ]
  if (!tree.some((entry) => entry.path === 'salt.bin')) {
    files.unshift({ path: 'salt.bin', content: saltBytesBase64 })
  }

  await hfGitCommitBatch(env, 'Initialize encrypted vault', files, [])
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
  const commit = url.searchParams.get('commit') !== 'false'

  const path = `files/${id}.enc`
  await ensureGitAttributes(env)
  const descriptor = readUploadDescriptor(request)
  const result = descriptor
    ? await hfUploadStream(env, path, request.body, descriptor.size, descriptor.oid, commit)
    : await hfUploadFile(env, path, await readRawBody(request), commit)
  return json({ ok: true, id, sha256: result.oid, size: result.size }, 200)
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

  await postHfCommit(env, ndjson, `commit lfs ${path}`)
  return json({ ok: true }, 200)
}

async function commitBatch({ request, env }) {
  const body = await request.json()
  const {
    files,
    chunks = [],
    manifestBytesBase64,
    bundleBytesBase64,
    bundlePages = [],
  } = body

  if (!Array.isArray(files) || !Array.isArray(chunks) || !Array.isArray(bundlePages)) {
    return json({ error: 'Invalid batch arrays' }, 400)
  }
  if (
    (manifestBytesBase64 !== undefined && (typeof manifestBytesBase64 !== 'string' || manifestBytesBase64.length === 0)) ||
    (bundleBytesBase64 !== undefined && (typeof bundleBytesBase64 !== 'string' || bundleBytesBase64.length === 0))
  ) {
    return json({ error: 'Invalid batch file content' }, 400)
  }

  const filesToCommit = []
  if (manifestBytesBase64) {
    filesToCommit.push({ path: 'manifest.enc', content: manifestBytesBase64 })
  }
  if (bundleBytesBase64) {
    filesToCommit.push({ path: 'thumbs.bundle', content: bundleBytesBase64 })
  }
  for (const page of bundlePages) {
    if (
      !isValidIndex(page.pageIndex) ||
      typeof page.bytesBase64 !== 'string' ||
      page.bytesBase64.length === 0
    ) {
      return json({ error: 'Invalid bundle page in batch' }, 400)
    }
    filesToCommit.push({
      path: `thumbs_page_${page.pageIndex}.bundle`,
      content: page.bytesBase64,
    })
  }

  const lfsFilesToCommit = []
  for (const f of files) {
    if (!f.id || !/^[0-9a-f]{16}$/i.test(f.id)) {
      return json({ error: 'Invalid file id in batch' }, 400)
    }
    if (!f.sha256 || !/^[0-9a-f]{64}$/i.test(f.sha256)) {
      return json({ error: 'Invalid sha256 in batch' }, 400)
    }
    if (!Number.isFinite(f.size) || f.size <= 0) {
      return json({ error: 'Invalid size in batch' }, 400)
    }
    lfsFilesToCommit.push({
      path: `files/${f.id}.enc`,
      size: f.size,
      oid: f.sha256,
    })
  }

  for (const chunk of chunks) {
    if (!chunk.id || !/^[0-9a-f]{16}$/i.test(chunk.id)) {
      return json({ error: 'Invalid chunk file id in batch' }, 400)
    }
    if (!isValidIndex(chunk.index)) {
      return json({ error: 'Invalid chunk index in batch' }, 400)
    }
    if (!chunk.sha256 || !/^[0-9a-f]{64}$/i.test(chunk.sha256)) {
      return json({ error: 'Invalid chunk sha256 in batch' }, 400)
    }
    if (!Number.isFinite(chunk.size) || chunk.size <= 0) {
      return json({ error: 'Invalid chunk size in batch' }, 400)
    }
    lfsFilesToCommit.push({
      path: `files/${chunk.id}_chunk_${chunk.index}.enc`,
      size: chunk.size,
      oid: chunk.sha256,
    })
  }

  await ensureGitAttributes(env)
  await hfGitCommitBatch(
    env,
    `Batch upload ${lfsFilesToCommit.length} file(s)`,
    filesToCommit,
    lfsFilesToCommit,
  )
  return json({ ok: true }, 200)
}

async function hfGitCommitBatch(env, summary, filesToCommit, lfsFilesToCommit) {
  const batches = planCommitBatches(filesToCommit, lfsFilesToCommit)
  let result = null

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index]
    const suffix = batches.length > 1 ? ` (${index + 1}/${batches.length})` : ''
    result = await hfGitCommitOnce(
      env,
      `${summary}${suffix}`,
      batch.filesToCommit,
      batch.lfsFilesToCommit,
    )
  }

  return result
}

async function hfGitCommitOnce(env, summary, filesToCommit, lfsFilesToCommit) {
  const lines = []
  lines.push(JSON.stringify({ key: 'header', value: { summary } }))

  for (const f of filesToCommit) {
    lines.push(
      JSON.stringify({
        key: 'file',
        value: { path: f.path, content: f.content, encoding: 'base64' },
      }),
    )
  }

  for (const lf of lfsFilesToCommit) {
    lines.push(
      JSON.stringify({
        key: 'lfsFile',
        value: { path: lf.path, algo: 'sha256', size: lf.size, oid: lf.oid },
      }),
    )
  }

  const ndjson = lines.join('\n')

  return postHfCommit(env, ndjson, 'commit-batch')
}

async function listFiles({ env }) {
  const tree = await hfListTree(env, 'files')
  const ids = new Set()
  for (const entry of tree) {
    const match = entry.path.match(/^files\/([0-9a-f]{16})(?:_chunk_\d+)?\.enc$/i)
    if (match) ids.add(match[1])
  }
  return json([...ids], 200)
}

// ---------------------------------------------------------------------------
// V3 Route handlers — paginated bundle pages
// ---------------------------------------------------------------------------

/**
 * GET /get-bundle-page/:pageIndex
 * Resolves thumbs_page_N.bundle from HF and streams the raw bytes back.
 * Returns 404 if the page has not been created yet (the client treats this
 * as an empty page — valid for galleries still using the legacy single-bundle).
 */
async function getBundlePage({ env }, pageIndex) {
  if (!isValidIndex(pageIndex)) {
    return json({ error: 'Invalid bundle page index' }, 400)
  }
  const filename = `thumbs_page_${pageIndex}.bundle`
  return hfResolve(env, filename)
}

/**
 * POST /upload-bundle-page/:pageIndex
 * Uploads encrypted bundle page bytes to HF as thumbs_page_N.bundle.
 */
async function uploadBundlePage({ request, env }, pageIndex) {
  if (!isValidIndex(pageIndex)) {
    return json({ error: 'Invalid bundle page index' }, 400)
  }
  const bytes = await readRawBody(request)
  await ensureGitAttributes(env)
  const filename = `thumbs_page_${pageIndex}.bundle`
  await hfGitCommit(env, filename, bytes, `Update bundle page ${pageIndex}`)
  return json({ ok: true }, 200)
}

// ---------------------------------------------------------------------------
// V3 Route handlers — chunked file encryption (Feature 5)
// ---------------------------------------------------------------------------

/**
 * GET /get-chunk/:id/:index
 * Resolves files/<id>_chunk_<index>.enc from HF.
 * Chunks are stored under files/ so .gitattributes routes them to LFS automatically.
 */
async function getChunkHandler({ env }, id, index) {
  if (!id || !/^[0-9a-f]{16}$/i.test(id)) {
    return json({ error: 'Missing or invalid file id' }, 400)
  }
  if (!isValidIndex(index)) {
    return json({ error: 'Missing or invalid chunk index' }, 400)
  }
  return hfResolve(env, `files/${id}_chunk_${index}.enc`)
}

/**
 * POST /upload-chunk?id=...&index=...
 * Uploads a single encrypted chunk. Follows the same LFS path as /upload-file
 * so large chunks (e.g. 32 MB) are handled correctly.
 */
async function uploadChunkHandler({ request, url, env }) {
  const id = url.searchParams.get('id')
  const indexStr = url.searchParams.get('index')
  if (!id || !/^[0-9a-f]{16}$/i.test(id)) {
    return json({ error: 'Missing or invalid id query param' }, 400)
  }
  const index = Number(indexStr)
  if (!isValidIndex(index)) {
    return json({ error: 'Missing or invalid index query param' }, 400)
  }
  const commit = url.searchParams.get('commit') !== 'false'

  const path = `files/${id}_chunk_${index}.enc`
  await ensureGitAttributes(env)
  const descriptor = readUploadDescriptor(request)
  const result = descriptor
    ? await hfUploadStream(env, path, request.body, descriptor.size, descriptor.oid, commit)
    : await hfUploadFile(env, path, await readRawBody(request), commit)
  return json({ ok: true, id, index, sha256: result.oid, size: result.size }, 200)
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
  // Bust cache for mutable manifest, bundle, and salt to prevent CDN/caching issues
  const isMutable = (
    path === 'manifest.enc' ||
    path === 'thumbs.bundle' ||
    path === 'salt.bin' ||
    path === '.gitattributes' ||
    /^thumbs_page_\d+\.bundle$/.test(path)
  )
  const url = isMutable
    ? `${HF_API}/datasets/${env.HF_REPO}/resolve/main/${path}?t=${Date.now()}`
    : `${HF_API}/datasets/${env.HF_REPO}/resolve/main/${path}`

  const res = await fetch(url, {
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

  return postHfCommit(env, ndjson, `commit ${path}`)
}

/**
 * Stream an encrypted request body into its LFS upload target. The browser
 * supplies the SHA-256 and exact size of ciphertext that it already holds;
 * FixedLengthStream preserves Content-Length for signed object-storage PUTs
 * without buffering another copy inside the Worker isolate.
 */
async function hfUploadStream(env, path, source, size, oid, commit = true) {
  if (!source) throw storageError('UPLOAD_BODY_MISSING', 'Upload body is missing', false)

  const object = await requestLfsUpload(env, path, oid, size)
  const upload = object.actions && object.actions.upload

  if (upload) {
    let body = source
    let pipePromise = null

    if (typeof globalThis.FixedLengthStream === 'function') {
      const fixed = new globalThis.FixedLengthStream(size)
      body = fixed.readable
      pipePromise = source.pipeTo(fixed.writable).then(
        () => null,
        (error) => error,
      )
    }

    let putRes
    try {
      putRes = await fetch(upload.href, {
        method: 'PUT',
        headers: upload.header || {},
        body,
      })
      const pipeError = pipePromise ? await pipePromise : null
      if (pipeError) throw pipeError
    } catch (cause) {
      if (pipePromise) await pipePromise
      throw storageError('LFS_UPLOAD_FAILED', 'Encrypted object upload failed', true, cause)
    }

    if (!putRes.ok) throw await hfError(putRes, `lfs put ${path}`)
    const verify = object.actions && object.actions.verify
    if (verify) await verifyLfsUpload(verify, oid, size, path)
  } else {
    await source.cancel().catch(() => {})
  }

  if (commit) await commitLfsPointer(env, path, oid, size)
  return { oid, size }
}

async function requestLfsUpload(env, path, oid, size) {
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
  if (!object) {
    throw storageError('LFS_RESPONSE_INVALID', 'Storage returned an invalid upload response', true)
  }
  if (object.error) {
    throw storageError('LFS_OBJECT_REJECTED', 'Storage rejected the encrypted object', true)
  }
  if (object.oid !== oid || object.size !== size) {
    throw storageError('LFS_RESPONSE_MISMATCH', 'Storage returned a mismatched upload response', true)
  }
  return object
}

async function verifyLfsUpload(verify, oid, size, path) {
  const verifyRes = await fetch(verify.href, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.git-lfs+json',
      'Content-Type': 'application/vnd.git-lfs+json',
      ...(verify.header || {}),
    },
    body: JSON.stringify({ oid, size }),
  })
  if (!verifyRes.ok) throw await hfError(verifyRes, `lfs verify ${path}`)
}

async function commitLfsPointer(env, path, oid, size) {
  const ndjson = [
    JSON.stringify({ key: 'header', value: { summary: `Add ${path}` } }),
    JSON.stringify({
      key: 'lfsFile',
      value: { path, algo: 'sha256', size, oid },
    }),
  ].join('\n')
  return postHfCommit(env, ndjson, `commit lfs ${path}`)
}

/**
 * Upload any file. Small files go straight to git commit. Large files (or files
 * under an LFS path) follow the LFS flow: preupload → batch → S3 PUT → commit
 * as lfsFile. Mirrors @huggingface/hub's commit implementation.
 */
async function hfUploadFile(env, path, bytes, commit = true) {
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
    if (commit) {
      await hfGitCommit(env, path, bytes, `Add ${path}`)
    } else {
      throw new Error(`Cannot upload Git file without committing: ${path}`)
    }
    return { oid: await sha256Hex(bytes), size }
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
    if (verify) await verifyLfsUpload(verify, oid, size, path)
  }

  // Commit the LFS pointer.
  if (commit) {
    const ndjson = [
      JSON.stringify({ key: 'header', value: { summary: `Add ${path}` } }),
      JSON.stringify({
        key: 'lfsFile',
        value: { path, algo: 'sha256', size, oid },
      }),
    ].join('\n')

    await postHfCommit(env, ndjson, `commit lfs ${path}`)
  }

  return { oid, size }
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
let gitAttributesPromise = null
async function ensureGitAttributes(env) {
  if (gitAttributesEnsured) return
  if (!gitAttributesPromise) {
    gitAttributesPromise = (async () => {
      const tree = await hfListTree(env, '')
      const exists = tree.some((entry) => entry.path === '.gitattributes')
      let content = ''
      if (exists) {
        const response = await hfResolve(env, '.gitattributes')
        content = await response.text()
      }

      if (!content.split(/\r?\n/).some((line) => line.startsWith('files/** '))) {
        const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : ''
        const bytes = new TextEncoder().encode(
          `${content}${separator}${GITATTRIBUTES_CONTENT}`,
        )
        await hfGitCommit(env, '.gitattributes', bytes, 'Configure LFS for files/')
      }
      gitAttributesEnsured = true
    })().finally(() => {
      gitAttributesPromise = null
    })
  }
  await gitAttributesPromise
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

async function postHfCommit(env, ndjson, context) {
  let lastError = null

  for (let attempt = 0; attempt <= COMMIT_RETRY_DELAYS_MS.length; attempt += 1) {
    let response
    try {
      response = await fetch(`${HF_API}/api/datasets/${env.HF_REPO}/commit/main`, {
        method: 'POST',
        headers: authHeaders(env, { 'Content-Type': 'application/x-ndjson' }),
        body: ndjson,
      })
    } catch (cause) {
      lastError = storageError('HF_COMMIT_NETWORK', 'Storage commit network failure', true, cause)
      if (attempt === COMMIT_RETRY_DELAYS_MS.length) throw lastError
      await delay(COMMIT_RETRY_DELAYS_MS[attempt])
      continue
    }

    if (response.ok) return response.json()

    lastError = await hfError(response, context)
    if (!lastError.retryable || attempt === COMMIT_RETRY_DELAYS_MS.length) {
      throw lastError
    }
    await response.body?.cancel().catch(() => {})
    await delay(COMMIT_RETRY_DELAYS_MS[attempt])
  }

  throw lastError || storageError('HF_COMMIT_FAILED', 'Storage commit failed', true)
}

async function hfError(res, context) {
  const err = new Error(`HF ${res.status} ${context}`)
  err.status = res.status === 404 ? 404 : 502
  err.upstreamStatus = res.status
  err.code = context.includes('commit') ? 'HF_COMMIT_FAILED' : 'HF_STORAGE_FAILED'
  err.retryable = res.status === 409 || res.status === 429 || res.status >= 500
  return err
}

function readUploadDescriptor(request) {
  const oid = request.headers.get('X-Vault-SHA256') || ''
  const size = Number(request.headers.get('X-Vault-Size'))
  if (!/^[0-9a-f]{64}$/i.test(oid) || !Number.isSafeInteger(size) || size <= 0) {
    return null
  }
  return { oid: oid.toLowerCase(), size }
}

function storageError(code, message, retryable, cause) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.status = 502
  error.code = code
  error.retryable = retryable
  return error
}

function publicStorageError(error, status) {
  if (status === 404) return 'Not found'
  if (error.code === 'HF_COMMIT_FAILED' || error.code === 'HF_COMMIT_NETWORK') {
    return error.retryable
      ? 'Storage commit is temporarily unavailable. The encrypted upload can be finalized safely without uploading a duplicate.'
      : 'Storage rejected the encrypted vault update.'
  }
  return 'Storage request failed'
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function base64ToBytes(value) {
  try {
    const binary = atob(value)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return new Uint8Array()
  }
}

function isValidIndex(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}
