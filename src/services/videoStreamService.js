/**
 * videoStreamService.js — Phase 10: Chunked video streaming via MediaSource API.
 *
 * Architecture
 * ────────────────────────────────────────────────────────────────────────────
 * For video files stored as AES-GCM chunks (entry.chunked === true), instead
 * of decrypting every chunk into RAM and then creating one giant Blob URL
 * (which blocks until all crypto is done), we:
 *
 *   1. Create a MediaSource instance and get its object URL immediately.
 *   2. Listen for 'sourceopen', then open a SourceBuffer for the video codec.
 *   3. Decrypt chunks one-by-one via the decryptFileChunks generator and
 *      append each to the SourceBuffer as it arrives.
 *   4. Call mediaSource.endOfStream() when the last chunk is appended.
 *
 * This lets the <video> element start rendering the first frame as soon as
 * chunk 0 is decrypted, while remaining chunks arrive progressively.
 *
 * Codec support
 * ────────────────────────────────────────────────────────────────────────────
 * MSE requires the video data to be in a "byte-stream" format it understands.
 * In practice this means:
 *   • fragmented MP4 (fMP4)   — most modern devices/encoders
 *   • WebM (VP8/VP9/AV1)      — Chromium-based browsers only for VP8/VP9
 *
 * For regular (non-fragmented) MP4 files, MSE may fail or stall until the
 * moov atom arrives. createVideoStream() returns null in that case so the
 * caller can fall back gracefully to the full-assembly Blob path.
 *
 * Cleanup
 * ────────────────────────────────────────────────────────────────────────────
 * The returned `cleanup()` function MUST be called when the component unmounts
 * or the user navigates away. It aborts any in-flight decryption and revokes
 * the object URL.
 */

import { decryptFileChunks } from '../crypto/chunkEncrypt'
import { getActiveKey } from '../crypto/keyDerivation'
import * as worker from '../storage/workerClient'

// ─── Codec probing ────────────────────────────────────────────────────────────

/**
 * Ordered list of MIME type + codec strings to probe.
 * We try the most-specific string first and fall back to the base type.
 * isTypeSupported() is synchronous and cheap.
 */
const MSE_PROBE_TYPES = [
  // fMP4 — H.264 baseline + AAC (widest support)
  'video/mp4; codecs="avc1.42E01E,mp4a.40.2"',
  // fMP4 — H.264 high + AAC
  'video/mp4; codecs="avc1.640028,mp4a.40.2"',
  // fMP4 — generic (browser picks codec from container)
  'video/mp4',
  // WebM — VP9 + Opus (Chrome/Edge/Firefox)
  'video/webm; codecs="vp9,opus"',
  // WebM — VP8 + Vorbis
  'video/webm; codecs="vp8,vorbis"',
  // WebM — generic
  'video/webm',
]

/**
 * Find the first MIME+codec string that both matches the caller's base MIME
 * type and is supported by this browser's MSE implementation.
 *
 * @param {string} mimeType — e.g. "video/mp4" or "video/webm"
 * @returns {string|null}
 */
function resolveSourceBufferType(mimeType) {
  if (typeof window === 'undefined' || !window.MediaSource) return null
  const base = (mimeType || 'video/mp4').split(';')[0].trim()
  for (const candidate of MSE_PROBE_TYPES) {
    if (candidate.startsWith(base) && MediaSource.isTypeSupported(candidate)) {
      return candidate
    }
  }
  return null
}

// ─── MSE streaming engine ─────────────────────────────────────────────────────

/**
 * Create a MediaSource-backed streaming video URL for a chunked entry.
 *
 * @param {object} entry       — manifest entry (must have id, chunk_count)
 * @param {string} mimeType    — inferred mime type (e.g. "video/mp4")
 * @param {object} callbacks   — optional
 * @param {(progress: number) => void} callbacks.onProgress — called with 0–1 as each chunk arrives
 * @param {(err: Error) => void}       callbacks.onError    — called if streaming fails after start
 *
 * @returns {{ url: string, cleanup: () => void } | null}
 *   Returns null if MSE is unavailable or the codec is unsupported (caller
 *   should fall back to full-assembly Blob path).
 */
export function createVideoStream(entry, mimeType, callbacks = {}) {
  if (typeof window === 'undefined' || !window.MediaSource) return null

  const sourceBufferType = resolveSourceBufferType(mimeType)
  if (!sourceBufferType) return null

  const { onProgress, onError } = callbacks
  const mediaSource = new MediaSource()
  const url = URL.createObjectURL(mediaSource)

  let aborted = false
  let sourceBuffer = null

  // ── Helper: wait for SourceBuffer to finish processing an appendBuffer ────
  function waitForUpdateEnd() {
    return new Promise((resolve, reject) => {
      function onEnd() {
        sourceBuffer.removeEventListener('updateend', onEnd)
        sourceBuffer.removeEventListener('error', onErr)
        resolve()
      }
      function onErr(e) {
        sourceBuffer.removeEventListener('updateend', onEnd)
        sourceBuffer.removeEventListener('error', onErr)
        reject(new Error(`SourceBuffer error: ${e.type}`))
      }
      sourceBuffer.addEventListener('updateend', onEnd)
      sourceBuffer.addEventListener('error', onErr)
    })
  }

  // ── Main streaming coroutine — runs when MediaSource is open ──────────────
  async function stream() {
    try {
      sourceBuffer = mediaSource.addSourceBuffer(sourceBufferType)
      // 'sequence' mode: browser assigns presentation timestamps in order,
      // which is correct for sequentially decrypted chunks.
      sourceBuffer.mode = 'sequence'
    } catch (err) {
      // addSourceBuffer can throw if the type was accepted by isTypeSupported
      // but the actual data format is wrong (e.g. non-fragmented MP4).
      console.warn('[Phase 10] addSourceBuffer failed:', err.message)
      if (mediaSource.readyState === 'open') mediaSource.endOfStream('decode')
      onError?.(err)
      return
    }

    const total = entry.chunk_count
    let done = 0

    try {
      for await (const decryptedChunk of decryptFileChunks(
        entry.id,
        total,
        getActiveKey(),
        worker.getChunk,
      )) {
        if (aborted) break

        // Wait if SourceBuffer is still processing the previous appendBuffer.
        if (sourceBuffer.updating) await waitForUpdateEnd()
        if (aborted) break

        sourceBuffer.appendBuffer(decryptedChunk)
        await waitForUpdateEnd()

        done++
        onProgress?.(done / total)
      }
    } catch (err) {
      if (!aborted) {
        console.warn('[Phase 10] Streaming error:', err.message)
        onError?.(err)
      }
    }

    if (!aborted && mediaSource.readyState === 'open') {
      // Ensure no pending update before calling endOfStream
      if (sourceBuffer?.updating) await waitForUpdateEnd().catch(() => {})
      try { mediaSource.endOfStream() } catch { /* already ended or aborted */ }
    }
  }

  mediaSource.addEventListener('sourceopen', () => {
    void stream()
  }, { once: true })

  // ── Cleanup — abort in-flight streaming and revoke URL ────────────────────
  function cleanup() {
    aborted = true
    // Abort any pending SourceBuffer operation so the coroutine unblocks.
    try {
      if (sourceBuffer && mediaSource.readyState === 'open' && sourceBuffer.updating) {
        sourceBuffer.abort()
      }
    } catch { /* ignore */ }
    // End the MediaSource so the <video> element releases it.
    try {
      if (mediaSource.readyState === 'open') mediaSource.endOfStream()
    } catch { /* already ended */ }
    URL.revokeObjectURL(url)
  }

  return { url, cleanup }
}

/**
 * Returns true if MediaSource streaming is available and likely to work for
 * the given mimeType.  Use for feature-detection before calling createVideoStream.
 *
 * @param {string} mimeType
 * @returns {boolean}
 */
export function isMseSupported(mimeType) {
  return resolveSourceBufferType(mimeType) !== null
}
