import {
  planAtomicCommitBatches,
  MAX_HF_OPERATIONS_PER_COMMIT,
} from './commitPlan.js'
import { verifyOwnerToken } from '../security/token.js'
import { verifyAccess, AccessAuthError } from '../security/access.js'

/**
 * VaultPhotos Cloudflare Worker
 *
 * Stateless storage/auth proxy between the React app and Hugging Face. The
 * worker is the only thing that holds the HF token. It never sees decrypted
 * content and never stores anything. All binary is transported as raw
 * `application/octet-stream` (not base64) so we stay well under the CF Worker
 * body limit and avoid 33% inflation. The worker base64-encodes internally only
 * when HF's git commit endpoint requires it (manifest, bundle, salt — all
 * small). Media files route through LFS as fixed-length streams using
 * browser-computed ciphertext hashes, so the Worker does not retain another
 * whole media buffer in memory.
 *
 * Concurrency (W1):
 *   - `GET /vault-head` returns the current main revision oid.
 *   - `parentCommit` (40-hex oid) is REQUIRED on the mutating metadata routes
 *     (`/commit-batch`, `/delete-media`). Without it two devices could
 *     overwrite each other; there is no legacy last-writer-wins path. The oid
 *     is forwarded to HF's commit endpoint as optimistic concurrency control. A
 *     conflict returns HTTP 409 with `code: "VAULT_STALE"` and
 *     `retryable: false` so the client re-reads the vault and rebases.
 *   - `/initialize-vault` bootstraps `.gitattributes` first, then pins the head
 *     and tree to one snapshot and CASes internally, so it cannot clobber a
 *     concurrent initialization. A stale client-supplied parent is rejected.
 *   - Multi-batch commits chain the returned `commitOid` of each staged batch
 *     as the `parentCommit` of the next, so our own intermediate commits do not
 *     trip the CAS check.
 *   - CAS commits are never blindly retried: only a 429 (definitely not
 *     applied) is retried automatically.
 *   - Media uploads are STAGED only (`commit=false`); pointers are published by
 *     the atomic CAS `/commit-batch`. The legacy whole-file metadata routes are
 *     disabled (410).
 *
 * Auth (S1): `env.ALLOWED_ORIGIN` is a comma-separated allow-list of browser
 * origins. Writes are fail-closed: if the allow-list is unset, every write is
 * rejected. CORS is NOT authentication (any non-browser client can forge an
 * `Origin` header) — pair this worker with Cloudflare Access in front of the
 * route for real authentication.
 *
 * HF wire format verified against @huggingface/hub source (commit + LFS batch):
 * `parentCommit` lives inside the NDJSON `header` operation value, and
 * `deletedFile` operations carry `{ path }`.
 */

const HF_API = 'https://huggingface.co'

const ALLOWED_METHODS = 'GET, POST, OPTIONS'
const ALLOWED_HEADERS = 'Content-Type, Authorization, X-Vault-SHA256, X-Vault-Size'
const CORS_MAX_AGE = '86400'

// files/** are stored via LFS so large videos don't bloat the git repo.
const LFS_PATTERNS = ['files/**', 'manifest.enc', 'salt.bin', 'thumbs*.bundle']

// Bounded retry schedule for legacy (non-CAS) commits. `Retry-After` /
// `X-RateLimit-Reset` override individual delays when present.
const COMMIT_RETRY_DELAYS_MS = [300, 900, 1800]
const MAX_COMMIT_ATTEMPTS = COMMIT_RETRY_DELAYS_MS.length + 1
const MAX_RETRY_AFTER_MS = 10_000

// Request bounds — protect the isolate (128 MB) and stop self-DoS via huge
// arrays. JSON bodies are text (base64 already carries a 33% overhead); raw
// bodies are buffered then base64-encoded for the git commit.
const MAX_JSON_BODY_BYTES = 32 * 1024 * 1024
const MAX_RAW_BODY_BYTES = 16 * 1024 * 1024
// Streaming uploads use crypto.DigestStream (no retained data). Where it is
// unavailable (Node test runtime) we fall back to a bounded buffer.
const MAX_UPLOAD_STREAM_BYTES = 16 * 1024 * 1024

// One request may stage at most this many LFS pointers (≈50 HF commits at 40
// ops each). Chunked media can produce many pointers per file.
const MAX_LFS_POINTERS_PER_REQUEST = 2000

// `/delete-media` publishes in a single atomic commit: deletedFile ops plus the
// manifest. Cap both the number of media ids and the total number of operations
// so one request can't build an unbounded NDJSON payload.
const MAX_DELETE_IDS = 500
const MAX_DELETE_OPERATIONS_PER_COMMIT = 1000

// Follow at most this many resolve redirects (HF 302s LFS pointers to S3).
const MAX_RESOLVE_REDIRECTS = 3

// Bounds on HF tree pagination.
const TREE_PAGE_LIMIT = 1000
const MAX_TREE_PAGES = 100
const MAX_TREE_ENTRIES = 200_000

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

// Routes intentionally disabled. They enabled unsafe, non-CAS metadata writes
// (or were unused dead code). They return 410 Gone.
const DISABLED_ROUTES = new Set([
  '/upload-salt',
  '/preauth-upload',
  '/commit-upload',
  // Metadata must only ever be published through the atomic CAS /commit-batch
  // path — these legacy routes did unversioned whole-file overwrites.
  '/upload-manifest',
  '/upload-bundle',
])

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const origin = request.headers.get('Origin')
    const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGIN)
    const originAllowed = origin !== null && allowedOrigins.includes(origin)

    if (request.method === 'OPTIONS') {
      return originAllowed
        ? new Response(null, { status: 204, headers: corsFor(origin) })
        : new Response(null, { status: 204, headers: { Vary: 'Origin' } })
    }

    const finalize = (response) => applyCors(response, originAllowed ? origin : null, url.pathname)

    if (url.pathname === '/auth-mode' && request.method === 'GET') {
      return finalize(json({ mode: env.AUTH_MODE === 'token' ? 'token' : 'access' }, 200))
    }

    if (!env.HF_TOKEN || !env.HF_REPO) {
      return finalize(json({ error: 'Worker misconfigured: HF_TOKEN and HF_REPO must be set' }, 500))
    }

    // Fail-closed write authorization. Reads stay public (the corpus is
    // end-to-end encrypted ciphertext); writes require an allow-listed Origin.
    if (WRITE_METHODS.has(request.method) && !originAllowed) {
      return finalize(json({
        error:
          'Write rejected: the request Origin is missing or not allowed. ' +
          'Set the ALLOWED_ORIGIN worker variable and send a matching Origin header. ' +
          'CORS is not authentication — use Cloudflare Access for real auth.',
        code: 'ORIGIN_NOT_ALLOWED',
        retryable: false,
      }, 403))
    }

    const startedAt = Date.now()
    try {
      // A forged Origin is not authentication. Public deployments always
      // verify the Access assertion, even if a workers.dev URL bypasses the
      // dashboard gateway. The exception is explicit, loopback-only local dev.
      const localDevelopment = env.ENVIRONMENT === 'development' &&
        url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      if (!localDevelopment) {
        if (env.AUTH_MODE === 'token') {
          if (!await verifyOwnerToken(request, env)) {
            return finalize(json({ error: 'A valid private access code is required', code: 'AUTH_REQUIRED', retryable: false }, 401))
          }
        } else {
          await verifyAccess(request, env)
        }
      }
      const handler = route(url.pathname, request.method)
      if (!handler) return finalize(json({ error: 'Not found' }, 404))

      const response = await handler({ request, url, env, ctx })
      const finalized = finalize(response)

      if (WRITE_METHODS.has(request.method) && finalized.ok) {
        console.log({
          event: 'vault_write',
          route: url.pathname,
          status: finalized.status,
          durationMs: Date.now() - startedAt,
        })
      }
      return finalized
    } catch (error) {
      const status = error.status || 500
      console.error('VaultPhotos storage request failed', {
        status,
        route: url.pathname,
        method: request.method,
        code: error.code || 'STORAGE_FAILED',
        upstreamStatus: error.upstreamStatus || null,
        upstreamReason: error.upstreamReason || null,
        durationMs: Date.now() - startedAt,
        stack: error.stack,
      })
      return finalize(json({
        error: publicStorageError(error, status),
        code: error.code || (status === 404 ? 'NOT_FOUND' : 'STORAGE_FAILED'),
        retryable: Boolean(error.retryable),
        ...(error.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}),
      }, status))
    }
  },
}

function route(path, method) {
  // Reads (all accept an optional ?revision=<oid> snapshot pin)
  if (path === '/get-salt' && method === 'GET') return getSalt
  if (path === '/get-manifest' && method === 'GET') return getManifest
  if (path === '/get-bundle' && method === 'GET') return getBundle
  if (path === '/vault-head' && method === 'GET') return vaultHead
  if (path === '/list' && method === 'GET') return listFiles
  const fileMatch = path.match(/^\/get-file\/([0-9a-f]{16})$/i)
  if (fileMatch && method === 'GET') return (ctx) => getFile(ctx, fileMatch[1])
  const bundlePageGetMatch = path.match(/^\/get-bundle-page\/(\d+)$/)
  if (bundlePageGetMatch && method === 'GET') {
    return (ctx) => getBundlePage(ctx, Number(bundlePageGetMatch[1]))
  }
  const chunkGetMatch = path.match(/^\/get-chunk\/([0-9a-f]{16})\/(\d+)$/i)
  if (chunkGetMatch && method === 'GET') {
    return (ctx) => getChunkHandler(ctx, chunkGetMatch[1], Number(chunkGetMatch[2]))
  }

  // Writes
  if (path === '/initialize-vault' && method === 'POST') return initializeVault
  if (path === '/commit-batch' && method === 'POST') return commitBatch
  if (path === '/delete-media' && method === 'POST') return deleteMedia
  if (path === '/upload-file' && method === 'POST') return uploadFile
  if (path === '/upload-chunk' && method === 'POST') return uploadChunkHandler

  // Disabled legacy routes.
  if (DISABLED_ROUTES.has(path) && method === 'POST') {
    return () => disabledRoute(path)
  }
  const bundlePagePostMatch = path.match(/^\/upload-bundle-page\/(\d+)$/)
  if (bundlePagePostMatch && method === 'POST') {
    return () => disabledRoute('/upload-bundle-page')
  }

  return null
}

function disabledRoute(path) {
  return json({
    error: `Route ${path} is disabled`,
    code: 'ROUTE_DISABLED',
    retryable: false,
  }, 410)
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function getSalt({ env, url }) {
  const revision = resolveRevision(url)
  if (revision.error) return invalidRevision(revision.error)
  return hfResolve(env, 'salt.bin', revision.value)
}

async function getManifest({ env, url }) {
  const revision = resolveRevision(url)
  if (revision.error) return invalidRevision(revision.error)
  return hfResolve(env, 'manifest.enc', revision.value)
}

async function getBundle({ env, url }) {
  const revision = resolveRevision(url)
  if (revision.error) return invalidRevision(revision.error)
  return hfResolve(env, 'thumbs.bundle', revision.value)
}

/**
 * GET /vault-head
 * Returns the current main revision oid: `{ oid }` (null before first commit).
 * Clients feed this into `parentCommit` for optimistic concurrency.
 */
async function vaultHead({ env }) {
  const oid = await hfHeadOid(env)
  return json({ oid }, 200)
}

async function getBundlePage({ env, url }, pageIndex) {
  if (!isValidIndex(pageIndex)) {
    return json({ error: 'Invalid bundle page index' }, 400)
  }
  const revision = resolveRevision(url)
  if (revision.error) return invalidRevision(revision.error)
  return hfResolve(env, `thumbs_page_${pageIndex}.bundle`, revision.value)
}

async function getFile({ env, url }, id) {
  const revision = resolveRevision(url)
  if (revision.error) return invalidRevision(revision.error)
  return hfResolve(env, `files/${id}.enc`, revision.value)
}

/**
 * GET /get-chunk/:id/:index
 * Chunks are stored under files/ so .gitattributes routes them to LFS.
 */
async function getChunkHandler({ env, url }, id, index) {
  if (!id || !/^[0-9a-f]{16}$/i.test(id)) {
    return json({ error: 'Missing or invalid file id' }, 400)
  }
  if (!isValidIndex(index)) {
    return json({ error: 'Missing or invalid chunk index' }, 400)
  }
  const revision = resolveRevision(url)
  if (revision.error) return invalidRevision(revision.error)
  return hfResolve(env, `files/${id}_chunk_${index}.enc`, revision.value)
}

async function listFiles({ env, url }) {
  const revision = resolveRevision(url)
  if (revision.error) return invalidRevision(revision.error)
  const tree = await hfListTree(env, 'files', revision.value)
  const ids = new Set()
  for (const entry of tree) {
    const match = entry.path.match(/^files\/([0-9a-f]{16})(?:_chunk_\d+)?\.enc$/i)
    if (match) ids.add(match[1])
  }
  return json([...ids], 200)
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * POST /initialize-vault
 *
 * First-run vault creation, made race-free by an internal CAS:
 *   1. Bootstrap `.gitattributes` first, so the repo has a head commit.
 *   2. Read the current head.
 *   3. Read the tree pinned to that head (one immutable snapshot) and refuse to
 *      overwrite an existing `manifest.enc`.
 *   4. CAS the initialize commit onto that head.
 *
 * A client-supplied `parentCommit` is never trusted implicitly: if it is
 * provided and does not match the head we CAS from, the request is rejected
 * with 409 VAULT_STALE so the caller re-reads and rebases.
 */
async function initializeVault({ request, env }) {
  const body = await readJsonBody(request)
  const { saltBytesBase64, manifestBytesBase64, bundlePageBytesBase64 } = body || {}

  if (
    typeof saltBytesBase64 !== 'string' ||
    typeof manifestBytesBase64 !== 'string' ||
    typeof bundlePageBytesBase64 !== 'string' ||
    manifestBytesBase64.length === 0 ||
    bundlePageBytesBase64.length === 0
  ) {
    return json({ error: 'Invalid initialization payload' }, 400)
  }
  if (base64ToBytes(saltBytesBase64).byteLength !== 16) {
    return json({ error: 'Salt must be exactly 16 bytes' }, 400)
  }

  const clientParent = normalizeParentCommit(body.parentCommit)
  if (clientParent.error) return json({ error: clientParent.error }, 400)

  // 1. Bootstrap LFS config first so a fresh repo has a head to CAS against.
  await ensureGitAttributes(env)

  // 2. Read the head, then 3. pin the tree snapshot to that exact revision.
  const head = await hfHeadOid(env)
  if (clientParent.value && clientParent.value !== head) {
    return vaultStale('The vault changed before initialization could be committed')
  }
  const tree = await hfListTree(env, '', head ?? 'main')
  if (tree.some((entry) => entry.path === 'manifest.enc')) {
    return json({
      error: 'Vault is already initialized',
      code: 'VAULT_INITIALIZED',
      retryable: false,
    }, 409)
  }

  const files = [
    { path: 'manifest.enc', content: manifestBytesBase64 },
    { path: 'thumbs_page_0.bundle', content: bundlePageBytesBase64 },
  ]
  if (!tree.some((entry) => entry.path === 'salt.bin')) {
    files.unshift({ path: 'salt.bin', content: saltBytesBase64 })
  }

  // 4. CAS onto the head we just read (always present after the bootstrap).
  const { result } = await hfGitCommitBatch(
    env,
    'Initialize encrypted vault',
    files,
    [],
    { parentCommit: head },
  )
  return json({ ok: true, commitOid: extractCommitOid(result) }, 200)
}

/**
 * POST /upload-file?id=...&commit=false
 * Binary LFS upload. Media is only ever STAGED here: the client must send
 * `commit=false` and the pointer is published later by the atomic CAS
 * `/commit-batch`. With a descriptor header we stream via FixedLengthStream +
 * crypto.DigestStream (verifying the ciphertext hash before returning);
 * otherwise we fall back to a bounded buffer.
 */
async function uploadFile({ request, url, env }) {
  const id = url.searchParams.get('id')
  if (!id || !/^[0-9a-f]{16}$/i.test(id)) {
    return json({ error: 'Missing or invalid id query param' }, 400)
  }
  if (url.searchParams.get('commit') !== 'false') {
    return commitNotAllowed()
  }

  const path = `files/${id}.enc`
  await ensureGitAttributes(env)
  const descriptor = readUploadDescriptor(request)
  const result = descriptor
    ? await hfUploadStream(env, path, request.body, descriptor.size, descriptor.oid, {
        signal: request.signal,
      })
    : await hfUploadFile(env, path, await readRawBody(request), false)
  return json({ ok: true, id, sha256: result.oid, size: result.size }, 200)
}

/**
 * POST /upload-chunk?id=...&index=...&commit=false
 * Stages a single encrypted chunk via the same LFS path as /upload-file.
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
  if (url.searchParams.get('commit') !== 'false') {
    return commitNotAllowed()
  }

  const path = `files/${id}_chunk_${index}.enc`
  await ensureGitAttributes(env)
  const descriptor = readUploadDescriptor(request)
  const result = descriptor
    ? await hfUploadStream(env, path, request.body, descriptor.size, descriptor.oid, {
        signal: request.signal,
      })
    : await hfUploadFile(env, path, await readRawBody(request), false)
  return json({ ok: true, id, index, sha256: result.oid, size: result.size }, 200)
}

function commitNotAllowed() {
  return json({
    error: 'Media uploads must be staged with commit=false; pointers are published via /commit-batch.',
    code: 'COMMIT_NOT_ALLOWED',
    retryable: false,
  }, 400)
}

/**
 * POST /commit-batch
 * Atomic batch publication.
 *
 * Body:
 *   files             [{ id, sha256, size }]        (single-object files)
 *   chunks            [{ id, index, sha256, size }] (chunked files)
 *   manifestBytesBase64
 *   bundleBytesBase64  (optional legacy single bundle)
 *   bundlePages        [{ pageIndex, bytesBase64 }]
 *   parentCommit       (REQUIRED 40-hex oid — CAS; read it from /vault-head)
 *
 * Every metadata file (manifest + bundle + pages), including pages that
 * re-encrypt existing content, publishes in the final atomic commit. If the
 * metadata set cannot fit in that commit the request is rejected with 413
 * METADATA_TOO_LARGE instead of staging metadata early.
 */
async function commitBatch({ request, env }) {
  const body = await readJsonBody(request)
  if (!body || typeof body !== 'object') {
    return json({ error: 'Invalid batch payload' }, 400)
  }

  const {
    files = [],
    chunks = [],
    manifestBytesBase64,
    bundleBytesBase64,
    bundlePages = [],
  } = body

  if (!Array.isArray(files) || !Array.isArray(chunks) || !Array.isArray(bundlePages)) {
    return json({ error: 'Invalid batch arrays' }, 400)
  }
  if (files.length + chunks.length > MAX_LFS_POINTERS_PER_REQUEST) {
    return tooLarge(
      `Too many file operations (${files.length + chunks.length}); ` +
        `limit is ${MAX_LFS_POINTERS_PER_REQUEST} per request`,
    )
  }
  if (bundlePages.length > MAX_HF_OPERATIONS_PER_COMMIT) {
    return tooLarge(
      `Too many bundle pages (${bundlePages.length}); ` +
        `limit is ${MAX_HF_OPERATIONS_PER_COMMIT} per atomic commit`,
    )
  }
  if (
    (manifestBytesBase64 !== undefined &&
      (typeof manifestBytesBase64 !== 'string' || manifestBytesBase64.length === 0)) ||
    (bundleBytesBase64 !== undefined &&
      (typeof bundleBytesBase64 !== 'string' || bundleBytesBase64.length === 0))
  ) {
    return json({ error: 'Invalid batch file content' }, 400)
  }

  // CAS is mandatory: without a parent the write could silently lose another
  // device's update. Clients read /vault-head immediately before committing.
  const parentCommit = requireParentCommit(body.parentCommit)
  if (parentCommit.error) return json({ error: parentCommit.error }, 400)

  const filesToCommit = []
  if (manifestBytesBase64) {
    filesToCommit.push({ path: 'manifest.enc', content: manifestBytesBase64 })
  }
  if (bundleBytesBase64) {
    filesToCommit.push({ path: 'thumbs.bundle', content: bundleBytesBase64 })
  }
  for (const page of bundlePages) {
    if (
      !page || typeof page !== 'object' ||
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
    if (!f || typeof f !== 'object' || !f.id || !/^[0-9a-f]{16}$/i.test(f.id)) {
      return json({ error: 'Invalid file id in batch' }, 400)
    }
    if (!f.sha256 || !/^[0-9a-f]{64}$/i.test(f.sha256)) {
      return json({ error: 'Invalid sha256 in batch' }, 400)
    }
    if (!Number.isSafeInteger(f.size) || f.size <= 0) {
      return json({ error: 'Invalid size in batch' }, 400)
    }
    lfsFilesToCommit.push({
      path: `files/${f.id}.enc`,
      size: f.size,
      oid: f.sha256,
    })
  }

  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== 'object' || !chunk.id || !/^[0-9a-f]{16}$/i.test(chunk.id)) {
      return json({ error: 'Invalid chunk file id in batch' }, 400)
    }
    if (!isValidIndex(chunk.index)) {
      return json({ error: 'Invalid chunk index in batch' }, 400)
    }
    if (!chunk.sha256 || !/^[0-9a-f]{64}$/i.test(chunk.sha256)) {
      return json({ error: 'Invalid chunk sha256 in batch' }, 400)
    }
    if (!Number.isSafeInteger(chunk.size) || chunk.size <= 0) {
      return json({ error: 'Invalid chunk size in batch' }, 400)
    }
    lfsFilesToCommit.push({
      path: `files/${chunk.id}_chunk_${chunk.index}.enc`,
      size: chunk.size,
      oid: chunk.sha256,
    })
  }

  if (filesToCommit.length === 0 && lfsFilesToCommit.length === 0) {
    return json({ error: 'Batch contains no operations' }, 400)
  }

  await ensureGitAttributes(env)
  try {
    const { result, batches } = await hfGitCommitBatch(
      env,
      `Batch upload ${lfsFilesToCommit.length} file(s)`,
      filesToCommit,
      lfsFilesToCommit,
      { parentCommit: parentCommit.value },
    )
    return json({
      ok: true,
      commitOid: extractCommitOid(result),
      batches,
    }, 200)
  } catch (error) {
    if (error.code === 'METADATA_TOO_LARGE') return tooLarge(error.message)
    throw error
  }
}

/**
 * POST /delete-media
 * Atomic delete: `deletedFile` operations for each media object (and its
 * chunks) plus the updated `manifest.enc`, in a single commit.
 *
 * Body:
 *   ids [{ id, chunk_count? }]
 *   manifestBytesBase64
 *   parentCommit (REQUIRED 40-hex oid — CAS; read it from /vault-head)
 *
 * For each id, EXACTLY ONE storage layout is targeted:
 *   - `chunk_count` present (>= 1) → the `files/<id>_chunk_<i>.enc` chunk objects
 *     (a chunked file has no whole-file object).
 *   - otherwise → the whole-file object `files/<id>.enc`.
 * Deletion is by git pointer only; history/GC is never rewritten automatically.
 *
 * Scope: only removes git pointers and republishes the manifest. It never
 * rewrites history or reclaims LFS storage automatically (that is a
 * destructive, explicit operation).
 */
async function deleteMedia({ request, env }) {
  const body = await readJsonBody(request)
  if (!body || typeof body !== 'object') {
    return json({ error: 'Invalid delete payload' }, 400)
  }

  const { ids, manifestBytesBase64 } = body
  if (!Array.isArray(ids) || ids.length === 0) {
    return json({ error: 'Missing or invalid ids' }, 400)
  }
  if (ids.length > MAX_DELETE_IDS) {
    return tooLarge(
      `Too many ids (${ids.length}); limit is ${MAX_DELETE_IDS} per request`,
    )
  }
  if (typeof manifestBytesBase64 !== 'string' || manifestBytesBase64.length === 0) {
    return json({ error: 'Missing manifestBytesBase64' }, 400)
  }

  const parentCommit = requireParentCommit(body.parentCommit)
  if (parentCommit.error) return json({ error: parentCommit.error }, 400)

  const deletePaths = new Set()
  for (const entry of ids) {
    if (!entry || typeof entry !== 'object' || !/^[0-9a-f]{16}$/i.test(entry.id)) {
      return json({ error: 'Invalid id in delete payload' }, 400)
    }
    const { id } = entry
    if (entry.chunk_count !== undefined && entry.chunk_count !== null) {
      if (
        !Number.isSafeInteger(entry.chunk_count) ||
        entry.chunk_count < 1 ||
        entry.chunk_count > MAX_DELETE_OPERATIONS_PER_COMMIT
      ) {
        return json({ error: 'Invalid chunk_count in delete payload' }, 400)
      }
      for (let index = 0; index < entry.chunk_count; index += 1) {
        deletePaths.add(`files/${id}_chunk_${index}.enc`)
      }
    } else {
      deletePaths.add(`files/${id}.enc`)
    }
  }

  if (deletePaths.size + 1 > MAX_DELETE_OPERATIONS_PER_COMMIT) {
    return tooLarge(
      `Too many delete operations (${deletePaths.size + 1}); ` +
        `limit is ${MAX_DELETE_OPERATIONS_PER_COMMIT} per commit`,
    )
  }

  const header = { summary: `Delete ${ids.length} media item(s)` }
  header.parentCommit = parentCommit.value
  const lines = [JSON.stringify({ key: 'header', value: header })]
  for (const path of deletePaths) {
    lines.push(JSON.stringify({ key: 'deletedFile', value: { path } }))
  }
  await ensureGitAttributes(env)
  lines.push(JSON.stringify(await stageMetadataOperation(env, { path: 'manifest.enc', content: manifestBytesBase64 })))

  const result = await postHfCommit(
    env,
    lines.join('\n'),
    'commit delete-media',
    { parentCommit: parentCommit.value },
  )
  return json({
    ok: true,
    commitOid: extractCommitOid(result),
    deleted: deletePaths.size,
  }, 200)
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

function encodeRepo(repoId) {
  return String(repoId).split('/').map(encodeURIComponent).join('/')
}

function encodePath(path) {
  return String(path)
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    .map(encodeURIComponent)
    .join('/')
}

/**
 * Resolve a raw file from HF and stream it back. HF 302-redirects LFS pointers
 * to S3, so this transparently works for both git and LFS files.
 *
 * Redirects are followed MANUALLY. `fetch`'s automatic redirect would replay the
 * `Authorization: Bearer <HF_TOKEN>` header on the cross-origin hop to S3/xet,
 * leaking the token; the redirect targets here are presigned URLs that need no
 * auth, so redirect hops are fetched without any HF credentials.
 *
 * `revision` defaults to `main`; a commit oid pins an immutable snapshot.
 */
async function hfResolve(env, path, revision = 'main') {
  const safePath = encodePath(path)
  const pinMain = revision === 'main'
  // Bust cache only for mutable `main` refs; a pinned revision is immutable.
  const isMutable = pinMain && (
    path === 'manifest.enc' ||
    path === 'thumbs.bundle' ||
    path === 'salt.bin' ||
    path === '.gitattributes' ||
    /^thumbs_page_\d+\.bundle$/.test(path)
  )
  const base = `${HF_API}/datasets/${encodeRepo(env.HF_REPO)}/resolve/${encodeURIComponent(revision)}/${safePath}`
  const url = isMutable ? `${base}?t=${Date.now()}` : base

  let res = await fetch(url, { headers: authHeaders(env), redirect: 'manual' })
  let hops = 0
  while (res.status >= 300 && res.status < 400 && hops < MAX_RESOLVE_REDIRECTS) {
    const location = res.headers.get('Location')
    try { await res.body?.cancel?.() } catch { /* ignore */ }
    if (!location) break

    let target
    try {
      target = new URL(location, url)
    } catch {
      break
    }
    if (target.protocol !== 'https:') {
      throw storageError('HF_REDIRECT_INSECURE', 'Storage returned an insecure redirect', false)
    }
    // Keep the bearer token only for a same-origin hop; never forward it to a
    // cross-origin target (S3/xet presigned URLs are self-authorizing).
    const sameOrigin = target.origin === HF_API
    res = await fetch(target, {
      redirect: 'manual',
      ...(sameOrigin ? { headers: authHeaders(env) } : {}),
    })
    hops += 1
  }

  if (res.status >= 300 && res.status < 400) {
    throw storageError('HF_REDIRECT_LOOP', 'Storage returned too many redirects', true)
  }
  if (res.status === 404) {
    const err = new Error('Not found in HF repo')
    err.status = 404
    err.code = 'NOT_FOUND'
    throw err
  }
  if (!res.ok) {
    throw await hfError(res, `resolve ${path}`)
  }
  const headers = new Headers()
  headers.set('Content-Type', res.headers.get('Content-Type') || 'application/octet-stream')
  const length = res.headers.get('Content-Length')
  if (length) headers.set('Content-Length', length)
  if (!pinMain) headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  return new Response(res.body, { status: 200, headers })
}

/**
 * Commit a small file to HF via the git commit endpoint using base64 content.
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

/** Default budget for a single streamed LFS PUT. */
const DEFAULT_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Resolve the upload timeout from (in order) an explicit option, an
 * `env.UPLOAD_TIMEOUT_MS` override (local dev / tests), or the default.
 */
function resolveUploadTimeoutMs(env, options) {
  for (const value of [options && options.timeoutMs, env && env.UPLOAD_TIMEOUT_MS]) {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_UPLOAD_TIMEOUT_MS
}

/**
 * Tear down the native upload pipeline deterministically. Order matters:
 * cancelling the body (the `FixedLengthStream` readable) cascades upstream and
 * cancels the request source; aborting the digest writer settles its `digest`
 * promise; aborting the controller aborts the in-flight PUT and any
 * signal-bound pipe. Every step is best-effort and never throws, so it is safe
 * to call from every failure path.
 */
function abortUploadPipeline(state, controller, reason) {
  if (state.body) {
    try {
      state.body.cancel(reason).catch(() => {})
    } catch {
      // Body already locked by fetch — aborting the controller cancels it there.
    }
  }
  if (state.digestWriter) {
    try {
      state.digestWriter.abort(reason).catch(() => {})
    } catch {
      // Writer already closed/aborted.
    }
  }
  try {
    controller.abort(reason)
  } catch {
    // Already aborted.
  }
}

function classifyUploadFailure({ timedOut, externallyAborted, cause }) {
  if (timedOut) {
    return httpError(504, 'LFS_UPLOAD_TIMEOUT', 'Encrypted object upload timed out', true)
  }
  if (externallyAborted) {
    return storageError('LFS_UPLOAD_ABORTED', 'Encrypted object upload was cancelled', false, cause)
  }
  return storageError('LFS_UPLOAD_FAILED', 'Encrypted object upload failed', true, cause)
}

/**
 * Stream an encrypted request body into its LFS upload target and verify the
 * ciphertext size + SHA-256 before returning.
 *
 * On Cloudflare the body is piped through a backpressure-aware TransformStream
 * into a `crypto.DigestStream` (hashes without retaining the bytes) and a
 * `FixedLengthStream` (enforces the declared size), so no second copy of the
 * media is buffered or teed. Where `DigestStream`/`FixedLengthStream` are
 * unavailable (Node test runtime) we fall back to a bounded buffer
 * (`MAX_UPLOAD_STREAM_BYTES`).
 *
 * Cancellation is explicit: one `AbortController` owns the PUT fetch, the source
 * pump and the digest writer. `options.signal` (the inbound `request.signal`)
 * and a bounded timeout both abort it, and a failed/early-non-OK PUT aborts it
 * immediately instead of detaching a stalled pipe. A stalled pipe is never
 * awaited after a failure, and the digest rejection handler is attached up front
 * so an aborted hash can never surface as an unhandled rejection.
 *
 * The LFS pointer is NEVER committed here — media is only staged; publication
 * happens in the atomic CAS `/commit-batch`.
 */
async function hfUploadStream(env, path, source, size, oid, options = {}) {
  if (!source) throw storageError('UPLOAD_BODY_MISSING', 'Upload body is missing', false)

  const object = await requestLfsUpload(env, path, oid, size, options)
  const upload = object.actions && object.actions.upload

  if (!upload) {
    // Object already exists (content-addressed dedup); nothing to send.
    await source.cancel().catch(() => {})
    return { oid, size }
  }

  const hasNativeStreams =
    typeof globalThis.FixedLengthStream === 'function' &&
    !!globalThis.crypto &&
    typeof globalThis.crypto.DigestStream === 'function'

  const controller = new AbortController()
  const externalSignal = options.signal || null
  let timedOut = false
  let externallyAborted = false
  let externalAbortHandler = null

  if (externalSignal) {
    if (externalSignal.aborted) {
      externallyAborted = true
      controller.abort(externalSignal.reason)
    } else {
      externalAbortHandler = () => {
        externallyAborted = true
        controller.abort(externalSignal.reason)
      }
      externalSignal.addEventListener('abort', externalAbortHandler)
    }
  }

  const timeoutTimer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('upload timed out'))
  }, resolveUploadTimeoutMs(env, options))

  // Cancellable native-pipeline resources.
  const state = { body: null, digestWriter: null, pipe: null }

  try {
    let body
    let digestPromise
    let receivedSize = null

    if (hasNativeStreams) {
      const digestStream = new globalThis.crypto.DigestStream('SHA-256')
      const digestWriter = digestStream.getWriter()
      state.digestWriter = digestWriter
      digestPromise = Promise.resolve(digestStream.digest).then(
        (buffer) => new Uint8Array(buffer),
      )
      // Attach now: `digestStream.digest` rejects when the pipeline is aborted,
      // and that rejection is expected on every failure path.
      digestPromise.catch(() => {})

      const fixed = new globalThis.FixedLengthStream(size)
      const pass = new TransformStream({
        transform(chunk, transformController) {
          // Backpressure-aware: await the digest write before forwarding, so
          // the digest sink is never unboundedly buffered.
          return digestWriter.write(chunk).then(() => {
            transformController.enqueue(chunk)
          })
        },
        flush() {
          return digestWriter.close()
        },
      })

      body = fixed.readable
      state.body = body
      state.pipe = source.pipeThrough(pass).pipeTo(fixed.writable).then(
        () => null,
        (error) => error,
      )
      state.pipe.catch(() => {})
    } else {
      const buffered = await bufferStream(source, MAX_UPLOAD_STREAM_BYTES)
      receivedSize = buffered.size
      body = buffered.bytes
      digestPromise = Promise.resolve(buffered.digest)
      digestPromise.catch(() => {})
    }

    let putRes
    try {
      putRes = await fetch(upload.href, {
        method: 'PUT',
        headers: upload.header || {},
        body,
        signal: controller.signal,
      })
    } catch (cause) {
      abortUploadPipeline(state, controller, cause)
      throw classifyUploadFailure({ timedOut, externallyAborted, cause })
    }

    if (!putRes.ok) {
      const failure = await hfError(putRes, `lfs put ${path}`)
      try { await putRes.body?.cancel?.() } catch { /* ignore */ }
      abortUploadPipeline(state, controller, failure)
      throw failure
    }

    // Success means the destination consumed the whole body, so the pipe has
    // settled. Only here is it safe to await it.
    if (state.pipe) {
      const pipeError = await state.pipe
      if (pipeError) {
        abortUploadPipeline(state, controller, pipeError)
        throw storageError('LFS_UPLOAD_FAILED', 'Encrypted object upload failed', true, pipeError)
      }
    }

    await verifyUploadedBytes(digestPromise, receivedSize, size, oid)

    const verify = object.actions && object.actions.verify
    if (verify) await verifyLfsUpload(verify, oid, size, path)

    return { oid, size }
  } finally {
    clearTimeout(timeoutTimer)
    if (externalSignal && externalAbortHandler) {
      externalSignal.removeEventListener('abort', externalAbortHandler)
    }
  }
}

/**
 * Verify the bytes we streamed match the client-declared size and SHA-256.
 * Any mismatch is a client/data-integrity failure and must abort BEFORE a
 * pointer can reference the object.
 */
async function verifyUploadedBytes(digestPromise, receivedSize, expectedSize, oid) {
  let digest
  try {
    digest = await digestPromise
  } catch (cause) {
    throw storageError('LFS_DIGEST_FAILED', 'Could not hash the uploaded ciphertext', true, cause)
  }

  if (receivedSize !== null && receivedSize !== expectedSize) {
    throw integrityError(
      'SIZE_MISMATCH',
      `Uploaded ${receivedSize} bytes but declared ${expectedSize}`,
    )
  }
  if (toHex(digest) !== oid) {
    throw integrityError(
      'DIGEST_MISMATCH',
      'Uploaded ciphertext does not match the declared SHA-256',
    )
  }
}

/**
 * Buffer a ReadableStream into memory with a hard cap. Only used where
 * `crypto.DigestStream` is unavailable (Node test runtime).
 */
async function bufferStream(source, maxBytes) {
  const reader = source.getReader()
  const chunks = []
  let total = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw httpError(413, 'REQUEST_TOO_LARGE', 'Upload body is too large to buffer', false)
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return { bytes, size: total, digest }
}

async function requestLfsUpload(env, path, oid, size, options = {}) {
  const batchRes = await fetch(
    `${HF_API}/datasets/${encodeRepo(env.HF_REPO)}.git/info/lfs/objects/batch`,
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
      // Propagate the caller's abort signal so a cancelled request does not
      // leave the batch negotiation hanging.
      ...(options.signal ? { signal: options.signal } : {}),
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
 * as lfsFile.
 */
async function hfUploadFile(env, path, bytes, commit = true) {
  const size = bytes.byteLength
  const sample = bytesToBase64(bytes.slice(0, 512))

  const preuploadRes = await fetch(
    `${HF_API}/api/datasets/${encodeRepo(env.HF_REPO)}/preupload/main`,
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
    if (commit) {
      await hfGitCommit(env, path, bytes, `Add ${path}`)
    } else {
      throw new Error(`Cannot upload Git file without committing: ${path}`)
    }
    return { oid: await sha256Hex(bytes), size }
  }

  const oid = await sha256Hex(bytes)
  const object = await requestLfsUpload(env, path, oid, size)
  const upload = object.actions && object.actions.upload
  if (upload) {
    const putRes = await fetch(upload.href, {
      method: 'PUT',
      headers: upload.header || {},
      body: bytes,
    })
    if (!putRes.ok) throw await hfError(putRes, `lfs put ${path}`)
    const verify = object.actions && object.actions.verify
    if (verify) await verifyLfsUpload(verify, oid, size, path)
  }

  if (commit) await commitLfsPointer(env, path, oid, size)
  return { oid, size }
}

/**
 * List a folder in the HF repo at a revision (default `main`), following
 * `Link: rel="next"` pagination. URLs are built from encoded path segments and
 * pagination links are only followed when they point back at the HF API (SSRF
 * guard). A 40-hex `revision` pins an immutable snapshot.
 */
async function hfListTree(env, folder, revision = 'main') {
  const safeFolder = encodePath(folder)
  let url = `${HF_API}/api/datasets/${encodeRepo(env.HF_REPO)}/tree/` +
    `${encodeURIComponent(revision)}/${safeFolder}?limit=${TREE_PAGE_LIMIT}`
  const entries = []

  for (let page = 0; page < MAX_TREE_PAGES; page += 1) {
    const res = await fetch(url, { headers: authHeaders(env) })
    if (res.status === 404) return entries
    if (!res.ok) throw await hfError(res, `tree ${folder}`)

    const json = await res.json()
    if (!Array.isArray(json)) return entries
    entries.push(...json)
    if (entries.length >= MAX_TREE_ENTRIES) break

    const next = parseNextLink(res.headers.get('Link') || res.headers.get('link'))
    if (!next || !isSafeHfApiUrl(next) || json.length === 0) break
    url = next
  }

  return entries
}

/**
 * Current commit oid of `main`, or null for an empty repo.
 */
async function hfHeadOid(env) {
  const res = await fetch(
    `${HF_API}/api/datasets/${encodeRepo(env.HF_REPO)}/commits/main?limit=1`,
    { headers: authHeaders(env) },
  )
  if (res.status === 404) return null
  if (!res.ok) throw await hfError(res, 'commits main')
  const commits = await res.json()
  if (!Array.isArray(commits) || commits.length === 0) return null
  const first = commits[0]
  return first.id || first.oid || first.commitId || null
}

/**
 * Ensure `.gitattributes` marks `files/**` as LFS. Idempotent per repo.
 */
const gitAttributesEnsured = new Set()
const gitAttributesPromises = new Map()
async function ensureGitAttributes(env) {
  const key = env.HF_REPO
  if (gitAttributesEnsured.has(key)) return
  let promise = gitAttributesPromises.get(key)
  if (!promise) {
    promise = (async () => {
      const tree = await hfListTree(env, '')
      const exists = tree.some((entry) => entry.path === '.gitattributes')
      let content = ''
      if (exists) {
        const response = await hfResolve(env, '.gitattributes')
        content = await response.text()
      }

      const lines = content.split(/\r?\n/)
      const missingPatterns = LFS_PATTERNS.filter((pattern) => !lines.some((line) =>
        line === `${pattern} filter=lfs diff=lfs merge=lfs -text`,
      ))
      if (missingPatterns.length > 0) {
        const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : ''
        const bytes = new TextEncoder().encode(
          `${content}${separator}${missingPatterns.map((pattern) => `${pattern} filter=lfs diff=lfs merge=lfs -text\n`).join('')}`,
        )
        await hfGitCommit(env, '.gitattributes', bytes, 'Configure LFS for files/')
      }
      gitAttributesEnsured.add(key)
    })().finally(() => {
      gitAttributesPromises.delete(key)
    })
    gitAttributesPromises.set(key, promise)
  }
  await promise
}

/**
 * Commit an atomic batch. Metadata (manifest + bundle + pages) is placed in the
 * final commit by {@link planAtomicCommitBatches}; earlier batches stage only
 * LFS pointers. Each subsequent commit chains the previous commit's oid as its
 * `parentCommit` so our own intermediate commits pass CAS.
 */
async function hfGitCommitBatch(env, summary, filesToCommit, lfsFilesToCommit, options = {}) {
  const batches = planAtomicCommitBatches(filesToCommit, lfsFilesToCommit)
  if (batches.length === 0) return { result: null, batches: 0 }

  let parentCommit = options.parentCommit || null
  let result = null

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index]
    const suffix = batches.length > 1 ? ` (${index + 1}/${batches.length})` : ''
    result = await hfGitCommitOnce(
      env,
      `${summary}${suffix}`,
      batch.filesToCommit,
      batch.lfsFilesToCommit,
      { parentCommit },
    )

    if (index < batches.length - 1) {
      parentCommit = extractCommitOid(result)
      if (!parentCommit) {
        throw storageError(
          'HF_COMMIT_OID_MISSING',
          'Storage commit did not return an oid required to chain the next batch',
          false,
        )
      }
    }
  }

  return { result, batches: batches.length }
}

async function hfGitCommitOnce(env, summary, filesToCommit, lfsFilesToCommit, options = {}) {
  const header = { summary }
  if (options.parentCommit) header.parentCommit = options.parentCommit

  const lines = [JSON.stringify({ key: 'header', value: header })]

  for (const lf of lfsFilesToCommit) {
    lines.push(JSON.stringify({ key: 'lfsFile', value: {
      path: lf.path, algo: 'sha256', size: lf.size, oid: lf.oid,
    } }))
  }
  // Metadata remains in the final atomic transaction, but encrypted bytes
  // must be stored as LFS objects too. HF rejects binary regular Git files.
  for (const file of filesToCommit) {
    lines.push(JSON.stringify(await stageMetadataOperation(env, file)))
  }

  return postHfCommit(env, lines.join('\n'), 'commit-batch', { parentCommit: options.parentCommit })
}

async function stageMetadataOperation(env, file) {
  const bytes = base64ToBytes(file.content)
  if (!bytes.byteLength) throw httpError(400, 'INVALID_METADATA', 'Encrypted metadata cannot be empty')
  const oid = await sha256Hex(bytes)
  await hfUploadStream(env, file.path, new Response(bytes).body, bytes.byteLength, oid)
  return { key: 'lfsFile', value: { path: file.path, algo: 'sha256', size: bytes.byteLength, oid } }
}

/**
 * POST an NDJSON commit body with bounded retries.
 *
 * Retry policy:
 *   - 409 → definitive conflict: `VAULT_STALE`, non-retryable, never retried.
 *   - 429 → safe to retry (the commit was not applied); honour backoff headers.
 *   - 5xx / network → retried only for non-CAS commits. A CAS commit's outcome
 *     is ambiguous (it may have landed), so it is not blindly replayed; the
 *     client re-reads `/vault-head` and rebases instead.
 */
async function postHfCommit(env, ndjson, context, options = {}) {
  const parentCommit = options.parentCommit || null
  let lastError = null

  for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
    let response
    try {
      response = await fetch(`${HF_API}/api/datasets/${encodeRepo(env.HF_REPO)}/commit/main`, {
        method: 'POST',
        headers: authHeaders(env, { 'Content-Type': 'application/x-ndjson' }),
        body: ndjson,
      })
    } catch (cause) {
      lastError = storageError('HF_COMMIT_NETWORK', 'Storage commit network failure', true, cause)
      if (parentCommit || attempt === MAX_COMMIT_ATTEMPTS - 1) throw lastError
      await delay(COMMIT_RETRY_DELAYS_MS[attempt])
      continue
    }

    if (response.ok) return response.json()

    lastError = await hfError(response, context)
    const retryAfterMs = parseRetryAfterMs(response)
    response.body?.cancel?.().catch(() => {})

    if (!lastError.retryable || attempt === MAX_COMMIT_ATTEMPTS - 1) {
      throw lastError
    }
    if (parentCommit && lastError.upstreamStatus !== 429) {
      throw lastError
    }

    await delay(retryAfterMs ?? COMMIT_RETRY_DELAYS_MS[attempt])
  }

  throw lastError || storageError('HF_COMMIT_FAILED', 'Storage commit failed', true)
}

async function hfError(res, context) {
  const err = new Error(`HF ${res.status} ${context}`)
  err.upstreamStatus = res.status
  // Keep useful storage diagnostics in server logs only. Bound the error body,
  // extract just its message, and redact credentials before logging.
  try {
    let message = res.headers.get('X-Error-Message') || ''
    if (!message && res.body) {
      const reader = res.body.getReader()
      const parts = []
      let length = 0
      try {
        while (length <= 4096) {
          const { done, value } = await reader.read()
          if (done) break
          length += value.byteLength
          if (length > 4096) { await reader.cancel(); break }
          parts.push(value)
        }
        if (length <= 4096) {
          const bytes = new Uint8Array(length)
          let offset = 0
          for (const part of parts) { bytes.set(part, offset); offset += part.byteLength }
          const text = new TextDecoder().decode(bytes)
          try { const body = JSON.parse(text); message = typeof body.error === 'string' ? body.error : '' }
          catch { message = text }
        }
      } finally { reader.releaseLock() }
    }
    err.upstreamReason = message.replace(/hf_[A-Za-z0-9]+/g, '[redacted]')
      .replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [redacted]').slice(0, 512)
  } catch { /* Diagnostics never replace the original upstream failure. */ }
  if (res.status === 409 || res.status === 412) {
    err.status = 409
    err.code = 'VAULT_STALE'
    err.retryable = false
  } else {
    err.status = res.status === 404 ? 404 : 502
    err.code = context.includes('commit') ? 'HF_COMMIT_FAILED' : 'HF_STORAGE_FAILED'
    err.retryable = res.status === 429 || res.status >= 500
  }
  return err
}

// ---------------------------------------------------------------------------
// Request parsing / bounds
// ---------------------------------------------------------------------------

async function readJsonBody(request, maxBytes = MAX_JSON_BODY_BYTES) {
  const declared = Number(request.headers.get('Content-Length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw httpError(413, 'REQUEST_TOO_LARGE', 'Request body is too large', false)
  }

  let text
  try {
    text = await request.text()
  } catch {
    throw httpError(400, 'INVALID_JSON', 'Request body could not be read', false)
  }
  if (text.length > maxBytes) {
    throw httpError(413, 'REQUEST_TOO_LARGE', 'Request body is too large', false)
  }
  if (text.trim().length === 0) {
    throw httpError(400, 'INVALID_JSON', 'Request body must be valid JSON', false)
  }

  try {
    return JSON.parse(text)
  } catch {
    throw httpError(400, 'INVALID_JSON', 'Request body must be valid JSON', false)
  }
}

async function readRawBody(request, maxBytes = MAX_RAW_BODY_BYTES) {
  const declared = Number(request.headers.get('Content-Length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw httpError(413, 'REQUEST_TOO_LARGE', 'Request body is too large', false)
  }
  const buffer = await request.arrayBuffer()
  if (buffer.byteLength > maxBytes) {
    throw httpError(413, 'REQUEST_TOO_LARGE', 'Request body is too large', false)
  }
  return new Uint8Array(buffer)
}

function readUploadDescriptor(request) {
  const oid = request.headers.get('X-Vault-SHA256') || ''
  const size = Number(request.headers.get('X-Vault-Size'))
  if (!/^[0-9a-f]{64}$/i.test(oid) || !Number.isSafeInteger(size) || size <= 0) {
    return null
  }
  return { oid: oid.toLowerCase(), size }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveRevision(url) {
  const raw = url.searchParams.get('revision')
  if (raw === null || raw === '') return { value: 'main' }
  if (raw === 'main') return { value: 'main' }
  if (/^[0-9a-f]{40}$/i.test(raw)) return { value: raw.toLowerCase() }
  return { error: 'Invalid revision (expected a 40-hex commit oid or "main")' }
}

function invalidRevision(message) {
  return json({ error: message, code: 'INVALID_REVISION', retryable: false }, 400)
}

function normalizeParentCommit(value) {
  if (value === undefined || value === null) return { value: null }
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value)) {
    return { error: 'Invalid parentCommit (expected a 40-hex commit oid)' }
  }
  return { value: value.toLowerCase() }
}

/**
 * CAS is mandatory on mutating metadata routes. A missing parent is rejected so
 * a write can never silently overwrite another device's committed update.
 */
function requireParentCommit(value) {
  const normalized = normalizeParentCommit(value)
  if (normalized.error) return normalized
  if (!normalized.value) {
    return {
      error: 'Missing parentCommit: read the current revision from /vault-head and retry',
    }
  }
  return normalized
}

function vaultStale(message) {
  return json({ error: message, code: 'VAULT_STALE', retryable: false }, 409)
}

function integrityError(code, message) {
  return httpError(400, code, message, false)
}

function extractCommitOid(result) {
  if (!result || typeof result !== 'object') return null
  return result.commitOid || result.oid || null
}

function parseAllowedOrigins(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return []
  return value
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter((origin) => origin.length > 0)
}

function corsFor(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Max-Age': CORS_MAX_AGE,
    Vary: 'Origin',
  }
}

function applyCors(response, origin, pathname) {
  const headers = new Headers(response.headers)
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Access-Control-Allow-Credentials', 'true')
  } else {
    headers.delete('Access-Control-Allow-Origin')
    headers.delete('Access-Control-Allow-Credentials')
  }
  headers.set('Vary', 'Origin')
  headers.set('Cache-Control', 'no-store')
  headers.set('Access-Control-Allow-Methods', ALLOWED_METHODS)
  headers.set('Access-Control-Allow-Headers', ALLOWED_HEADERS)
  headers.set('Access-Control-Max-Age', CORS_MAX_AGE)

  const mutablePaths = [
    '/get-salt', '/get-manifest', '/get-bundle', '/vault-head', '/list', '/get-bundle-page',
  ]
  const isMutable = mutablePaths.some(
    (p) => pathname === p || pathname.startsWith(p + '/'),
  )
  if (isMutable) {
    headers.set('Cache-Control', 'no-cache, no-store, must-revalidate')
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/)
    if (match) return match[1]
  }
  return null
}

function isSafeHfApiUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' &&
      url.hostname === 'huggingface.co' &&
      url.pathname.startsWith('/api/')
  } catch {
    return false
  }
}

function parseRetryAfterMs(response) {
  const retryAfter = response.headers.get('Retry-After')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
    }
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) {
      return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS)
    }
  }
  const reset = response.headers.get('X-RateLimit-Reset')
  if (reset) {
    const seconds = Number(reset)
    if (Number.isFinite(seconds)) {
      const target = seconds > 1e12 ? seconds : seconds * 1000
      return Math.min(Math.max(0, target - Date.now()), MAX_RETRY_AFTER_MS)
    }
  }
  return null
}

function tooLarge(message) {
  return json({ error: message, code: 'BATCH_TOO_LARGE', retryable: false }, 413)
}

function storageError(code, message, retryable, cause) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.status = 502
  error.code = code
  error.retryable = retryable
  return error
}

function httpError(status, code, message, retryable = false) {
  const error = new Error(message)
  error.status = status
  error.code = code
  error.retryable = retryable
  return error
}

function publicStorageError(error, status) {
  if (error instanceof AccessAuthError) return error.message
  if (status === 404) return 'Not found'
  if (status === 409) {
    return 'The vault changed while this update was being prepared. Re-read the latest vault and retry.'
  }
  if (status === 413) return 'The request is too large for one atomic update.'
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

function bytesToBase64(bytes) {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode.apply(null, chunk)
  }
  return btoa(binary)
}

function toHex(bytes) {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return toHex(new Uint8Array(digest))
}

function isValidIndex(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
