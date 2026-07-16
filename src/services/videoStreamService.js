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
  let cleaned = false

  const onMessage = (event) => {
    const message = event.data || {}
    if (message.sessionId !== sessionId) return
    if (message.type === 'vault-stream-progress') {
      callbacks.onProgress?.(message.progress)
    }
    if (message.type === 'vault-stream-error') {
      callbacks.onError?.(new Error(message.error || 'Encrypted video stream failed'))
    }
  }
  navigator.serviceWorker.addEventListener('message', onMessage)

  try {
    await postWithAck(controller, {
      type: 'vault-stream-register',
      sessionId,
      entry: {
        id: entry.id,
        size: entry.size,
        chunk_size: entry.chunk_size,
        chunk_count: entry.chunk_count,
      },
      mimeType,
      workerUrl: WORKER_URL,
      key: getActiveKey(),
    })
  } catch (error) {
    navigator.serviceWorker.removeEventListener('message', onMessage)
    throw error
  }

  function cleanup() {
    if (cleaned) return
    cleaned = true
    navigator.serviceWorker.removeEventListener('message', onMessage)
    navigator.serviceWorker.controller?.postMessage({
      type: 'vault-stream-remove',
      sessionId,
    })
    activeStreams.delete(sessionId)
  }

  activeStreams.set(sessionId, cleanup)
  return { url, cleanup }
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
  for (const cleanup of [...activeStreams.values()]) cleanup()
  navigator.serviceWorker?.controller?.postMessage({ type: 'vault-stream-clear' })
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
    controller.postMessage(message, [channel.port2])
  })
}

function createSessionId() {
  return crypto.randomUUID().replace(/-/g, '')
}
