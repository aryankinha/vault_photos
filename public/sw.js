/**
 * VaultPhotos service worker.
 *
 * 1. Performs a strictly bounded encrypted-upload recovery attempt.
 * 2. Exposes same-origin HTTP Range responses for chunked videos. The
 *    non-extractable CryptoKey is structured-cloned into service-worker RAM
 *    for the active viewer only and is discarded on cleanup/lock.
 */

const DB_NAME = 'vaultphotos-session'
const QUEUE_STORE = 'uploadQueue'
const MAX_BACKGROUND_ATTEMPTS = 2
const MAX_BACKGROUND_ITEMS_PER_SYNC = 3
const STREAM_PATH_PREFIX = '/__vault_stream__/'
const STREAM_SESSION_TTL_MS = 15 * 60 * 1000
const MAX_STREAM_CACHE_BYTES = 32 * 1024 * 1024 + 8 * 1024 * 1024
const MAX_CONCURRENT_STREAM_FETCHES = 2
const SHELL_CACHE_NAME = 'vaultphotos-shell-v2'

const uploadControllers = new Map()
const streamSessions = new Map()
if (typeof globalThis !== 'undefined') globalThis.streamSessions = streamSessions
const streamFetchWaiters = []
let streamFetchSlots = 0

self.addEventListener('install', (event) => {
  // Do not activate blindly: updates are promoted explicitly or through the
  // page's robust re-registration path so active encrypted streams can recover.
  event.waitUntil(Promise.resolve())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      if (typeof caches !== 'undefined') {
        const cacheNames = await caches.keys()
        await Promise.all(
          cacheNames
            .filter((name) => name.startsWith('vaultphotos-shell-') && name !== SHELL_CACHE_NAME)
            .map((name) => caches.delete(name)),
        )
      }
    } catch {
      // Cache cleanup is best-effort.
    }
    try {
      await self.clients.claim()
    } catch {
      // Claim is best-effort.
    }
    try {
      const clients = await self.clients.matchAll({ includeUncontrolled: true })
      for (const client of clients) {
        client?.postMessage({ type: 'vault-stream-expired', reason: 'service-worker-activated' })
      }
    } catch {
      // Notification is best-effort.
    }
  })())
})

self.addEventListener('sync', (event) => {
  if (event.tag === 'vault-upload-queue') {
    event.waitUntil(processUploadQueue())
  }
})

self.addEventListener('message', (event) => {
  const message = event.data || {}

  if (message.type === 'vault-sw-skip-waiting') {
    self.skipWaiting()
    return
  }

  if (message.type === 'vault-cancel-uploads') {
    for (const id of message.ids || []) uploadControllers.get(id)?.abort()
    return
  }

  if (message.type === 'vault-stream-register') {
    const port = event.ports?.[0]
    const clientId = event.source?.id || null
    try {
      if (!clientId) throw new Error('Missing stream owner')

      const existing = streamSessions.get(message.sessionId)
      if (existing && existing.clientId !== clientId) {
        throw new Error('Stream session is owned by another client')
      }
      if (existing) {
        cleanupStreamSession(message.sessionId)
      }

      const session = createStreamSession(message, clientId)
      session.timer = setTimeout(() => cleanupStreamSession(session.sessionId), STREAM_SESSION_TTL_MS)
  session.timer?.unref?.()
      streamSessions.set(message.sessionId, session)
      port?.postMessage({ ok: true })
    } catch {
      port?.postMessage({ ok: false, error: 'Unable to initialize encrypted video stream' })
    }
    return
  }

  if (message.type === 'vault-stream-remove') {
    const sessionId = message.sessionId
    const session = streamSessions.get(sessionId)
    if (!session) return
    if (!event.source?.id || event.source.id !== session.clientId) return
    cleanupStreamSession(sessionId)
    return
  }

  if (message.type === 'vault-stream-clear') {
    if (!event.source?.id) return
    for (const [sessionId, session] of [...streamSessions.entries()]) {
      if (session.clientId === event.source.id) {
        cleanupStreamSession(sessionId)
      }
    }
  }
})

self.addEventListener('fetch', (event) => {
  cleanupExpiredStreamSessions()

  let url
  try {
    url = new URL(event.request.url)
  } catch {
    return
  }

  // Only same-origin requests are handled by this worker.
  if (self.location?.origin && url.origin !== self.location.origin) return

  if (!url.pathname.startsWith(STREAM_PATH_PREFIX)) {
    if (event.request.method === 'GET') {
      event.respondWith(handleShellFetch(event.request))
    }
    return
  }

  const sessionId = safeDecodePathComponent(url.pathname.slice(STREAM_PATH_PREFIX.length))
  const session = streamSessions.get(sessionId)

  if (!session || isStreamSessionExpired(session)) {
    event.respondWith((async () => {
      if (session) cleanupStreamSession(sessionId)
      await notifyExpiredClient(event.clientId, sessionId)
      return new Response('Encrypted video stream expired', { status: 404 })
    })())
    return
  }

  if (session.clientId && event.clientId && event.clientId !== session.clientId) {
    event.respondWith(new Response('Forbidden', { status: 403 }))
    return
  }

  touchStreamSession(session)
  event.respondWith(handleStreamRequest(event.request, session))
})

async function processUploadQueue() {
  const workerUrl = await getWorkerUrl()
  if (!workerUrl) return
  // Owner codes are deliberately never persisted in IDB. Recovery in token
  // mode therefore runs explicitly in the foreground after connecting.
  try {
    const mode = await fetch(`${workerUrl}/auth-mode`, { credentials: 'include' }).then((response) => response.json())
    if (mode.mode === 'token') return
  } catch { return }

  const database = await openDB()
  const items = await getAllQueueItems(database)
  let processed = 0

  for (const snapshot of items) {
    if (processed >= MAX_BACKGROUND_ITEMS_PER_SYNC) break
    const item = await claimQueueAttempt(database, snapshot.id)
    if (!item) continue
    processed += 1

    const controller = new AbortController()
    uploadControllers.set(item.id, controller)
    try {
      const uploaded = await retryUpload(workerUrl, item, controller.signal)
      await markQueueItemUploaded(database, item.id, uploaded)
    } catch {
      // One Background Sync registration gets one bounded pass. The foreground
      // app presents explicit Resume/Discard controls instead of auto-looping.
    } finally {
      uploadControllers.delete(item.id)
    }
  }
}

async function retryUpload(workerUrl, item, signal) {
  const bytes = item.encryptedBytes instanceof Uint8Array
    ? item.encryptedBytes
    : new Uint8Array(item.encryptedBytes)
  const sha256 = item.sha256 || await sha256Hex(bytes)
  const response = await fetch(
    `${workerUrl}/upload-file?id=${encodeURIComponent(item.id)}&commit=false`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Vault-Size': String(bytes.byteLength),
        'X-Vault-SHA256': sha256,
      },
      body: bytes,
      signal,
      credentials: 'include',
    },
  )
  if (!response.ok) throw new Error(`Encrypted upload failed (${response.status})`)
  return response.json()
}

function createStreamSession(message, clientId) {
  const { sessionId, entry, key, workerUrl, mimeType } = message || {}
  if (!/^[0-9a-f-]{16,64}$/i.test(sessionId || '')) throw new Error('Invalid stream id')
  if (!entry || !/^[0-9a-f]{16}$/i.test(entry.id || '')) throw new Error('Invalid media id')
  if (!Number.isSafeInteger(entry.size) || entry.size <= 0) throw new Error('Invalid media size')
  if (!Number.isSafeInteger(entry.chunk_size) || entry.chunk_size <= 0) throw new Error('Invalid chunk size')
  if (entry.chunk_size > 32 * 1024 * 1024) throw new Error('Unsupported chunk size')
  if (!Number.isSafeInteger(entry.chunk_count) || entry.chunk_count <= 0) throw new Error('Invalid chunk count')
  if (entry.chunk_count !== Math.ceil(entry.size / entry.chunk_size)) throw new Error('Inconsistent chunk count')
  if (entry.crypto_version !== undefined && entry.crypto_version !== 1 && entry.crypto_version !== 2) {
    throw new Error('Unsupported crypto version')
  }
  if (entry.crypto_version === 2 && (
    !Array.isArray(entry.chunk_sha256) || entry.chunk_sha256.length !== entry.chunk_count ||
    !entry.chunk_sha256.every((hash) => typeof hash === 'string' && /^[0-9a-f]{64}$/i.test(hash))
  )) throw new Error('Missing authenticated chunk hashes')
  if (!key || key.type !== 'secret') throw new Error('Invalid stream key')
  if (!isValidWorkerUrl(workerUrl)) throw new Error('Invalid worker URL')

  const owner = typeof clientId === 'string' && clientId ? clientId : null

  return {
    sessionId,
    entry,
    key,
    workerUrl: workerUrl.replace(/\/$/, ''),
    ownerToken: typeof message.ownerToken === 'string' ? message.ownerToken : '',
    credentials: ['include', 'same-origin', 'omit'].includes(message.credentials) ? message.credentials : 'include',
    mimeType: mimeType || 'video/mp4',
    clientId: owner,
    cleaned: false,
    controller: new AbortController(),
    cache: new Map(),
    pending: new Map(),
    fetched: new Set(),
    createdAt: Date.now(),
    expiresAt: Date.now() + STREAM_SESSION_TTL_MS,
    timer: null,
  }
}

async function handleStreamRequest(request, session) {
  touchStreamSession(session)
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
  }

  const range = parseRange(request.headers.get('Range'), session.entry.size)
  if (!range) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${session.entry.size}` },
    })
  }

  const headers = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Type': session.mimeType,
    'Content-Length': String(range.end - range.start + 1),
  }
  if (range.partial) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${session.entry.size}`
  }

  if (request.method === 'HEAD') {
    return new Response(null, { status: range.partial ? 206 : 200, headers })
  }

  const body = createRangeBody(session, range.start, range.end)
  return new Response(body, { status: range.partial ? 206 : 200, headers })
}

function createRangeBody(session, start, end) {
  const firstChunk = Math.floor(start / session.entry.chunk_size)
  const lastChunk = Math.floor(end / session.entry.chunk_size)
  let nextChunk = firstChunk
  let cancelled = false

  return new ReadableStream({
    type: 'bytes',
    async pull(controller) {
      if (cancelled) return
      if (nextChunk > lastChunk) {
        controller.close()
        return
      }

      try {
        const index = nextChunk
        const chunk = await getDecryptedChunk(session, index)
        if (cancelled) return
        const chunkStart = index * session.entry.chunk_size
        const from = Math.max(0, start - chunkStart)
        const to = Math.min(chunk.byteLength, end - chunkStart + 1)
        nextChunk += 1
        if (to > from) controller.enqueue(chunk.slice(from, to))
        if (nextChunk > lastChunk) controller.close()
      } catch {
        notifyStreamClient(session, 'vault-stream-error', {
          error: 'Unable to download or authenticate this video chunk',
        })
        controller.error(new Error('Encrypted video range failed'))
      }
    },
    cancel() {
      cancelled = true
    },
  })
}

async function getDecryptedChunk(session, index) {
  if (index < 0 || index >= session.entry.chunk_count) {
    throw new RangeError('Chunk index is outside the media entry')
  }

  if (session.cache.has(index)) {
    const cached = session.cache.get(index)
    session.cache.delete(index)
    session.cache.set(index, cached)
    touchStreamSession(session)
    return cached.slice()
  }
  if (session.pending.has(index)) {
    const plaintext = await session.pending.get(index)
    return plaintext.slice()
  }

  const pending = (async () => {
    await acquireStreamFetchSlot(session)
    try {
      const response = await fetch(
        `${session.workerUrl}/get-chunk/${session.entry.id}/${index}`,
        { signal: session.controller.signal, credentials: session.credentials || 'include',
          headers: session.ownerToken ? { Authorization: `Bearer ${session.ownerToken}` } : {} },
      )
      if (!response.ok) throw new Error(`Chunk request failed (${response.status})`)
      const expectedSize = Math.min(session.entry.chunk_size, session.entry.size - index * session.entry.chunk_size)
      const encrypted = await readBoundedCiphertext(response, expectedSize + 32)
      validateEncryptedChunkLength(encrypted, session.entry.chunk_size)
      const expectedHash = session.entry.chunk_sha256?.[index]
      if (expectedHash && await sha256Hex(encrypted) !== expectedHash.toLowerCase()) {
        throw new Error('Ciphertext hash mismatch')
      }
      const decrypted = new Uint8Array(await decryptChunk(encrypted, session.key, index, session.entry))
      validateDecryptedChunkLength(decrypted, session.entry, index)

      if (!session.cleaned) {
        // Pending readers own `decrypted`; cache eviction must not zero their
        // shared promise result before its continuations copy the bytes.
        session.cache.set(index, decrypted.slice())
        trimStreamCache(session)
        session.fetched.add(index)
        notifyStreamClient(session, 'vault-stream-progress', {
          progress: session.fetched.size / session.entry.chunk_count,
        })
      } else {
        decrypted.fill(0)
        throw new Error('Stream session closed')
      }
      return decrypted
    } finally {
      releaseStreamFetchSlot()
    }
  })().finally(() => {
    session.pending.delete(index)
  })

  session.pending.set(index, pending)
  const plaintext = await pending
  return plaintext.slice()
}

async function readBoundedCiphertext(response, maximum) {
  const advertised = Number(response.headers.get('Content-Length'))
  if (advertised > maximum) {
    await response.body?.cancel()
    throw new Error('Encrypted chunk exceeds its declared media size')
  }
  if (!response.body) throw new Error('Missing encrypted chunk body')
  const reader = response.body.getReader()
  const bytes = new Uint8Array(maximum)
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return bytes.subarray(0, length)
      if (length + value.byteLength > maximum) {
        await reader.cancel()
        throw new Error('Encrypted chunk exceeds its declared media size')
      }
      bytes.set(value, length)
      length += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
}

async function decryptChunk(bytes, key, expectedIndex, entry) {
  if (bytes.byteLength <= 28) throw new Error('Encrypted chunk is too short')
  const storedIndex = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false)

  if (entry?.crypto_version === 2) {
    if (storedIndex !== expectedIndex || bytes.byteLength <= 32) throw new Error('Invalid context-bound chunk')
    return crypto.subtle.decrypt({
      name: 'AES-GCM', iv: bytes.slice(4, 16), tagLength: 128,
      additionalData: encodeChunkContext(entry.id, expectedIndex),
    }, key, bytes.slice(16))
  }
  if (entry?.crypto_version !== undefined && entry.crypto_version !== 1) throw new Error('Unsupported crypto version')

  if (storedIndex === expectedIndex) {
    try {
      return await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: bytes.slice(4, 16),
          tagLength: 128,
          additionalData: bytes.slice(0, 4),
        },
        key,
        bytes.slice(16),
      )
    } catch (currentError) {
      try {
        return await decryptLegacyChunk(bytes, key, expectedIndex)
      } catch {
        throw currentError
      }
    }
  }

  return decryptLegacyChunk(bytes, key, expectedIndex)
}

// Canonical VPC2 encoding shared with src/crypto/context.js. Kept inline because
// this classic service worker must remain compatible with existing installs.
function encodeChunkContext(id, index) {
  if (!/^[0-9a-f]{16}$/i.test(id) || !Number.isSafeInteger(index) || index < 0 || index > 0xffffffff) {
    throw new Error('Invalid chunk context')
  }
  const bytes = new Uint8Array(36)
  bytes.set(new TextEncoder().encode('VPC2'), 0)
  bytes[4] = 3
  bytes[5] = 5
  bytes.set(new TextEncoder().encode('chunk'), 6)
  bytes[11] = 16
  bytes.set(new TextEncoder().encode(id), 12)
  new DataView(bytes.buffer).setBigUint64(28, BigInt(index), false)
  return bytes
}

function decryptLegacyChunk(bytes, key, index) {
  return crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: bytes.slice(0, 12),
      tagLength: 128,
      additionalData: encodeIndex(index),
    },
    key,
    bytes.slice(12),
  )
}

function encodeIndex(index) {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, index, false)
  return bytes
}

function parseRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim())
  if (!match || (!match[1] && !match[2])) return null

  let start
  let end
  if (!match[1]) {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null
    start = Math.max(0, size - suffixLength)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : size - 1
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null
  if (start < 0 || start >= size || end < start) return null
  return { start, end: Math.min(end, size - 1), partial: true }
}

function trimStreamCache(session) {
  let totalBytes = 0
  for (const bytes of session.cache.values()) totalBytes += bytes.byteLength

  while (totalBytes > MAX_STREAM_CACHE_BYTES && session.cache.size > 0) {
    const oldestIndex = session.cache.keys().next().value
    const bytes = session.cache.get(oldestIndex)
    if (bytes) {
      bytes.fill(0)
      totalBytes -= bytes.byteLength
    }
    session.cache.delete(oldestIndex)
  }
}

function cleanupStreamSession(sessionId) {
  const session = streamSessions.get(sessionId)
  if (!session) return
  session.cleaned = true
  if (session.timer) clearTimeout(session.timer)
  session.controller.abort()
  for (let i = streamFetchWaiters.length - 1; i >= 0; i -= 1) {
    if (streamFetchWaiters[i].session === session) {
      streamFetchWaiters[i].reject(new Error('Stream session closed'))
      streamFetchWaiters.splice(i, 1)
    }
  }
  for (const bytes of session.cache.values()) bytes.fill(0)
  session.cache.clear()
  session.pending.clear()
  session.key = null
  session.ownerToken = ''
  streamSessions.delete(sessionId)
}

function isStreamSessionExpired(session) {
  if (!session) return true
  const now = Date.now()
  if (Number.isFinite(session.expiresAt)) return now >= session.expiresAt
  if (Number.isFinite(session.expires)) return now >= session.expires
  if (Number.isFinite(session.createdAt) && Number.isFinite(session.ttl)) {
    return now - session.createdAt >= session.ttl
  }
  return false
}

function cleanupExpiredStreamSessions() {
  for (const [sessionId, session] of [...streamSessions.entries()]) {
    if (isStreamSessionExpired(session)) cleanupStreamSession(sessionId)
  }
}

function touchStreamSession(session) {
  if (!session || session.cleaned) return
  if (session.timer) clearTimeout(session.timer)
  session.expiresAt = Date.now() + STREAM_SESSION_TTL_MS
  session.timer = setTimeout(() => cleanupStreamSession(session.sessionId), STREAM_SESSION_TTL_MS)
  session.timer?.unref?.()
}

async function notifyExpiredClient(clientId, sessionId) {
  if (!clientId) return
  try {
    const client = await self.clients.get(clientId)
    client?.postMessage({ type: 'vault-stream-expired', sessionId })
  } catch {
    // Best-effort notification.
  }
}

async function notifyStreamClient(session, type, detail) {
  if (!session.clientId) return
  try {
    const client = await self.clients.get(session.clientId)
    client?.postMessage({ type, sessionId: session.sessionId, ...detail })
  } catch {
    // Best-effort notification.
  }
}

function validateEncryptedChunkLength(bytes, chunkSize) {
  if (bytes.byteLength <= 28) throw new Error('Encrypted chunk is too short')
  if (bytes.byteLength > chunkSize + 64) throw new Error('Encrypted chunk is too large')
}

function validateDecryptedChunkLength(bytes, entry, index) {
  const expected = index === entry.chunk_count - 1
    ? entry.size - index * entry.chunk_size
    : entry.chunk_size
  if (!Number.isSafeInteger(expected) || expected <= 0 || expected > entry.chunk_size) {
    throw new Error('Invalid decrypted chunk length')
  }
  if (bytes.byteLength !== expected) {
    throw new Error(`Decrypted chunk length mismatch: expected ${expected}, got ${bytes.byteLength}`)
  }
}

function isValidWorkerUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  try {
    const url = new URL(value)
    if (url.username || url.password) return false
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    if (url.protocol === 'http:') {
      if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return false
    }
    return true
  } catch {
    return false
  }
}

function safeDecodePathComponent(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

async function handleShellFetch(request) {
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return fetch(request)
  if (url.pathname.startsWith(STREAM_PATH_PREFIX)) return fetch(request)
  if (request.headers.get('Range')) return fetch(request)
  const navigation = request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html'
  if (!navigation && !isShellAsset(url.pathname)) return fetch(request)

  let cache = null
  try {
    cache = await caches.open(SHELL_CACHE_NAME)
  } catch {
    // Keep cache unavailable.
  }

  // Hashed assets are immutable. HTML is not: cache-first HTML would pin users
  // to an obsolete client indefinitely after deploying a protocol/security fix.
  if (cache && !navigation) {
    try {
      const cached = await cache.match(request)
      if (cached) return cached
    } catch {
      // Ignore cache read failures.
    }
  }

  try {
    const response = await fetch(request)
    if (cache && response.ok && response.type === 'basic') {
      const cacheKey = navigation ? new URL('/index.html', self.location.origin).href : request
      await cache.put(cacheKey, response.clone()).catch(() => {})
    }
    return response
  } catch {
    if (cache && navigation) {
      try {
        const cached = await cache.match(new URL('/index.html', self.location.origin).href)
        if (cached) return cached
      } catch { /* Browser storage may be unavailable or evicted. */ }
    }
    // respondWith must always settle to a Response. On a fresh/evicted cache
    // an offline navigation cannot render the app; return a useful HTTP error
    // instead of rejecting the FetchEvent and showing a browser network error.
    return new Response('VaultPhotos cannot reach the server. Reconnect and reload this page.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  }
}

function isShellAsset(pathname) {
  return /^\/assets\/[^/]+-[a-zA-Z0-9_-]{6,}\.(js|css|wasm)$/.test(pathname)
}

async function acquireStreamFetchSlot(session) {
  if (session?.cleaned) throw new Error('Stream session closed')
  if (streamFetchSlots < MAX_CONCURRENT_STREAM_FETCHES) {
    streamFetchSlots += 1
    return
  }
  await new Promise((resolve, reject) => {
    streamFetchWaiters.push({ resolve, reject, session })
  })
  // releaseStreamFetchSlot transfers an existing permit to this waiter.
  if (session?.cleaned) {
    releaseStreamFetchSlot()
    throw new Error('Stream session closed')
  }
}

function releaseStreamFetchSlot() {
  const next = streamFetchWaiters.shift()
  if (next) next.resolve()
  else streamFetchSlots = Math.max(0, streamFetchSlots - 1)
}

async function getWorkerUrl() {
  try {
    const database = await openDB()
    return await idbRequest(database.transaction('kv', 'readonly').objectStore('kv').get('workerUrl'))
  } catch {
    return null
  }
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = self.indexedDB.open(DB_NAME)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onupgradeneeded = (event) => {
      const database = event.target.result
      if (!database.objectStoreNames.contains('kv')) database.createObjectStore('kv')
      if (!database.objectStoreNames.contains(QUEUE_STORE)) {
        database.createObjectStore(QUEUE_STORE, { keyPath: 'id' })
      }
    }
  })
}

function getAllQueueItems(database) {
  return idbRequest(database.transaction(QUEUE_STORE, 'readonly').objectStore(QUEUE_STORE).getAll())
}

function claimQueueAttempt(database, id) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(QUEUE_STORE, 'readwrite')
    const store = transaction.objectStore(QUEUE_STORE)
    const request = store.get(id)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const row = request.result
      if (!canClaimQueueAttempt(row)) {
        resolve(null)
        return
      }
      const claimed = { ...row, backgroundAttempts: (row.backgroundAttempts || 0) + 1 }
      const put = store.put(claimed)
      put.onsuccess = () => resolve(claimed)
      put.onerror = () => reject(put.error)
    }
  })
}

function canClaimQueueAttempt(row) {
  return Boolean(
    row &&
    !row.chunked &&
    row.encryptedBytes &&
    !row.uploaded?.sha256 &&
    (row.backgroundAttempts || 0) < MAX_BACKGROUND_ATTEMPTS,
  )
}

function markQueueItemUploaded(database, id, uploaded) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(QUEUE_STORE, 'readwrite')
    const store = transaction.objectStore(QUEUE_STORE)
    const request = store.get(id)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      if (!request.result) {
        resolve()
        return
      }
      const put = store.put({ ...request.result, uploaded })
      put.onsuccess = () => resolve()
      put.onerror = () => reject(put.error)
    }
  })
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
