import { unlockWithPassphrase, clearActiveKey } from '../../src/crypto/keyDerivation.js'
import { encryptPacked } from '../../src/crypto/encrypt.js'
import { encryptChunk } from '../../src/crypto/chunkEncrypt.js'
import { chunkContext } from '../../src/crypto/context.js'
import { sha256Hex } from '../../src/utils/hash.js'
import { loadFullMedia } from '../../src/services/viewerService.js'
import { prefetch, purgePrefetchCache, isPrefetched } from '../../src/hooks/usePrefetch.js'
import { deleteCachedFile } from '../../src/storage/opfsCache.js'
import { shutdownPool } from '../../src/workers/cryptoWorkerPool.js'

const output = document.querySelector('#result')
const originalFetch = window.fetch
const id = crypto.randomUUID().replaceAll('-', '').slice(0, 16)
const key = await unlockWithPassphrase('browser regression checks only', crypto.getRandomValues(new Uint8Array(16)))
const urls = []
try {
  const encrypted = await encryptPacked(new Uint8Array([1, 2, 3]), key)
  let networkReads = 0
  window.fetch = async () => { networkReads += 1; return new Response(encrypted.slice(0)) }
  const legacyUrl = await loadFullMedia({ id, name: 'test.jpg', type: 'image' }, 'image/jpeg')
  urls.push(legacyUrl)
  const legacyBytes = [...new Uint8Array(await originalFetch(legacyUrl).then((response) => response.arrayBuffer()))]
  if (networkReads !== 1 || String(legacyBytes) !== '1,2,3') throw new Error('Legacy cache miss failed')

  const chunks = await Promise.all([0, 1].map((index) => encryptChunk(Uint8Array.of(index + 4), key, index, { context: chunkContext(id, index) })))
  window.fetch = async (input) => new Response(chunks[Number(new URL(input).pathname.split('/').pop())].slice(0))
  const chunkedUrl = await loadFullMedia({ id, name: 'test.png', type: 'image', size: 2,
    chunked: true, chunk_count: 2, chunk_size: 1, crypto_version: 2,
    chunk_sha256: await Promise.all(chunks.map(sha256Hex)) }, 'image/png')
  urls.push(chunkedUrl)
  const chunkedBytes = [...new Uint8Array(await originalFetch(chunkedUrl).then((response) => response.arrayBuffer()))]
  if (String(chunkedBytes) !== '4,5') throw new Error('Context-bound chunk fallback failed')

  let pendingReads = 0
  window.fetch = async (input, options = {}) => new Promise((resolve, reject) => {
    pendingReads += 1
    options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  })
  const entries = Array.from({ length: 9 }, (_, index) => ({ id: String(index).padStart(16, '0'),
    name: 'hover.jpg', type: 'image', size: 3, crypto_version: 2, sha256: 'a'.repeat(64) }))
  const promises = entries.map(prefetch)
  if (pendingReads > 2) throw new Error('Prefetch concurrency exceeded')
  purgePrefetchCache()
  await Promise.all(promises)
  if (entries.some((entry) => isPrefetched(entry.id))) throw new Error('Prefetch survived lock')
  output.textContent = JSON.stringify({ passed: true, legacyBytes, chunkedBytes, hoverCount: entries.length, pendingReads }, null, 2)
} catch (error) {
  output.textContent = JSON.stringify({ passed: false, error: error.message }, null, 2)
} finally {
  window.fetch = originalFetch
  for (const url of urls) URL.revokeObjectURL(url)
  await deleteCachedFile(id)
  clearActiveKey()
  shutdownPool()
}
