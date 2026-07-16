import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'
import { encryptChunk } from '../src/crypto/chunkEncrypt.js'

const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8')
const listeners = new Map()
const context = vm.createContext({
  self: {
    addEventListener(type, listener) {
      listeners.set(type, listener)
    },
  },
  crypto: webcrypto,
  URL,
  Response,
  Request,
  ReadableStream,
  TextEncoder,
  TextDecoder,
  setTimeout,
  clearTimeout,
})
vm.runInContext(source, context, { filename: 'public/sw.js' })

test('service worker parses browser byte ranges without over-reading media', () => {
  const parseRange = context.parseRange
  assert.deepEqual({ ...parseRange(null, 1000) }, { start: 0, end: 999, partial: false })
  assert.deepEqual({ ...parseRange('bytes=100-199', 1000) }, { start: 100, end: 199, partial: true })
  assert.deepEqual({ ...parseRange('bytes=-50', 1000) }, { start: 950, end: 999, partial: true })
  assert.deepEqual({ ...parseRange('bytes=950-', 1000) }, { start: 950, end: 999, partial: true })
  assert.deepEqual({ ...parseRange('bytes=900-5000', 1000) }, { start: 900, end: 999, partial: true })
  assert.equal(parseRange('bytes=1000-', 1000), null)
  assert.equal(parseRange('bytes=0-1,4-5', 1000), null)
  assert.ok(listeners.has('fetch'))
  assert.ok(listeners.has('message'))
})

test('background recovery never reuploads a completed receipt or exceeds its cap', () => {
  const encryptedBytes = Uint8Array.of(1, 2, 3)
  assert.equal(context.canClaimQueueAttempt({ encryptedBytes, backgroundAttempts: 0 }), true)
  assert.equal(context.canClaimQueueAttempt({ encryptedBytes, backgroundAttempts: 2 }), false)
  assert.equal(context.canClaimQueueAttempt({
    encryptedBytes,
    backgroundAttempts: 1,
    uploaded: { sha256: 'a'.repeat(64) },
  }), false)
  assert.equal(context.canClaimQueueAttempt({
    encryptedBytes,
    backgroundAttempts: 0,
    chunked: true,
  }), false)
})

test('service-worker video path authenticates current indexed chunks', async () => {
  const key = await webcrypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  const plaintext = webcrypto.getRandomValues(new Uint8Array(4096))
  const encrypted = new Uint8Array(await encryptChunk(plaintext, key, 12))
  const decrypted = new Uint8Array(await context.decryptChunk(encrypted, key, 12))

  assert.deepEqual(decrypted, plaintext)
  await assert.rejects(() => context.decryptChunk(encrypted, key, 11))
})

test('service-worker range responses decrypt only the chunks covering the request', async () => {
  const key = await webcrypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  const first = Uint8Array.from({ length: 64 }, (_, index) => index)
  const second = Uint8Array.from({ length: 64 }, (_, index) => index + 64)
  const encrypted = [
    new Uint8Array(await encryptChunk(first, key, 0)),
    new Uint8Array(await encryptChunk(second, key, 1)),
  ]
  const fetched = []
  context.fetch = async (input) => {
    const index = Number(String(input).split('/').at(-1))
    fetched.push(index)
    return new Response(encrypted[index])
  }

  const session = {
    sessionId: 'stream-test',
    entry: {
      id: '0123456789abcdef',
      size: 128,
      chunk_size: 64,
      chunk_count: 2,
    },
    key,
    workerUrl: 'https://worker.example',
    mimeType: 'video/mp4',
    clientId: null,
    controller: new AbortController(),
    cache: new Map(),
    pending: new Map(),
    fetched: new Set(),
  }
  const request = new Request('https://app.example/__vault_stream__/stream-test', {
    headers: { Range: 'bytes=48-79' },
  })
  const response = await context.handleStreamRequest(request, session)

  assert.equal(response.status, 206)
  assert.equal(response.headers.get('Content-Range'), 'bytes 48-79/128')
  assert.equal(response.headers.get('Content-Length'), '32')
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), Uint8Array.from({ length: 32 }, (_, index) => index + 48))
  assert.deepEqual(fetched, [0, 1])
})
