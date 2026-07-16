export function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError()
}

export function isAbortError(error) {
  return error?.name === 'AbortError'
}

export function createAbortError() {
  return new DOMException('Upload cancelled', 'AbortError')
}

export function abortableDelay(milliseconds, signal) {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(createAbortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
