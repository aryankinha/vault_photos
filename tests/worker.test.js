import test from 'node:test'
import assert from 'node:assert/strict'

const { default: worker } = await import('../worker/index.js')

const ORIGIN = 'https://app.example'
const env = {
  HF_TOKEN: 'test-token',
  HF_REPO: 'test-user/test-repo',
  ALLOWED_ORIGIN: ORIGIN,
  ENVIRONMENT: 'development',
}
const PARENT = 'a'.repeat(40)

function workerRequest(path, { method = 'GET', body, headers = {}, origin = ORIGIN } = {}) {
  const merged = { ...headers }
  if (origin) merged.Origin = origin
  return new Request(`http://127.0.0.1:8787${path}`, { method, headers: merged, body })
}

function postJson(path, payload) {
  return workerRequest(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

/**
 * A fetch mock that:
 *   - serves the `.gitattributes` lookup so ensureGitAttributes is a no-op, and
 *   - serves the repo root tree listing (`/tree/<rev>/?limit=...`, `rootTree`).
 * Everything else is delegated to `handler`.
 */
function installFetch(t, handler, options = {}) {
  const rootTree = options.rootTree ?? [{ path: '.gitattributes', type: 'file' }]
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    if (url.includes('/resolve/main/.gitattributes')) {
      return new Response('files/** filter=lfs diff=lfs merge=lfs -text\n')
    }
    if (/\/tree\/[^/]+\/\?/.test(url)) {
      return Response.json(rootTree)
    }
    return handler(url, init)
  }
}

function captureCommits(commits) {
  return async (url, init) => {
    if (url.includes('/commit/main')) {
      commits.push(String(init.body))
      return Response.json({ commitOid: `commit-${commits.length}` })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
}

function parseHeader(ndjson) {
  return JSON.parse(ndjson.split('\n')[0]).value
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

test('production requires Access configuration and cannot be bypassed with a forged Origin', async () => {
  const request = new Request('https://worker.example/vault-head', { headers: { Origin: ORIGIN } })
  const unconfigured = await worker.fetch(request, env)
  assert.equal(unconfigured.status, 503)
  assert.equal((await unconfigured.json()).code, 'ACCESS_NOT_CONFIGURED')
  const configured = {
    ...env, ACCESS_TEAM_DOMAIN: 'https://test-team.cloudflareaccess.com', ACCESS_AUD: 'test-audience',
  }
  const missing = await worker.fetch(request, configured)
  assert.equal(missing.status, 401)
  assert.equal((await missing.json()).code, 'ACCESS_ASSERTION_MISSING')
  const write = await worker.fetch(new Request('https://worker.example/commit-batch', {
    method: 'POST', headers: { Origin: ORIGIN }, body: '{}',
  }), configured)
  assert.equal(write.status, 401)
})

test('Access cookies have credentialed CORS only for the configured frontend', async () => {
  const response = await worker.fetch(workerRequest('/get-salt', { method: 'OPTIONS' }), env)
  assert.equal(response.status, 204)
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), 'true')
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN)
  const forbidden = await worker.fetch(workerRequest('/get-salt', { method: 'OPTIONS', origin: 'https://evil.example' }), env)
  assert.equal(forbidden.headers.get('Access-Control-Allow-Origin'), null)
})

// ---------------------------------------------------------------------------
// commit-batch: atomic metadata + CAS
// ---------------------------------------------------------------------------

test('commit-batch splits pointer operations and publishes metadata last', async (t) => {
  const commits = []
  installFetch(t, captureCommits(commits))

  const response = await worker.fetch(postJson('/commit-batch', {
    parentCommit: PARENT,
    files: makeFiles(81),
    manifestBytesBase64: 'AQ==',
    bundlePages: [{ pageIndex: 0, bytesBase64: 'Ag==' }],
  }), env)

  assert.equal(response.status, 200)
  assert.equal(commits.length, 3)
  assert.equal(countNdjsonKey(commits[0], 'lfsFile'), 40)
  assert.equal(countNdjsonKey(commits[1], 'lfsFile'), 40)
  assert.equal(countNdjsonKey(commits[2], 'lfsFile'), 1)
  assert.equal(countNdjsonKey(commits[0], 'file'), 0)
  assert.equal(countNdjsonKey(commits[1], 'file'), 0)
  assert.equal(countNdjsonKey(commits[2], 'file'), 2)
  assert.equal(lastFileOp(commits[2]).value.path, 'manifest.enc')
})

test('every metadata file (including existing bundle pages) publishes only in the final commit', async (t) => {
  const commits = []
  installFetch(t, captureCommits(commits))

  const response = await worker.fetch(postJson('/commit-batch', {
    parentCommit: PARENT,
    files: makeFiles(100),
    manifestBytesBase64: 'AQ==',
    bundlePages: [
      { pageIndex: 3, bytesBase64: 'Aw==' },
      { pageIndex: 4, bytesBase64: 'BA==' },
    ],
  }), env)

  assert.equal(response.status, 200)
  assert.equal(commits.length, 3)
  assert.equal(countNdjsonKey(commits[0], 'file'), 0)
  assert.equal(countNdjsonKey(commits[1], 'file'), 0)
  assert.equal(countNdjsonKey(commits[2], 'file'), 3)
  assert.equal(countNdjsonKey(commits[2], 'lfsFile'), 20)
  const filePaths = commits[2]
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((line) => line.key === 'file')
    .map((line) => line.value.path)
  assert.deepEqual(new Set(filePaths), new Set([
    'thumbs_page_3.bundle',
    'thumbs_page_4.bundle',
    'manifest.enc',
  ]))
  assert.equal(filePaths.at(-1), 'manifest.enc')
})

test('commit-batch REQUIRES a parentCommit (no lost-update path)', async (t) => {
  installFetch(t, async () => { throw new Error('should not fetch') })
  const response = await worker.fetch(postJson('/commit-batch', {
    files: [],
    manifestBytesBase64: 'AQ==',
  }), env)
  assert.equal(response.status, 400)
  assert.match((await response.json()).error, /parentCommit/)

  const invalid = await worker.fetch(postJson('/commit-batch', {
    parentCommit: 'not-an-oid',
    files: [],
    manifestBytesBase64: 'AQ==',
  }), env)
  assert.equal(invalid.status, 400)
})

test('multi-batch CAS chains the returned commitOid as parentCommit', async (t) => {
  const headers = []
  installFetch(t, async (url, init) => {
    if (url.includes('/commit/main')) {
      headers.push(parseHeader(String(init.body)))
      return Response.json({ commitOid: `oid-${headers.length}` })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })

  const response = await worker.fetch(postJson('/commit-batch', {
    parentCommit: PARENT,
    files: makeFiles(81),
    manifestBytesBase64: 'AQ==',
  }), env)

  assert.equal(response.status, 200)
  assert.equal(headers.length, 3)
  assert.equal(headers[0].parentCommit, PARENT)
  assert.equal(headers[1].parentCommit, 'oid-1')
  assert.equal(headers[2].parentCommit, 'oid-2')
})

test('CAS conflict returns 409 VAULT_STALE and is not retried', async (t) => {
  let attempts = 0
  installFetch(t, async (url) => {
    if (url.includes('/commit/main')) {
      attempts += 1
      return new Response('conflict', { status: 409 })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })

  const response = await worker.fetch(postJson('/commit-batch', {
    parentCommit: PARENT,
    files: [],
    manifestBytesBase64: 'AQ==',
  }), env)

  assert.equal(response.status, 409)
  assert.equal(attempts, 1)
  const body = await response.json()
  assert.equal(body.code, 'VAULT_STALE')
  assert.equal(body.retryable, false)
})

test('commit-batch retries a 429 (definitely not applied) with an identical body', async (t) => {
  let attempts = 0
  const bodies = []
  installFetch(t, async (url, init) => {
    if (!url.includes('/commit/main')) throw new Error(`Unexpected fetch: ${url}`)
    attempts += 1
    bodies.push(String(init.body))
    if (attempts === 1) return new Response('slow down', { status: 429 })
    return Response.json({ commitOid: 'recovered' })
  })

  const response = await worker.fetch(postJson('/commit-batch', {
    parentCommit: PARENT,
    files: [],
    manifestBytesBase64: 'AQ==',
  }), env)

  assert.equal(response.status, 200)
  assert.equal(attempts, 2)
  assert.equal(bodies[0], bodies[1])
})

test('a CAS commit is not blindly retried on a transient 5xx', async (t) => {
  let attempts = 0
  installFetch(t, async (url) => {
    if (!url.includes('/commit/main')) throw new Error(`Unexpected fetch: ${url}`)
    attempts += 1
    return new Response('temporary', { status: 503 })
  })

  const response = await worker.fetch(postJson('/commit-batch', {
    parentCommit: PARENT,
    files: [],
    manifestBytesBase64: 'AQ==',
  }), env)

  assert.equal(response.status, 502)
  assert.equal(attempts, 1)
})

test('too much metadata is rejected instead of staged early', async (t) => {
  installFetch(t, async () => { throw new Error('should not fetch') })

  const bundlePages = Array.from({ length: 40 }, (_, index) => ({
    pageIndex: index,
    bytesBase64: 'AA==',
  }))
  const response = await worker.fetch(postJson('/commit-batch', {
    parentCommit: PARENT,
    files: [],
    manifestBytesBase64: 'AQ==',
    bundlePages,
  }), env)

  assert.equal(response.status, 413)
  assert.equal((await response.json()).code, 'BATCH_TOO_LARGE')
})

// ---------------------------------------------------------------------------
// Request validation / bounds
// ---------------------------------------------------------------------------

test('unbounded file arrays are rejected with 413', async (t) => {
  installFetch(t, async () => { throw new Error('should not fetch') })
  const response = await worker.fetch(postJson('/commit-batch', {
    parentCommit: PARENT,
    files: makeFiles(2001),
    manifestBytesBase64: 'AQ==',
  }), env)
  assert.equal(response.status, 413)
  assert.equal((await response.json()).code, 'BATCH_TOO_LARGE')
})

test('null/ill-typed batch entries and unsafe sizes are rejected with 400', async (t) => {
  installFetch(t, async () => { throw new Error('should not fetch') })
  const cases = [
    { files: [null], manifestBytesBase64: 'AQ==' },
    { files: [{ id: '0'.repeat(16), sha256: 'a'.repeat(64), size: 1.5 }] },
    { files: [{ id: '0'.repeat(16), sha256: 'a'.repeat(64), size: Number.MAX_SAFE_INTEGER + 2 }] },
    { files: [{ id: '0'.repeat(16), sha256: 'a'.repeat(64), size: 0 }] },
    { chunks: [null] },
    { chunks: [{ id: '0'.repeat(16), index: -1, sha256: 'a'.repeat(64), size: 1 }] },
    { bundlePages: [null], manifestBytesBase64: 'AQ==' },
    { bundlePages: [{ pageIndex: 'x', bytesBase64: 'AA==' }], manifestBytesBase64: 'AQ==' },
  ]
  for (const payload of cases) {
    const response = await worker.fetch(postJson('/commit-batch', {
      parentCommit: PARENT,
      manifestBytesBase64: 'AQ==',
      ...payload,
    }), env)
    assert.equal(response.status, 400, JSON.stringify(payload))
  }
})

test('invalid JSON bodies return 400 INVALID_JSON', async (t) => {
  installFetch(t, async () => { throw new Error('should not fetch') })
  const response = await worker.fetch(workerRequest('/commit-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  }), env)
  assert.equal(response.status, 400)
  assert.equal((await response.json()).code, 'INVALID_JSON')
})

test('writes fail closed without an allow-listed Origin', async (t) => {
  installFetch(t, async () => { throw new Error('should not fetch') })

  const noOriginHeader = await worker.fetch(workerRequest('/commit-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentCommit: PARENT, files: [], manifestBytesBase64: 'AQ==' }),
    origin: null,
  }), env)
  assert.equal(noOriginHeader.status, 403)
  assert.equal((await noOriginHeader.json()).code, 'ORIGIN_NOT_ALLOWED')

  const wrongOrigin = await worker.fetch(workerRequest('/commit-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentCommit: PARENT, files: [], manifestBytesBase64: 'AQ==' }),
    origin: 'https://evil.example',
  }), env)
  assert.equal(wrongOrigin.status, 403)

  const unset = await worker.fetch(postJson('/commit-batch', {
    parentCommit: PARENT, files: [], manifestBytesBase64: 'AQ==',
  }), { HF_TOKEN: 't', HF_REPO: 'r/r' })
  assert.equal(unset.status, 403)
})

test('disabled legacy metadata + unsafe routes return 410 Gone', async (t) => {
  installFetch(t, async () => { throw new Error('should not fetch') })
  const paths = [
    '/upload-salt',
    '/preauth-upload',
    '/commit-upload',
    '/upload-manifest',
    '/upload-bundle',
    '/upload-bundle-page/2',
  ]
  for (const path of paths) {
    const response = await worker.fetch(workerRequest(path, {
      method: 'POST',
      body: new Uint8Array([1, 2, 3]),
      headers: { 'Content-Type': 'application/octet-stream' },
    }), env)
    assert.equal(response.status, 410, path)
    assert.equal((await response.json()).code, 'ROUTE_DISABLED')
  }
})

// ---------------------------------------------------------------------------
// Media staging uploads (integrity)
// ---------------------------------------------------------------------------

function installUploadFetch(t, state) {
  installFetch(t, async (url, init) => {
    if (url.includes('/objects/batch')) {
      const requested = JSON.parse(String(init.body)).objects[0]
      return Response.json({
        objects: [{
          oid: requested.oid,
          size: requested.size,
          actions: {
            upload: { href: 'https://storage.example/upload', header: {} },
            verify: { href: 'https://storage.example/verify', header: {} },
          },
        }],
      })
    }
    if (url === 'https://storage.example/upload') {
      state.uploaded = new Uint8Array(await new Response(init.body).arrayBuffer())
      return new Response(null, { status: 200 })
    }
    if (url === 'https://storage.example/verify') {
      state.verified = JSON.parse(String(init.body))
      return new Response(null, { status: 200 })
    }
    if (url.includes('/commit/main')) {
      state.commitCalls += 1
      return Response.json({ ok: true })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
}

function uploadFileRequest(ciphertext, sha256) {
  return workerRequest('/upload-file?id=0123456789abcdef&commit=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Vault-Size': String(ciphertext.byteLength),
      'X-Vault-SHA256': sha256,
    },
    body: ciphertext,
  })
}

test('upload-file stages browser-hashed ciphertext to LFS without a git commit', async (t) => {
  const ciphertext = crypto.getRandomValues(new Uint8Array(8192))
  const sha256 = await sha256Hex(ciphertext)
  const state = { ciphertext, uploaded: null, verified: null, commitCalls: 0 }
  installUploadFetch(t, state)

  const response = await worker.fetch(uploadFileRequest(ciphertext, sha256), env)
  const receipt = await response.json()

  assert.equal(response.status, 200)
  assert.deepEqual(state.uploaded, ciphertext)
  assert.deepEqual(state.verified, { oid: sha256, size: ciphertext.byteLength })
  assert.equal(receipt.sha256, sha256)
  assert.equal(receipt.size, ciphertext.byteLength)
  assert.equal(state.commitCalls, 0)
})

test('upload-file rejects a ciphertext whose digest does not match the declared hash', async (t) => {
  const ciphertext = crypto.getRandomValues(new Uint8Array(4096))
  const wrong = 'f'.repeat(64)
  const state = { ciphertext, uploaded: null, verified: null, commitCalls: 0 }
  installUploadFetch(t, state)

  const response = await worker.fetch(uploadFileRequest(ciphertext, wrong), env)
  const body = await response.json()

  assert.equal(response.status, 400)
  assert.equal(body.code, 'DIGEST_MISMATCH')
  assert.equal(state.commitCalls, 0)
})

test('upload-file rejects a ciphertext whose length does not match the declared size', async (t) => {
  const ciphertext = crypto.getRandomValues(new Uint8Array(2048))
  const sha256 = await sha256Hex(ciphertext)
  const state = { ciphertext, uploaded: null, verified: null, commitCalls: 0 }
  installUploadFetch(t, state)

  const request = workerRequest('/upload-file?id=0123456789abcdef&commit=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Vault-Size': '1',
      'X-Vault-SHA256': sha256,
    },
    body: ciphertext,
  })
  const response = await worker.fetch(request, env)
  assert.equal(response.status, 400)
  assert.equal(state.commitCalls, 0)
})

test('media uploads must be staged with commit=false', async (t) => {
  installFetch(t, async () => { throw new Error('should not fetch') })

  const ciphertext = new Uint8Array([1, 2, 3])
  const sha256 = await sha256Hex(ciphertext)

  const implicitCommit = await worker.fetch(workerRequest('/upload-file?id=0123456789abcdef', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Vault-Size': String(ciphertext.byteLength),
      'X-Vault-SHA256': sha256,
    },
    body: ciphertext,
  }), env)
  assert.equal(implicitCommit.status, 400)
  assert.equal((await implicitCommit.json()).code, 'COMMIT_NOT_ALLOWED')

  const chunkCommit = await worker.fetch(workerRequest('/upload-chunk?id=0123456789abcdef&index=0', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Vault-Size': String(ciphertext.byteLength),
      'X-Vault-SHA256': sha256,
    },
    body: ciphertext,
  }), env)
  assert.equal(chunkCommit.status, 400)
  assert.equal((await chunkCommit.json()).code, 'COMMIT_NOT_ALLOWED')
})

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

test('GET /vault-head returns the current revision oid', async (t) => {
  installFetch(t, async (url) => {
    if (url.includes('/commits/main')) {
      return Response.json([{ id: 'f'.repeat(40) }])
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })

  const response = await worker.fetch(workerRequest('/vault-head'), env)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { oid: 'f'.repeat(40) })
})

test('GET /vault-head returns null for an empty repo', async (t) => {
  installFetch(t, async (url) => {
    if (url.includes('/commits/main')) return new Response('nope', { status: 404 })
    throw new Error(`Unexpected fetch: ${url}`)
  })
  const response = await worker.fetch(workerRequest('/vault-head'), env)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { oid: null })
})

test('GET reads accept ?revision=oid and reject malformed revisions', async (t) => {
  const requested = []
  installFetch(t, async (url) => {
    if (url.includes('/resolve/')) {
      requested.push(url)
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'application/octet-stream' } })
    }
    if (url.includes('/tree/')) {
      requested.push(url)
      return Response.json([])
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })

  const oid = 'd'.repeat(40)
  await worker.fetch(workerRequest(`/get-manifest?revision=${oid}`), env)
  await worker.fetch(workerRequest(`/get-bundle?revision=${oid}`), env)
  await worker.fetch(workerRequest(`/get-bundle-page/2?revision=${oid}`), env)
  await worker.fetch(workerRequest(`/get-file/0123456789abcdef?revision=${oid}`), env)
  await worker.fetch(workerRequest(`/get-chunk/0123456789abcdef/0?revision=${oid}`), env)
  await worker.fetch(workerRequest(`/list?revision=${oid}`), env)
  await worker.fetch(workerRequest('/get-manifest'), env)

  assert.ok(requested[0].includes(`/resolve/${oid}/manifest.enc`))
  assert.ok(!requested[0].includes('?t='))
  assert.ok(requested[1].includes(`/resolve/${oid}/thumbs.bundle`))
  assert.ok(requested[2].includes(`/resolve/${oid}/thumbs_page_2.bundle`))
  assert.ok(requested[3].includes(`/resolve/${oid}/files/0123456789abcdef.enc`))
  assert.ok(requested[4].includes(`/resolve/${oid}/files/0123456789abcdef_chunk_0.enc`))
  assert.ok(requested[5].includes(`/tree/${oid}/files`))
  assert.ok(requested[6].includes('/resolve/main/manifest.enc'))

  const bad = await worker.fetch(workerRequest('/get-manifest?revision=not-an-oid'), env)
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).code, 'INVALID_REVISION')
})

test('reads follow HF resolve redirects without leaking the HF token', async (t) => {
  const seen = []
  installFetch(t, async (url, init) => {
    seen.push({ url, authorization: init.headers?.Authorization ?? null })
    if (url.includes('/resolve/main/manifest.enc')) {
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://cdn.example/object?signature=abc' },
      })
    }
    if (url === 'https://cdn.example/object?signature=abc') {
      return new Response(new Uint8Array([9, 9]), {
        headers: { 'Content-Type': 'application/octet-stream' },
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })

  const response = await worker.fetch(workerRequest('/get-manifest'), env)
  assert.equal(response.status, 200)
  const hop = seen.find((entry) => entry.url.startsWith('https://cdn.example'))
  assert.ok(hop, 'redirect target was fetched')
  assert.equal(hop.authorization, null)
})

test('/list follows tree pagination via Link headers', async (t) => {
  const seen = []
  const repoPath = 'https://huggingface.co/api/datasets/test-user/test-repo/tree/main/files'
  installFetch(t, async (url) => {
    seen.push(url)
    if (url === `${repoPath}?limit=1000`) {
      return new Response(JSON.stringify([
        { path: 'files/0000000000000001.enc', type: 'file' },
      ]), {
        headers: {
          Link: `<${repoPath}?limit=1000&cursor=next>; rel="next"`,
        },
      })
    }
    if (url.includes('cursor=next')) {
      return Response.json([
        { path: 'files/0000000000000001_chunk_0.enc', type: 'file' },
        { path: 'files/0000000000000002.enc', type: 'file' },
      ])
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })

  const response = await worker.fetch(workerRequest('/list'), env)
  assert.equal(response.status, 200)
  const ids = await response.json()
  assert.deepEqual(new Set(ids), new Set(['0000000000000001', '0000000000000002']))
  assert.equal(seen.length, 2)
})

// ---------------------------------------------------------------------------
// delete-media
// ---------------------------------------------------------------------------

test('POST /delete-media targets exactly one layout per id and commits atomically', async (t) => {
  const commits = []
  installFetch(t, captureCommits(commits))

  const response = await worker.fetch(postJson('/delete-media', {
    parentCommit: PARENT,
    ids: [
      { id: '0000000000000001', chunk_count: 2 },
      { id: '0000000000000002' },
    ],
    manifestBytesBase64: 'AQ==',
  }), env)

  assert.equal(response.status, 200)
  assert.equal(commits.length, 1)
  const body = commits[0]
  assert.equal(parseHeader(body).parentCommit, PARENT)
  assert.equal(countNdjsonKey(body, 'file'), 1)
  const deletedPaths = body.split('\n')
    .map((line) => JSON.parse(line))
    .filter((line) => line.key === 'deletedFile')
    .map((line) => line.value.path)
  assert.deepEqual(new Set(deletedPaths), new Set([
    'files/0000000000000001_chunk_0.enc',
    'files/0000000000000001_chunk_1.enc',
    'files/0000000000000002.enc',
  ]))
  assert.ok(!deletedPaths.includes('files/0000000000000001.enc'))
  assert.equal(JSON.parse(body.split('\n').at(-1)).value.path, 'manifest.enc')
})

test('POST /delete-media requires parentCommit and validates ids', async (t) => {
  installFetch(t, async () => { throw new Error('should not fetch') })

  const missingParent = await worker.fetch(postJson('/delete-media', {
    ids: [{ id: '0000000000000001' }],
    manifestBytesBase64: 'AQ==',
  }), env)
  assert.equal(missingParent.status, 400)

  const badEntry = await worker.fetch(postJson('/delete-media', {
    parentCommit: PARENT,
    ids: [null],
    manifestBytesBase64: 'AQ==',
  }), env)
  assert.equal(badEntry.status, 400)

  const badChunkCount = await worker.fetch(postJson('/delete-media', {
    parentCommit: PARENT,
    ids: [{ id: '0000000000000001', chunk_count: 0 }],
    manifestBytesBase64: 'AQ==',
  }), env)
  assert.equal(badChunkCount.status, 400)

  const tooManyIds = await worker.fetch(postJson('/delete-media', {
    parentCommit: PARENT,
    ids: Array.from({ length: 501 }, (_, i) => ({ id: i.toString(16).padStart(16, '0') })),
    manifestBytesBase64: 'AQ==',
  }), env)
  assert.equal(tooManyIds.status, 413)
})

test('POST /delete-media dedupes repeated paths', async (t) => {
  const commits = []
  installFetch(t, captureCommits(commits))

  const response = await worker.fetch(postJson('/delete-media', {
    parentCommit: PARENT,
    ids: [
      { id: '0000000000000001' },
      { id: '0000000000000001' },
    ],
    manifestBytesBase64: 'AQ==',
  }), env)

  assert.equal(response.status, 200)
  assert.equal(countNdjsonKey(commits[0], 'deletedFile'), 1)
})

test('POST /delete-media surfaces CAS conflicts as 409 VAULT_STALE', async (t) => {
  let attempts = 0
  installFetch(t, async (url) => {
    if (url.includes('/commit/main')) {
      attempts += 1
      return new Response('conflict', { status: 409 })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })

  const response = await worker.fetch(postJson('/delete-media', {
    parentCommit: PARENT,
    ids: [{ id: '0000000000000001' }],
    manifestBytesBase64: 'AQ==',
  }), env)

  assert.equal(response.status, 409)
  assert.equal(attempts, 1)
  assert.equal((await response.json()).code, 'VAULT_STALE')
})

// ---------------------------------------------------------------------------
// initialize-vault
// ---------------------------------------------------------------------------

const SALT_BASE64 = 'AAAAAAAAAAAAAAAAAAAAAA=='
const HEAD = 'a'.repeat(40)

function installInitFetch(t, { head = HEAD, rootTree = [{ path: '.gitattributes', type: 'file' }] } = {}) {
  const commits = []
  installFetch(t, async (url, init) => {
    if (url.includes('/commits/main')) {
      return head ? Response.json([{ id: head }]) : new Response('nope', { status: 404 })
    }
    if (url.includes('/commit/main')) {
      commits.push(String(init.body))
      return Response.json({ commitOid: 'b'.repeat(40) })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }, { rootTree })
  return commits
}

test('/initialize-vault CASes from a freshly-read head and refuses stale parents', async (t) => {
  const commits = installInitFetch(t)

  const response = await worker.fetch(postJson('/initialize-vault', {
    saltBytesBase64: SALT_BASE64,
    manifestBytesBase64: 'AQ==',
    bundlePageBytesBase64: 'Ag==',
  }), env)

  assert.equal(response.status, 200)
  assert.equal(commits.length, 1)
  assert.equal(parseHeader(commits[0]).parentCommit, HEAD)

  const freshCommits = installInitFetch(t)
  const stale = await worker.fetch(postJson('/initialize-vault', {
    parentCommit: 'c'.repeat(40),
    saltBytesBase64: SALT_BASE64,
    manifestBytesBase64: 'AQ==',
    bundlePageBytesBase64: 'Ag==',
  }), env)
  assert.equal(stale.status, 409)
  assert.equal((await stale.json()).code, 'VAULT_STALE')
  assert.equal(freshCommits.length, 0)
})

test('/initialize-vault refuses an existing manifest in the pinned snapshot', async (t) => {
  const commits = installInitFetch(t, {
    rootTree: [{ path: '.gitattributes', type: 'file' }, { path: 'manifest.enc', type: 'file' }],
  })

  const response = await worker.fetch(postJson('/initialize-vault', {
    saltBytesBase64: SALT_BASE64,
    manifestBytesBase64: 'AQ==',
    bundlePageBytesBase64: 'Ag==',
  }), env)

  assert.equal(response.status, 409)
  assert.equal((await response.json()).code, 'VAULT_INITIALIZED')
  assert.equal(commits.length, 0)
})

test('/initialize-vault validates the salt length', async (t) => {
  installInitFetch(t)
  const response = await worker.fetch(postJson('/initialize-vault', {
    saltBytesBase64: 'AAAA',
    manifestBytesBase64: 'AQ==',
    bundlePageBytesBase64: 'Ag==',
  }), env)
  assert.equal(response.status, 400)
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFiles(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: index.toString(16).padStart(16, '0'),
    sha256: index.toString(16).padStart(64, '0'),
    size: 1024 + index,
  }))
}

function countNdjsonKey(value, key) {
  return value
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((line) => line.key === key)
    .length
}

function lastFileOp(value) {
  return value
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((line) => line.key === 'file')
    .at(-1)
}
