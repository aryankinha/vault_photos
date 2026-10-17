window.runStreamIntegration = async () => {
  const registration = await navigator.serviceWorker.register('/sw.js', {
    scope: '/tests/browser/', updateViaCache: 'none',
  })
  await navigator.serviceWorker.ready
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve, reject) => {
      const change = () => { clearTimeout(timer); resolve() }
      const timer = setTimeout(() => {
        navigator.serviceWorker.removeEventListener('controllerchange', change)
        reject(new Error('Test service worker did not claim its page'))
      }, 5000)
      navigator.serviceWorker.addEventListener('controllerchange', change, { once: true })
    })
  }
  const controller = navigator.serviceWorker.controller
  const key = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(42), 'AES-GCM', false, ['decrypt'])
  const sessionId = crypto.randomUUID().replaceAll('-', '')
  const channel = new MessageChannel()
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Stream registration timed out')), 5000)
      channel.port1.onmessage = ({ data }) => {
        clearTimeout(timer)
        if (data.ok) resolve()
        else reject(new Error(data.error))
      }
      controller.postMessage({
        type: 'vault-stream-register', sessionId, key,
        entry: { id: '0123456789abcdef', size: 9, chunk_size: 8, chunk_count: 2 },
        workerUrl: `${location.origin}/__test_stream__`, mimeType: 'application/octet-stream',
      }, [channel.port2])
    })
    const url = `/__vault_stream__/${sessionId}`
    const probe = await fetch(url, { headers: { Range: 'bytes=0-1' } })
    const probeBytes = [...new Uint8Array(await probe.arrayBuffer())]
    const cross = await fetch(url, { headers: { Range: 'bytes=6-8' } })
    const crossBytes = [...new Uint8Array(await cross.arrayBuffer())]
    if (probe.status !== 206 || String(probeBytes) !== '0,1' || probe.headers.get('Content-Length') !== '2') {
      throw new Error('Safari-style byte probe was not served correctly')
    }
    if (cross.status !== 206 || String(crossBytes) !== '6,7,8' || cross.headers.get('Content-Range') !== 'bytes 6-8/9') {
      throw new Error('Cross-chunk legacy tail range was not served correctly')
    }
    return { passed: true, probeBytes, crossBytes, status: cross.status }
  } finally {
    channel.port1.close()
    controller.postMessage({ type: 'vault-stream-remove', sessionId })
    // This registration is scoped only to the local test harness pages.
    await registration.unregister()
  }
}
