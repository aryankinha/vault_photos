/**
 * Format-agnostic chunked video streaming.
 *
 * A same-origin virtual URL is handled by the service worker. Native video
 * Range requests are mapped to encrypted HF chunks, authenticated with
 * AES-GCM in service-worker RAM, and returned as 206 responses. This supports
 * ordinary MP4/MOV/WebM files without pretending raw file slices are MSE
 * segments and never assembles the whole video in window memory.
 */

import { getActiveKey } from '../crypto/keyDerivation'

const WORKER_URL = import.meta.env.VITE_WORKER_URL
const STREAM_PATH_PREFIX = '/__vault_stream__/'
const SERVICE_WORKER_READY_TIMEOUT_MS = 3000
const activeStreams = new Map()

export async function createVideoStream(entry, mimeType, callbacks = {}) {
  if (!isVideoRangeStreamingSupported()) return null

  const controller = await getServiceWorkerController()
  if (!controller) return null

  const sessionId = createSessionId()
  const url = `${window.location.origin}${STREAM_PATH_PREFIX}${sessionId}`
  const state = {
    sessionId,
    url,
    entry: {
      id: entry.id,
      size: entry.size,
      chunk_size: entry.chunk_size,
      chunk_count: entry.chunk_count,
      crypto_version: entry.crypto_version,
      chunk_sha256: entry.chunk_sha256,
    },
    mimeType,
    callbacks,
    cleaned: false,
    controller,
    registering: null,
    reRegisterPromise: null,
    lastProgress: -1,
  }

  const onMessage = (event) => {
    const message = event.data || {}
    if (message.sessionId && message.sessionId !== sessionId) return
    if (message.type === 'vault-stream-progress') {
      const percent = Math.round(message.progress * 100)
      if (Number.isFinite(percent) && percent !== state.lastProgress) {
        state.lastProgress = percent
        callbacks.onProgress?.(message.progress)
      }
    }
    if (message.type === 'vault-stream-error') {
      callbacks.onError?.(new Error(message.error || 'Encrypted video stream failed'))
    }
    if (message.type === 'vault-stream-expired') {
      requestReRegister(state).catch((error) => {
        callbacks.onError?.(error instanceof Error ? error : new Error(String(error)))
      })
    }
  }
  navigator.serviceWorker.addEventListener('message', onMessage)

  const cleanup = () => {
    if (state.cleaned) return
    state.cleaned = true
    navigator.serviceWorker.removeEventListener('message', onMessage)
    state.controller?.postMessage({
      type: 'vault-stream-remove',
      sessionId,
    })
    activeStreams.delete(sessionId)
  }
  state.cleanup = cleanup

  activeStreams.set(sessionId, state)

  try {
    await registerStream(state, controller)
  } catch (error) {
    cleanup()
    throw error
  }

  return { url, cleanup, sessionId }
}

// Kept under the existing export name so callers and old tests remain source
// compatible; the implementation now probes service-worker Range streaming.
export function isVideoRangeStreamingSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    Boolean(WORKER_URL)
  )
}

export const isMseSupported = isVideoRangeStreamingSupported

export function clearVideoStreams() {
  for (const state of [...activeStreams.values()]) {
    state.cleanup?.()
  }
  navigator.serviceWorker?.controller?.postMessage({ type: 'vault-stream-clear' })
}

async function registerStream(state, controller) {
  if (state.cleaned) return
  if (state.registering) {
    await state.registering
    if (state.cleaned || state.registeredController === controller) return
  }

  const promise = (async () => {
    state.controller = controller
    await postWithAck(controller, {
      type: 'vault-stream-register',
      sessionId: state.sessionId,
      entry: state.entry,
      mimeType: state.mimeType,
      workerUrl: WORKER_URL,
      credentials: ['include', 'same-origin', 'omit'].includes(import.meta.env.VITE_ACCESS_CREDENTIALS)
        ? import.meta.env.VITE_ACCESS_CREDENTIALS : 'include',
      key: getActiveKey(),
    })
    if (state.cleaned) {
      controller.postMessage({
        type: 'vault-stream-remove',
        sessionId: state.sessionId,
      })
      throw new Error('Stream session closed')
    }
    state.registeredController = controller
  })()

  state.registering = promise
  try {
    await promise
  } finally {
    state.registering = null
  }
}

function requestReRegister(state) {
  if (state.cleaned) return Promise.resolve()
  if (state.reRegisterPromise) return state.reRegisterPromise

  const promise = (async () => {
    const controller = await getServiceWorkerController()
    if (!controller) throw new Error('Service worker unavailable')
    await registerStream(state, controller)
  })().finally(() => {
    state.reRegisterPromise = null
  })

  state.reRegisterPromise = promise
  return promise
}

if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
  const promoteWaitingServiceWorker = (registration) => {
    if (registration?.waiting && activeStreams.size === 0) {
      registration.waiting.postMessage({ type: 'vault-sw-skip-waiting' })
    }
  }

  navigator.serviceWorker.ready
    .then((registration) => {
      promoteWaitingServiceWorker(registration)
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing
        if (!worker) return
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed') promoteWaitingServiceWorker(registration)
        })
      })
    })
    .catch(() => {})

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    for (const state of [...activeStreams.values()]) {
      if (state.cleaned) continue
      requestReRegister(state).catch((error) => {
        state.callbacks?.onError?.(error instanceof Error ? error : new Error(String(error)))
      })
    }
  })
}

async function getServiceWorkerController() {
  const registration = await Promise.race([
    navigator.serviceWorker.ready,
    delay(SERVICE_WORKER_READY_TIMEOUT_MS, null),
  ])
  if (!registration) return null
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      navigator.serviceWorker.removeEventListener('controllerchange', onChange)
      resolve(null)
    }, 3000)
    const onChange = () => {
      clearTimeout(timeout)
      navigator.serviceWorker.removeEventListener('controllerchange', onChange)
      resolve(navigator.serviceWorker.controller)
    }
    navigator.serviceWorker.addEventListener('controllerchange', onChange)
  })
}

function delay(milliseconds, value) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds, value))
}

function postWithAck(controller, message) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel()
    const timeout = setTimeout(() => {
      channel.port1.close()
      reject(new Error('Video stream worker did not respond'))
    }, 5000)

    channel.port1.onmessage = (event) => {
      clearTimeout(timeout)
      channel.port1.close()
      if (event.data?.ok) resolve()
      else reject(new Error(event.data?.error || 'Unable to initialize video stream'))
    }
    try {
      controller.postMessage(message, [channel.port2])
    } catch (error) {
      clearTimeout(timeout)
      channel.port1.close()
      channel.port2.close()
      reject(error)
    }
  })
}

function createSessionId() {
  return crypto.randomUUID().replace(/-/g, '')
}
