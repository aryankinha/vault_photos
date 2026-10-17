import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const { default: worker } = await import('../worker/index.js')

// The worker verifies a Cloudflare Access assertion unless the request is an
// explicit loopback development request, so these tests target 127.0.0.1 with
// ENVIRONMENT=development and keep the write Origin allow-list.
const ORIGIN = 'https://app.example'
const baseEnv = {
  HF_TOKEN: 'test-token',
  HF_REPO: 'test-user/test-repo',
  ALLOWED_ORIGIN: ORIGIN,
  ENVIRONMENT: 'development',
}

const ID = '0123456789abcdef'
const UPLOAD_HREF = 'https://storage.example/upload'
const VERIFY_HREF = 'https://storage.example/verify'
const MIB = 1 << 20
const FORTY_MIB = 40 * MIB

// ---------------------------------------------------------------------------
// Cloudflare stream primitives, shimmed for Node.
// ---------------------------------------------------------------------------

const shimUsage = { digest: 0, fixedLength: 0 }

/**
 * Stand-in for Cloudflare's `crypto.DigestStream`: a WritableStream that hashes
 * incrementally and exposes a `digest` promise, resolving on close and rejecting
 * on abort. No second copy of the payload is retained (only the running hash).
 */
class DigestStreamShim {
  constructor(algorithm) {
    assert.equal(algorithm, 'SHA-256')
    shimUsage.digest += 1
    const hash = createHash('sha256')
    this.digest = new Promise((resolve, reject) => {
      this._resolve = resolve
      this._reject = reject
    })
    this._writable = new WritableStream({
      write: (chunk) => { hash.update(chunk) },
      close: () => { this._resolve(hash.digest()) },
      abort: (reason) => { this._reject(reason || new Error('DigestStream aborted')) },
    })
  }

  getWriter() {
    return this._writable.getWriter()
  }
}

/**
 * Stand-in for Cloudflare's `FixedLengthStream`: enforces that exactly N bytes
 * are written and errors if the stream ends short or overflows.
 */
class FixedLengthStreamShim {
  constructor(expected) {
    shimUsage.fixedLength += 1
    this.expected = expected
    this.seen = 0
    this._transform = new TransformStream({
      transform: (chunk, controller) => {
        this.seen += chunk.byteLength
        if (this.seen > this.expected) {
          throw new Error('FixedLengthStream: too many bytes')
        }
        controller.enqueue(chunk)
      },
      flush: () => {
        if (this.seen !== this.expected) {
          throw new Error('FixedLengthStream: too few bytes')
        }
      },
    })
  }

  get readable() { return this._transform.readable }
  get writable() { return this._transform.writable }
}

function installNativeShims(t) {
  const hadDigest = Object.prototype.hasOwnProperty.call(globalThis.crypto, 'DigestStream')
  const previousDigest = globalThis.crypto.DigestStream
  const hadFixed = Object.prototype.hasOwnProperty.call(globalThis, 'FixedLengthStream')
  const previousFixed = globalThis.FixedLengthStream

  globalThis.crypto.DigestStream = DigestStreamShim
  globalThis.FixedLengthStream = FixedLengthStreamShim

  t.after(() => {
    if (hadDigest) globalThis.crypto.DigestStream = previousDigest
    else delete globalThis.crypto.DigestStream
    if (hadFixed) globalThis.FixedLengthStream = previousFixed
    else delete globalThis.FixedLengthStream
  })
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const unhandledRejections = []
globalThis.process.on('unhandledRejection', (reason) => { unhandledRejections.push(reason) })

async function assertNoUnhandledRejections() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(
    unhandledRejections.map((reason) => (reason && reason.message) || String(reason)),
    [],
  )
  unhandledRejections.length = 0
}

function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms)
    }),
  ])
}

/**
 * Fetch router: satisfies ensureGitAttributes (root tree + .gitattributes), the
 * LFS batch negotiation, and the storage PUT/verify. `putHandler(init)` receives
 * the `{ body, signal }` of the PUT.
 */
function installFetch(t, putHandler) {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    if (/\/tree\/[^/]+\/\?/.test(url)) {
      return Response.json([{ path: '.gitattributes', type: 'file' }])
    }
    if (url.includes('/resolve/main/.gitattributes')) {
      return new Response('files/** filter=lfs diff=lfs merge=lfs -text\nmanifest.enc filter=lfs diff=lfs merge=lfs -text\nsalt.bin filter=lfs diff=lfs merge=lfs -text\nthumbs*.bundle filter=lfs diff=lfs merge=lfs -text\n')
    }
    if (url.includes('/objects/batch')) {
      const requested = JSON.parse(String(init.body)).objects[0]
      return Response.json({
        objects: [{
          oid: requested.oid,
          size: requested.size,
          actions: {
            upload: { href: UPLOAD_HREF, header: {} },
            verify: { href: VERIFY_HREF, header: {} },
          },
        }],
      })
    }
    if (url === UPLOAD_HREF) return putHandler(init)
    if (url === VERIFY_HREF) return new Response(null, { status: 200 })
    throw new Error(`Unexpected fetch: ${url}`)
  }
}

function makeSource(totalBytes, state, chunkSize = MIB, fill = 7) {
  const chunk = new Uint8Array(Math.min(chunkSize, totalBytes)).fill(fill)
  let sent = 0
  return new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close()
        return
      }
      const remaining = totalBytes - sent
      const value = remaining >= chunk.byteLength ? chunk : chunk.subarray(0, remaining)
      sent += value.byteLength
      controller.enqueue(value)
    },
    cancel(reason) {
      state.cancelled = true
      state.reason = reason
    },
  })
}

function sha256OfRepeatedChunk(chunk, repeats) {
  const hash = createHash('sha256')
  for (let i = 0; i < repeats; i += 1) hash.update(chunk)
  return hash.digest('hex')
}

function uploadRequest({ body, size, sha256, signal }) {
  return new Request(`http://127.0.0.1:8787/upload-file?id=${ID}&commit=false`, {
    method: 'POST',
    duplex: 'half',
    headers: {
      Origin: ORIGIN,
      'Content-Type': 'application/octet-stream',
      'X-Vault-Size': String(size),
      'X-Vault-SHA256': sha256,
    },
    body,
    ...(signal ? { signal } : {}),
  })
}

async function consumeBody(body) {
  const reader = body.getReader()
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
  }
  return total
}

// ---------------------------------------------------------------------------
// Native path: integrity
// ---------------------------------------------------------------------------

test('native path streams and hashes a 40 MiB upload without the 16 MiB fallback cap', async (t) => {
  installNativeShims(t)
  const startedDigest = shimUsage.digest
  const startedFixed = shimUsage.fixedLength
  let consumed = 0
  let verifyCalls = 0

  installFetch(t, async (init) => {
    consumed = await consumeBody(init.body)
    return new Response(null, { status: 200 })
  })
  // Count verify calls without breaking the router.
  const nativeFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    if (String(input) === VERIFY_HREF) verifyCalls += 1
    return nativeFetch(input, init)
  }

  const chunk = new Uint8Array(MIB).fill(7)
  const oid = sha256OfRepeatedChunk(chunk, 40)
  const state = {}
  const body = makeSource(FORTY_MIB, state)

  const response = await withTimeout(
    worker.fetch(uploadRequest({ body, size: FORTY_MIB, sha256: oid }), baseEnv),
    15_000,
    '40 MiB native upload',
  )
  const receipt = await response.json()

  assert.equal(response.status, 200)
  assert.equal(receipt.sha256, oid)
  assert.equal(receipt.size, FORTY_MIB)
  assert.equal(consumed, FORTY_MIB, 'the whole 40 MiB reached storage')
  assert.equal(verifyCalls, 1)
  assert.equal(state.cancelled, undefined)
  // The native primitives were used (no bounded-buffer fallback).
  assert.equal(shimUsage.digest, startedDigest + 1)
  assert.equal(shimUsage.fixedLength, startedFixed + 1)
  await assertNoUnhandledRejections()
})

test('native path rejects a digest mismatch before returning a receipt', async (t) => {
  installNativeShims(t)
  let consumed = 0
  installFetch(t, async (init) => {
    consumed = await consumeBody(init.body)
    return new Response(null, { status: 200 })
  })

  const chunk = new Uint8Array(256 * 1024).fill(3)
  const body = makeSource(chunk.byteLength, {})
  const wrongOid = 'f'.repeat(64)

  const response = await withTimeout(
    worker.fetch(uploadRequest({ body, size: chunk.byteLength, sha256: wrongOid }), baseEnv),
    5_000,
    'digest mismatch',
  )
  const payload = await response.json()

  assert.equal(response.status, 400)
  assert.equal(payload.code, 'DIGEST_MISMATCH')
  assert.equal(consumed, chunk.byteLength, 'the byte stream was still fully consumed by the PUT')
  await assertNoUnhandledRejections()
})

// ---------------------------------------------------------------------------
// Native path: cancellation on failure
// ---------------------------------------------------------------------------

test('a PUT that fails without consuming the body returns promptly and cancels the source', async (t) => {
  installNativeShims(t)
  let putSawBody = false
  installFetch(t, async (init) => {
    // Deliberately ignore init.body: a real early error response that never
    // drains the request stream.
    putSawBody = init.body != null
    return new Response('nope', { status: 500 })
  })

  const state = {}
  const body = makeSource(FORTY_MIB, state)
  const oid = sha256OfRepeatedChunk(new Uint8Array(MIB).fill(7), 40)

  const startedAt = Date.now()
  const response = await withTimeout(
    worker.fetch(uploadRequest({ body, size: FORTY_MIB, sha256: oid }), baseEnv),
    5_000,
    'non-OK PUT',
  )
  const elapsed = Date.now() - startedAt
  const payload = await response.json()

  assert.equal(putSawBody, true)
  assert.equal(response.status, 502)
  assert.equal(payload.code, 'HF_STORAGE_FAILED')
  assert.ok(elapsed < 2_000, `settled promptly (${elapsed} ms) without awaiting a stalled pipe`)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(state.cancelled, true, 'source cancelled')
  await assertNoUnhandledRejections()
})

test('an early non-OK response (403) settles promptly with no unhandled rejection', async (t) => {
  installNativeShims(t)
  installFetch(t, async () => new Response('forbidden', { status: 403 }))

  const state = {}
  const body = makeSource(FORTY_MIB, state)
  const oid = sha256OfRepeatedChunk(new Uint8Array(MIB).fill(7), 40)

  const response = await withTimeout(
    worker.fetch(uploadRequest({ body, size: FORTY_MIB, sha256: oid }), baseEnv),
    5_000,
    'early non-OK',
  )

  assert.equal(response.status, 502)
  assert.equal((await response.json()).code, 'HF_STORAGE_FAILED')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(state.cancelled, true, 'source cancelled')
  await assertNoUnhandledRejections()
})

// ---------------------------------------------------------------------------
// Native path: external signal + timeout
// ---------------------------------------------------------------------------

test('request.signal aborts an in-flight PUT and cancels the source', async (t) => {
  installNativeShims(t)
  installFetch(t, ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))

  const state = {}
  const body = makeSource(FORTY_MIB, state)
  const oid = sha256OfRepeatedChunk(new Uint8Array(MIB).fill(7), 40)
  const controller = new AbortController()

  const pending = worker.fetch(
    uploadRequest({ body, size: FORTY_MIB, sha256: oid, signal: controller.signal }),
    baseEnv,
  )
  await new Promise((resolve) => setTimeout(resolve, 10))
  const startedAt = Date.now()
  controller.abort(new Error('client went away'))

  const response = await withTimeout(pending, 5_000, 'aborted upload')
  const elapsed = Date.now() - startedAt

  assert.equal(response.status, 502)
  assert.equal((await response.json()).code, 'LFS_UPLOAD_ABORTED')
  assert.ok(elapsed < 2_000, `aborted promptly (${elapsed} ms)`)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(state.cancelled, true, 'source cancelled')
  await assertNoUnhandledRejections()
})

test('two concurrent uploads both cancel cleanly when their signals fire', async (t) => {
  installNativeShims(t)
  installFetch(t, ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))

  const oid = sha256OfRepeatedChunk(new Uint8Array(MIB).fill(7), 40)
  const stateA = {}
  const stateB = {}
  const controllerA = new AbortController()
  const controllerB = new AbortController()

  const pendingA = worker.fetch(
    uploadRequest({ body: makeSource(FORTY_MIB, stateA), size: FORTY_MIB, sha256: oid, signal: controllerA.signal }),
    baseEnv,
  )
  const pendingB = worker.fetch(
    uploadRequest({ body: makeSource(FORTY_MIB, stateB), size: FORTY_MIB, sha256: oid, signal: controllerB.signal }),
    baseEnv,
  )

  await new Promise((resolve) => setTimeout(resolve, 10))
  controllerA.abort(new Error('a'))
  controllerB.abort(new Error('b'))

  const [responseA, responseB] = await withTimeout(
    Promise.all([pendingA, pendingB]),
    5_000,
    'concurrent cancellation',
  )

  assert.equal(responseA.status, 502)
  assert.equal(responseB.status, 502)
  assert.equal((await responseA.json()).code, 'LFS_UPLOAD_ABORTED')
  assert.equal((await responseB.json()).code, 'LFS_UPLOAD_ABORTED')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(stateA.cancelled, true)
  assert.equal(stateB.cancelled, true)
  await assertNoUnhandledRejections()
})

test('a bounded upload timeout aborts a stalled PUT with LFS_UPLOAD_TIMEOUT', async (t) => {
  installNativeShims(t)
  installFetch(t, ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))

  const state = {}
  const body = makeSource(FORTY_MIB, state)
  const oid = sha256OfRepeatedChunk(new Uint8Array(MIB).fill(7), 40)
  const env = { ...baseEnv, UPLOAD_TIMEOUT_MS: 40 }

  const startedAt = Date.now()
  const response = await withTimeout(
    worker.fetch(uploadRequest({ body, size: FORTY_MIB, sha256: oid }), env),
    5_000,
    'upload timeout',
  )
  const elapsed = Date.now() - startedAt

  assert.equal(response.status, 504)
  assert.equal((await response.json()).code, 'LFS_UPLOAD_TIMEOUT')
  assert.ok(elapsed >= 30, `honored the configured timeout (${elapsed} ms)`)
  assert.ok(elapsed < 2_000, `did not overshoot (${elapsed} ms)`)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(state.cancelled, true, 'source cancelled after timeout')
  await assertNoUnhandledRejections()
})
