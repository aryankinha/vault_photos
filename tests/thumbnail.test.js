import test from 'node:test'
import assert from 'node:assert/strict'
import { generateThumbnail } from '../src/utils/thumbnail.js'
import { readMediaMetadata } from '../src/utils/exif.js'

function installMediaDouble(t, { duration = 0 } = {}) {
  const video = {
    duration, readyState: 2, videoWidth: 640, videoHeight: 360,
    paused: false, released: false,
    pause() { this.paused = true },
    removeAttribute() { this.released = true },
    load() {},
  }
  const oldDocument = globalThis.document
  globalThis.document = {
    createElement(type) {
      if (type === 'video') return video
      return {
        getContext: () => ({ drawImage() {} }),
        toBlob: (callback) => callback(new Blob(['test jpeg'], { type: 'image/jpeg' })),
      }
    },
  }
  t.after(() => {
    if (oldDocument === undefined) delete globalThis.document
    else globalThis.document = oldDocument
  })
  return video
}

test('zero/unknown-duration video previews do not wait for a zero-time seek event', async (t) => {
  for (const duration of [0, Infinity, NaN]) {
    const video = installMediaDouble(t, { duration })
    const promise = generateThumbnail(new Blob(['test video']), 'video')
    video.onloadedmetadata()
    assert.equal((await promise).type, 'image/jpeg')
    assert.equal(video.paused, true)
    assert.equal(video.released, true)
  }
})

test('video preview missing seeked has a bounded timeout and releases the decoder', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const video = installMediaDouble(t, { duration: 10 })
  const promise = generateThumbnail(new Blob(['test video']), 'video')
  const rejected = assert.rejects(promise, /preview timed out/)
  video.onloadedmetadata()
  assert.equal(video.currentTime, 1)
  t.mock.timers.tick(15_000)
  await rejected
  assert.equal(video.released, true)
  assert.equal(video.onseeked, null)
})

test('cancel or lock interrupts video preview preparation and frees the decoder', async (t) => {
  const video = installMediaDouble(t)
  const controller = new AbortController()
  const promise = generateThumbnail(new Blob(['test video']), 'video', { signal: controller.signal })
  controller.abort()
  await assert.rejects(promise, { name: 'AbortError' })
  assert.equal(video.released, true)
  assert.equal(video.onloadedmetadata, null)
})

test('cancel or lock interrupts video metadata preparation', async (t) => {
  const video = installMediaDouble(t)
  const controller = new AbortController()
  const promise = readMediaMetadata(new File(['test video'], 'test.mp4', { type: 'video/mp4' }), { signal: controller.signal })
  controller.abort()
  await assert.rejects(promise, { name: 'AbortError' })
  assert.equal(video.released, true)
})

test('a decoder failure produces an actionable error rather than hanging', async (t) => {
  const video = installMediaDouble(t)
  const promise = generateThumbnail(new Blob(['test video']), 'video')
  video.onerror()
  await assert.rejects(promise, /video codec/)
  assert.equal(video.released, true)
})
