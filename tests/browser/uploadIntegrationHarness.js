import { uploadMediaBatch } from '../../src/services/uploadService.js'
import { unlockWithPassphrase, clearActiveKey } from '../../src/crypto/keyDerivation.js'
import { encryptPacked } from '../../src/crypto/encrypt.js'
import { decryptPacked } from '../../src/crypto/decrypt.js'
import { encodeManifest, parseManifestBytes } from '../../src/storage/manifestCodec.js'
import { createEmptyManifest } from '../../src/schema/manifestSchema.js'
import { createEmptyBundle } from '../../src/schema/bundleSchema.js'
import { getUploadQueue, dequeueUpload, deleteCachedThumb } from '../../src/session/cache.js'
import { shutdownPool } from '../../src/workers/cryptoWorkerPool.js'

async function recordTinyVideo() {
  if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder unavailable in this browser')
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 32
  const ctx = canvas.getContext('2d')
  const stream = canvas.captureStream(15)
  const mimeType = ['video/webm;codecs=vp8', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type))
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  const parts = []
  recorder.ondataavailable = (event) => { if (event.data.size > 0) parts.push(event.data) }
  const stopped = new Promise((resolve) => { recorder.onstop = resolve })
  recorder.start()
  for (let index = 0; index < 8; index += 1) {
    ctx.fillStyle = `hsl(${index * 40} 80% 50%)`
    ctx.fillRect(0, 0, 32, 32)
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  recorder.stop()
  await stopped
  for (const track of stream.getTracks()) track.stop()
  return new Blob(parts, { type: 'video/webm' })
}

function base64ToBytes(base64) {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
}

// Isolated in-memory storage double: no request reaches the deployed Worker/HF.
window.runUploadIntegration = async () => {
  const originalFetch = window.fetch
  const OriginalXHR = window.XMLHttpRequest
  const before = new Set((await getUploadQueue()).map((row) => row.id))
  const ids = new Set()
  const key = await unlockWithPassphrase('integration test only passphrase', new Uint8Array(16))
  const manifest = createEmptyManifest()
  manifest.bundle_pages = 1
  const manifestBytes = await encryptPacked(await encodeManifest(manifest), key)
  const pageBytes = await encryptPacked(createEmptyBundle(), key)
  const commits = []
  const oid = 'a'.repeat(40)
  window.fetch = async (input, options = {}) => {
    const url = new URL(String(input), location.origin)
    if (url.pathname === '/vault-head') return Response.json({ oid })
    if (url.pathname === '/get-manifest') return new Response(manifestBytes.slice(0))
    if (url.pathname === '/get-bundle-page/0') return new Response(pageBytes.slice(0))
    if (url.pathname === '/commit-batch') {
      commits.push(JSON.parse(options.body))
      return Response.json({ ok: true, oid: 'b'.repeat(40) })
    }
    throw new Error(`Unexpected test fetch ${url.pathname}`)
  }
  window.XMLHttpRequest = class {
    upload = {}
    headers = {}
    open(method, url) { this.url = new URL(url, location.origin) }
    setRequestHeader(name, value) { this.headers[name] = value }
    getResponseHeader() { return null }
    abort() { this.onabort?.() }
    async send(body) {
      try {
        const id = this.url.searchParams.get('id')
        const index = this.url.searchParams.get('index')
        ids.add(id)
        this.upload.onprogress?.({ loaded: body.byteLength, total: body.byteLength, lengthComputable: true })
        this.status = 200
        this.response = new TextEncoder().encode(JSON.stringify({
          ok: true,
          id,
          ...(index === null ? {} : { index: Number(index) }),
          sha256: this.headers['X-Vault-SHA256'],
          size: body.byteLength,
        })).buffer
        this.onload?.()
      } catch (error) { this.error = error; this.onerror?.() }
    }
  }
  try {
    // 1) Whole-file photo: context-bound (v2) + ciphertext sha256.
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 16
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg'))
    const photo = new File([blob], 'integration.jpg', { type: 'image/jpeg' })
    const photoResult = await uploadMediaBatch([photo])
    if (photoResult.errors.length) throw photoResult.errors[0].error
    if (photoResult.entries.length !== 1) throw new Error('Expected one committed photo entry')

    // 2) Chunked video (real recorded webm): context-bound chunks + chunk_sha256.
    const video = new File([await recordTinyVideo()], 'integration.webm', { type: 'video/webm' })
    const videoResult = await uploadMediaBatch([video])
    if (videoResult.errors.length) throw videoResult.errors[0].error
    if (videoResult.entries.length !== 1) throw new Error('Expected one committed video entry')

    if (commits.length !== 2) throw new Error(`Expected two publications, got ${commits.length}`)
    for (const commit of commits) {
      if (commit.parentCommit !== oid) throw new Error('Publication was not CAS protected')
    }

    const photoManifest = await parseManifestBytes(new Uint8Array(
      await decryptPacked(base64ToBytes(commits[0].manifestBytesBase64), key),
    ))
    const photoEntry = photoManifest.files.find((entry) => entry.name === 'integration.jpg')
    if (!photoEntry) throw new Error('Photo entry missing from published manifest')
    if (photoEntry.crypto_version !== 2) throw new Error('Photo was not stamped crypto_version 2')
    if (!/^[0-9a-f]{64}$/.test(photoEntry.sha256 || '')) throw new Error('Photo entry lacks ciphertext sha256')

    const videoManifest = await parseManifestBytes(new Uint8Array(
      await decryptPacked(base64ToBytes(commits[1].manifestBytesBase64), key),
    ))
    const videoEntry = videoManifest.files.find((entry) => entry.name === 'integration.webm')
    if (!videoEntry) throw new Error('Video entry missing from published manifest')
    if (videoEntry.crypto_version !== 2 || videoEntry.chunked !== true) {
      throw new Error('Video entry is not a context-bound chunked entry')
    }
    if (!Array.isArray(videoEntry.chunk_sha256) || videoEntry.chunk_sha256.length !== videoEntry.chunk_count) {
      throw new Error('Video entry chunk_sha256 is not index-aligned with chunk_count')
    }
    if (commits[1].chunks.length !== videoEntry.chunk_count) {
      throw new Error('Video publication did not include every chunk receipt')
    }

    const remaining = (await getUploadQueue()).filter((row) => ids.has(row.id))
    if (remaining.length) throw new Error('Successful uploads left recovery rows')
    return {
      passed: true,
      commits: commits.length,
      photo: { cryptoVersion: photoEntry.crypto_version, sha256: photoEntry.sha256.slice(0, 12) },
      video: { cryptoVersion: videoEntry.crypto_version, chunks: videoEntry.chunk_count },
      parentCommit: commits[0].parentCommit,
    }
  } finally {
    window.fetch = originalFetch
    window.XMLHttpRequest = OriginalXHR
    for (const row of await getUploadQueue()) {
      if (!before.has(row.id) && ids.has(row.id)) await dequeueUpload(row.id)
    }
    for (const id of ids) await deleteCachedThumb(id)
    clearActiveKey()
    shutdownPool()
  }
}
