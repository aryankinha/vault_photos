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
const MAX_STREAM_CACHE_CHUNKS = 3
const STREAM_PATH_PREFIX = '/__vault_stream__/'

const uploadControllers = new Map()
const streamSessions = new Map()

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('sync', (event) => {
  if (event.tag === 'vault-upload-queue') {
    event.waitUntil(processUploadQueue())
  }
})

self.addEventListener('message', (event) => {
  const message = event.data || {}

  if (message.type === 'vault-cancel-uploads') {
    for (const id of message.ids || []) uploadControllers.get(id)?.abort()
    return
  }

  if (message.type === 'vault-stream-register') {
    const port = event.ports?.[0]
    try {
      const session = createStreamSession(message, event.source?.id)
      cleanupStreamSession(message.sessionId)
      streamSessions.set(message.sessionId, session)
      port?.postMessage({ ok: true })
    } catch {
      port?.postMessage({ ok: false, error: 'Unable to initialize encrypted video stream' })
    }
    return
  }

  if (message.type === 'vault-stream-remove') {
    cleanupStreamSession(message.sessionId)
    return
  }

  if (message.type === 'vault-stream-clear') {
    for (const sessionId of [...streamSessions.keys()]) cleanupStreamSession(sessionId)
  }
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (!url.pathname.startsWith(STREAM_PATH_PREFIX)) return

  const sessionId = url.pathname.slice(STREAM_PATH_PREFIX.length)
  const session = streamSessions.get(sessionId)
  event.respondWith(
    session
      ? handleStreamRequest(event.request, session)
      : new Response('Encrypted video stream expired', { status: 404 }),
  )
})

async function processUploadQueue() {
  const workerUrl = await getWorkerUrl()
  if (!workerUrl) return

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
    },
  )
  if (!response.ok) throw new Error(`Encrypted upload failed (${response.status})`)
  return response.json()
}

function createStreamSession(message, clientId) {
  const { sessionId, entry, key, workerUrl, mimeType } = message
  if (!/^[0-9a-f-]{16,64}$/i.test(sessionId || '')) throw new Error('Invalid stream id')
  if (!entry || !/^[0-9a-f]{16}$/i.test(entry.id || '')) throw new Error('Invalid media id')
  if (!Number.isSafeInteger(entry.size) || entry.size <= 0) throw new Error('Invalid media size')
  if (!Number.isSafeInteger(entry.chunk_size) || entry.chunk_size <= 0) throw new Error('Invalid chunk size')
  if (!Number.isSafeInteger(entry.chunk_count) || entry.chunk_count <= 0) throw new Error('Invalid chunk count')
  if (!key || key.type !== 'secret') throw new Error('Invalid stream key')
  if (!/^https?:\/\//.test(workerUrl || '')) throw new Error('Invalid worker URL')

  return {
    sessionId,
    entry,
    key,
    workerUrl: workerUrl.replace(/\/$/, ''),
    mimeType: mimeType || 'video/mp4',
    clientId,
    controller: new AbortController(),
    cache: new Map(),
    pending: new Map(),
    fetched: new Set(),
  }
}

async function handleStreamRequest(request, session) {
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
    return cached
  }
  if (session.pending.has(index)) return session.pending.get(index)

  const pending = (async () => {
    const response = await fetch(
      `${session.workerUrl}/get-chunk/${session.entry.id}/${index}`,
      { signal: session.controller.signal },
    )
    if (!response.ok) throw new Error(`Chunk request failed (${response.status})`)
    const encrypted = new Uint8Array(await response.arrayBuffer())
    const plaintext = new Uint8Array(await decryptChunk(encrypted, session.key, index))
    session.cache.set(index, plaintext)
    trimStreamCache(session)
    session.fetched.add(index)
    notifyStreamClient(session, 'vault-stream-progress', {
      progress: session.fetched.size / session.entry.chunk_count,
    })
    return plaintext
  })().finally(() => {
    session.pending.delete(index)
  })

  session.pending.set(index, pending)
  return pending
}

async function decryptChunk(bytes, key, expectedIndex) {
  if (bytes.byteLength <= 32) throw new Error('Encrypted chunk is too short')
  const storedIndex = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false)

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
  while (session.cache.size > MAX_STREAM_CACHE_CHUNKS) {
    const oldestIndex = session.cache.keys().next().value
    const bytes = session.cache.get(oldestIndex)
    bytes?.fill(0)
    session.cache.delete(oldestIndex)
  }
}

function cleanupStreamSession(sessionId) {
  const session = streamSessions.get(sessionId)
  if (!session) return
  session.controller.abort()
  for (const bytes of session.cache.values()) bytes.fill(0)
  session.cache.clear()
  session.pending.clear()
  session.key = null
  streamSessions.delete(sessionId)
}

async function notifyStreamClient(session, type, detail) {
  if (!session.clientId) return
  const client = await self.clients.get(session.clientId)
  client?.postMessage({ type, sessionId: session.sessionId, ...detail })
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
