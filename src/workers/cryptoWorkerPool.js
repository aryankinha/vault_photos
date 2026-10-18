/**
 * Small FIFO pool of Vite module workers for large transferable media tasks.
 * A transferred ArrayBuffer is detached in the sender immediately, so tasks
 * are never retried with the same buffer after dispatch.
 */
import { encodeObjectContext } from '../crypto/v2/objects.js'
import { terminateKeyDerivations } from '../crypto/v2/argon2.js'

const POOL_SIZE = Math.min(
  typeof navigator === 'undefined' ? 1 : (navigator.hardwareConcurrency || 4),
  4,
)

let slots = []
let queue = []
let nextTaskId = 0
let terminated = false

function createWorkerSlot() {
  const worker = new Worker(new URL('./cryptoWorker.js', import.meta.url), {
    type: 'module',
  })
  const slot = { worker, busy: false, task: null }

  worker.onmessage = (event) => {
    const task = slot.task
    if (!task || event.data.taskId !== task.taskId) return

    slot.busy = false
    slot.task = null

    if (event.data.type === 'result') {
      task.resolve(event.data.result)
    } else {
      task.reject(new Error(event.data.message || 'Crypto worker task failed'))
    }
    pumpQueue()
  }

  worker.onerror = (event) => {
    const task = slot.task
    if (task) {
      task.reject(new Error(event.message || 'Crypto worker crashed'))
    }

    worker.terminate()
    slot.busy = false
    slot.task = null

    if (!terminated) {
      const index = slots.indexOf(slot)
      if (index !== -1) slots[index] = createWorkerSlot()
      pumpQueue()
    }
  }

  return slot
}

function ensurePool() {
  if (typeof Worker === 'undefined') return false
  if (slots.length > 0) return true

  terminated = false
  for (let index = 0; index < POOL_SIZE; index += 1) {
    slots.push(createWorkerSlot())
  }
  return true
}

function pumpQueue() {
  if (terminated) return

  for (const slot of slots) {
    if (slot.busy || queue.length === 0) continue
    const task = queue.shift()
    slot.busy = true
    slot.task = task

    const message = {
      operation: task.operation,
      taskId: task.taskId,
      buffer: task.buffer,
      key: task.key,
      ...task.options, // index / context / mediaType / filename
    }

    try {
      slot.worker.postMessage(message, [task.buffer])
    } catch (error) {
      slot.busy = false
      slot.task = null
      task.reject(error)
      queueMicrotask(pumpQueue)
    }
  }
}

function dispatch(operation, input, key, options = {}) {
  if (!ensurePool()) {
    return Promise.reject(new Error('Web Workers are unavailable'))
  }

  const buffer = ownArrayBuffer(input)
  const taskId = `crypto_${++nextTaskId}`

  return new Promise((resolve, reject) => {
    queue.push({ operation, taskId, buffer, key, options, resolve, reject })
    pumpQueue()
  })
}

export function isCryptoPoolSupported() {
  return typeof Worker !== 'undefined'
}

/** V2 dispatch selects only the context's purpose key; no master key crosses. */
export function encryptV2WithPool(buffer, purposeKeys, context) {
  encodeObjectContext(context)
  const key = purposeKeys[context.kind]
  if (key?.algorithm?.name !== 'AES-GCM' || key.extractable !== false) throw new Error('Invalid purpose key')
  return dispatch(context.kind === 'chunk' ? 'encryptV2Chunk' : 'encryptV2', buffer, key, { context })
}

export function decryptV2WithPool(buffer, purposeKeys, context) {
  encodeObjectContext(context)
  const key = purposeKeys[context.kind]
  if (key?.algorithm?.name !== 'AES-GCM' || key.extractable !== false) throw new Error('Invalid purpose key')
  return dispatch(context.kind === 'chunk' ? 'decryptV2Chunk' : 'decryptV2', buffer, key, { context })
}

/**
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {CryptoKey} key
 * @param {{ context?: {kind,id?,index?} }} [options] — optional crypto context
 */
export function encryptWithPool(buffer, key, options = {}) {
  return dispatch('encrypt', buffer, key, options)
}

/**
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {CryptoKey} key
 * @param {{ context?: {kind,id?,index?} }} [options] — optional crypto context
 */
export function decryptWithPool(buffer, key, options = {}) {
  return dispatch('decrypt', buffer, key, options)
}

/**
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {CryptoKey} key
 * @param {number} index
 * @param {{ context?: {kind,id?,index?} }} [options] — optional crypto context
 */
export function encryptChunkWithPool(buffer, key, index, options = {}) {
  return dispatch('encryptChunk', buffer, key, { ...options, index })
}

/**
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {CryptoKey} key
 * @param {number} index
 * @param {{ context?: {kind,id?,index?} }} [options] — optional crypto context
 */
export function decryptChunkWithPool(buffer, key, index, options = {}) {
  return dispatch('decryptChunk', buffer, key, { ...options, index })
}

export function thumbnailWithPool(buffer, mediaType, filename) {
  return dispatch('thumbnail', buffer, null, { mediaType, filename })
}

export function exifWithPool(buffer) {
  return dispatch('exif', buffer, null)
}

export function shutdownPool() {
  terminateKeyDerivations()
  terminated = true
  const error = new Error('Crypto worker pool terminated')

  for (const task of queue) task.reject(error)
  queue = []

  for (const slot of slots) {
    if (slot.task) slot.task.reject(error)
    slot.worker.terminate()
  }
  slots = []
}

export const cryptoPool = {
  terminate: shutdownPool,
  encrypt: encryptWithPool,
  decrypt: decryptWithPool,
  encryptChunk: encryptChunkWithPool,
  decryptChunk: decryptChunkWithPool,
  thumbnail: thumbnailWithPool,
  exif: exifWithPool,
}

function ownArrayBuffer(input) {
  if (input instanceof ArrayBuffer) return input
  if (ArrayBuffer.isView(input)) {
    return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
  }
  throw new TypeError('Worker tasks require an ArrayBuffer or typed array')
}
