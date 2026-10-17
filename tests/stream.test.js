import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'
import { encryptChunk } from '../src/crypto/chunkEncrypt.js'

const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8')

function createContext() {
  const listeners = new Map()
  const context = vm.createContext({
    self: {
      location: { origin: 'https://app.example' },
      addEventListener(type, listener) {
        listeners.set(type, listener)
      },
      clients: {
        async get() {
          return null
        },
        async matchAll() {
          return []
        },
        claim() {},
      },
      indexedDB: undefined,
      skipWaiting() {},
    },
    crypto: webcrypto,
    URL,
    Response,
    Request,
    AbortController,
    ReadableStream,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    caches: undefined,
  })
  vm.runInContext(source, context, { filename: 'public/sw.js' })
  context.__listeners = listeners
  return context
}

test('stream session expiry is enforced', () => {
  const context = createContext()
  const session = {
    sessionId: 'expired-test',
    expiresAt: Date.now() - 1000,
  }
  assert.equal(context.isStreamSessionExpired(session), true)

  const fresh = {
    sessionId: 'fresh-test',
    expiresAt: Date.now() + 1000,
  }
  assert.equal(context.isStreamSessionExpired(fresh), false)
})

test('oversized ciphertext is rejected during download, not after buffering it', async () => {
  const context = createContext()
  let cancelled = false
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(100)); },
    cancel() { cancelled = true },
  })
  await assert.rejects(context.readBoundedCiphertext(new Response(body), 64))
  assert.equal(cancelled, true)
  const bytes = await context.readBoundedCiphertext(new Response(Uint8Array.of(1, 2)), 64)
  assert.deepEqual([...bytes], [1, 2])
})

test('legacy video tails shorter than five bytes remain decryptable', async () => {
  const context = createContext()
  const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const nonce = webcrypto.getRandomValues(new Uint8Array(12))
  const aad = new Uint8Array(4)
  new DataView(aad.buffer).setUint32(0, 7)
  const cipher = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, Uint8Array.of(42))
  const packed = new Uint8Array(12 + cipher.byteLength)
  packed.set(nonce)
  packed.set(new Uint8Array(cipher), 12)
  assert.deepEqual([...new Uint8Array(await context.decryptChunk(packed, key, 7))], [42])
})

test('context-bound (v2) chunks decrypt with canonical id+index AAD and reject swaps', async () => {
  const context = createContext()
  const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const id = '0123456789abcdef'
  const index = 3
  const nonce = webcrypto.getRandomValues(new Uint8Array(12))
  const cipher = await webcrypto.subtle.encrypt({
    name: 'AES-GCM',
    iv: nonce,
    additionalData: context.encodeChunkContext(id, index),
  }, key, Uint8Array.of(9, 8, 7))
  const packed = new Uint8Array(16 + cipher.byteLength)
  new DataView(packed.buffer).setUint32(0, index, false)
  packed.set(nonce, 4)
  packed.set(new Uint8Array(cipher), 16)

  const plain = new Uint8Array(await context.decryptChunk(packed, key, index, { id, crypto_version: 2 }))
  assert.deepEqual([...plain], [9, 8, 7])

  // A chunk swapped in from another file (or another index) must fail — the
  // whole point of context binding — and must NOT fall back to legacy AAD.
  await assert.rejects(
    context.decryptChunk(packed, key, index, { id: 'fedcba9876543210', crypto_version: 2 }),
  )
  await assert.rejects(
    context.decryptChunk(packed, key, index + 1, { id, crypto_version: 2 }),
  )
})

test('stream fetch permits cannot be stolen between waking and resuming a waiter', async () => {
  const context = createContext()
  await context.acquireStreamFetchSlot({})
  await context.acquireStreamFetchSlot({})
  const first = context.acquireStreamFetchSlot({})
  context.releaseStreamFetchSlot()
  let secondEntered = false
  const second = context.acquireStreamFetchSlot({}).then(() => { secondEntered = true })
  await first
  assert.equal(secondEntered, false)
  context.releaseStreamFetchSlot()
  await second
  context.releaseStreamFetchSlot()
  context.releaseStreamFetchSlot()
  assert.equal(vm.runInContext('streamFetchSlots', context), 0)
})

test('shell HTML is network-first; only immutable hashed assets are cache-first', async () => {
  const context = createContext()
  let reads = 0
  const cache = {
    async match() { reads += 1; return new Response('old shell') },
    async put() {},
  }
  context.caches = { async open() { return cache } }
  context.fetch = async () => new Response('new shell')
  const request = new Request('https://app.example/')
  assert.equal(await (await context.handleShellFetch(request)).text(), 'new shell')
  assert.equal(reads, 0)
  context.fetch = async () => { throw new Error('offline') }
  assert.equal(await (await context.handleShellFetch(request)).text(), 'old shell')
  assert.equal(context.isShellAsset('/assets/main-abcdef12.js'), true)
  assert.equal(context.isShellAsset('/assets/private-photo.enc'), false)
})

test('stream fetch ownership rejects a different client', async () => {
  const context = createContext()
  const session = {
    sessionId: 'owned-session',
    entry: { id: '0123456789abcdef', size: 128, chunk_size: 64, chunk_count: 2 },
    clientId: 'owner-client',
    cache: new Map(),
    pending: new Map(),
    fetched: new Set(),
    controller: new AbortController(),
    expiresAt: Date.now() + 60000,
  }
  context.streamSessions.set(session.sessionId, session)

  const listeners = context.__listeners
  const fetchListener = listeners.get('fetch')
  const messages = []
  context.self.clients.get = async (id) => ({
    postMessage(message) {
      messages.push({ clientId: id, message })
    },
  })

  const event = {
    request: new Request('https://app.example/__vault_stream__/owned-session', {
      headers: { Range: 'bytes=0-1' },
    }),
    clientId: 'other-client',
    respondWith(response) {
      event.response = response
    },
  }
  fetchListener(event)
  const response = await event.response
  assert.equal(response.status, 403)
})

test('expired stream fetch notifies the requesting client', async () => {
  const context = createContext()
  const listeners = context.__listeners
  const fetchListener = listeners.get('fetch')
  const messages = []
  context.self.clients.get = async (id) => ({
    postMessage(message) {
      messages.push({ clientId: id, message })
    },
  })

  const event = {
    request: new Request('https://app.example/__vault_stream__/missing-session', {
      headers: { Range: 'bytes=0-1' },
    }),
    clientId: 'requesting-client',
    respondWith(response) {
      event.response = response
    },
  }
  fetchListener(event)
  const response = await event.response
  assert.equal(response.status, 404)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].clientId, 'requesting-client')
  assert.equal(messages[0].message.type, 'vault-stream-expired')
})

test('decrypted chunk length validation rejects mismatched plaintext', () => {
  const context = createContext()
  const entry = { chunk_count: 2, chunk_size: 64, size: 128 }
  assert.throws(() => {
    context.validateDecryptedChunkLength(new Uint8Array(63), entry, 0)
  })
  assert.doesNotThrow(() => {
    context.validateDecryptedChunkLength(new Uint8Array(64), entry, 0)
  })
  assert.doesNotThrow(() => {
    context.validateDecryptedChunkLength(new Uint8Array(64), entry, 1)
  })
})

test('origin filter ignores cross-origin fetch events', () => {
  const context = createContext()
  const listeners = context.__listeners
  const fetchListener = listeners.get('fetch')
  let responded = false
  const event = {
    request: new Request('https://evil.example/__vault_stream__/x'),
    clientId: 'client',
    respondWith() {
      responded = true
    },
  }
  fetchListener(event)
  assert.equal(responded, false)
})

test('source-less stream registration is rejected', () => {
  const context = createContext()
  const listeners = context.__listeners
  const messageListener = listeners.get('message')
  let result
  messageListener({
    data: {
      type: 'vault-stream-register',
      sessionId: 'sourceless-session',
      entry: { id: '0123456789abcdef', size: 64, chunk_size: 64, chunk_count: 1 },
      workerUrl: 'https://worker.example',
      key: { type: 'secret' },
    },
    ports: [{ postMessage(message) { result = message } }],
  })
  assert.equal(result.ok, false)
})

test('source-less stream removal and clear are ignored', () => {
  const context = createContext()
  const listeners = context.__listeners
  const messageListener = listeners.get('message')
  const session = {
    sessionId: 'owned-session',
    clientId: 'owner',
    cleaned: false,
    expiresAt: Date.now() + 60000,
  }
  context.streamSessions.set(session.sessionId, session)

  messageListener({
    data: { type: 'vault-stream-remove', sessionId: session.sessionId },
  })
  assert.ok(context.streamSessions.has(session.sessionId))

  messageListener({
    data: { type: 'vault-stream-clear' },
  })
  assert.ok(context.streamSessions.has(session.sessionId))
})

test('same session id cannot be taken over by another client', () => {
  const context = createContext()
  const listeners = context.__listeners
  const messageListener = listeners.get('message')
  const session = {
    sessionId: 'taken-session',
    clientId: 'owner',
    cleaned: false,
    expiresAt: Date.now() + 60000,
    timer: null,
    controller: new AbortController(),
    cache: new Map(),
    pending: new Map(),
    fetched: new Set(),
    entry: { id: '0123456789abcdef', size: 64, chunk_size: 64, chunk_count: 1 },
    workerUrl: 'https://worker.example',
    mimeType: 'video/mp4',
    key: { type: 'secret' },
  }
  context.streamSessions.set(session.sessionId, session)

  let result
  messageListener({
    source: { id: 'other-client' },
    data: {
      type: 'vault-stream-register',
      sessionId: session.sessionId,
      entry: session.entry,
      workerUrl: 'https://worker.example',
      key: { type: 'secret' },
    },
    ports: [{ postMessage(message) { result = message } }],
  })
  assert.equal(result.ok, false)
  assert.equal(context.streamSessions.get(session.sessionId).clientId, 'owner')
})

test('active stream use extends expiry', () => {
  const context = createContext()
  const session = {
    sessionId: 'touch-session',
    entry: { id: '0123456789abcdef', size: 64, chunk_size: 64, chunk_count: 1 },
    clientId: null,
    cleaned: false,
    controller: new AbortController(),
    cache: new Map(),
    pending: new Map(),
    fetched: new Set(),
    expiresAt: Date.now() - 1000,
    timer: null,
  }
  const request = new Request('https://app.example/__vault_stream__/touch-session', {
    headers: { Range: 'bytes=0-63' },
  })
  context.touchStreamSession(session)
  assert.ok(session.expiresAt > Date.now())
  context.handleStreamRequest(request, session)
  assert.ok(session.expiresAt > Date.now())
})

test('cache hit is marked most recently used', async () => {
  const context = createContext()
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const plaintext = Uint8Array.from({ length: 64 }, (_, index) => index)
  const encrypted = new Uint8Array(await encryptChunk(plaintext, key, 0))
  context.fetch = async () => new Response(encrypted)

  const session = {
    sessionId: 'lru-session',
    entry: { id: '0123456789abcdef', size: 64, chunk_size: 64, chunk_count: 1 },
    key,
    workerUrl: 'https://worker.example',
    clientId: null,
    cleaned: false,
    controller: new AbortController(),
    cache: new Map(),
    pending: new Map(),
    fetched: new Set(),
    expiresAt: Date.now() + 60000,
    timer: null,
  }

  const first = await context.getDecryptedChunk(session, 0)
  assert.deepEqual(Array.from(first), Array.from(plaintext))
  assert.deepEqual([...session.cache.keys()], [0])

  const second = await context.getDecryptedChunk(session, 0)
  assert.deepEqual(Array.from(second), Array.from(plaintext))
  assert.deepEqual([...session.cache.keys()], [0])
})

test('cleanup wakes blocked fetch waiters', async () => {
  const context = createContext()
  const holderA = { cleaned: false, sessionId: 'holder-a', controller: new AbortController(), cache: new Map(), pending: new Map(), fetched: new Set() }
  const holderB = { cleaned: false, sessionId: 'holder-b', controller: new AbortController(), cache: new Map(), pending: new Map(), fetched: new Set() }
  await context.acquireStreamFetchSlot(holderA)
  await context.acquireStreamFetchSlot(holderB)

  const session = {
    sessionId: 'waiter-session',
    cleaned: false,
    controller: new AbortController(),
    cache: new Map(),
    pending: new Map(),
    fetched: new Set(),
  }
  context.streamSessions.set(session.sessionId, session)

  const pending = context.acquireStreamFetchSlot(session)
  context.cleanupStreamSession(session.sessionId)
  await assert.rejects(pending)

  context.releaseStreamFetchSlot()
  context.releaseStreamFetchSlot()
})

test('owner-code stream authentication is sent only to the Worker and cleared on cleanup', async () => {
  const context = createContext()
  const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const encrypted = await encryptChunk(Uint8Array.of(42), key, 0)
  let authorization
  context.fetch = async (url, options) => {
    assert.equal(url, 'https://worker.example/get-chunk/0123456789abcdef/0')
    authorization = options.headers.Authorization
    return new Response(encrypted)
  }
  const session = context.createStreamSession({
    sessionId: 'a'.repeat(32), key, ownerToken: 'owner-test-code',
    workerUrl: 'https://worker.example', entry: {
      id: '0123456789abcdef', size: 1, chunk_size: 8, chunk_count: 1,
    },
  }, 'client-1')
  context.streamSessions.set(session.sessionId, session)
  assert.deepEqual([...await context.getDecryptedChunk(session, 0)], [42])
  assert.equal(authorization, 'Bearer owner-test-code')
  context.cleanupStreamSession(session.sessionId)
  assert.equal(session.ownerToken, '')
  assert.equal(session.key, null)
})
