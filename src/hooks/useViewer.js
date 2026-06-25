import { useEffect, useState } from 'react'
import { loadFullMedia } from '../services/viewerService'
import { createVideoStream, isMseSupported } from '../services/videoStreamService'

/**
 * Load and decrypt a single media file. `entry` must carry `id`, `type`, and
 * optionally `name` (for mime inference). The object URL is revoked when the
 * id changes or the component unmounts.
 *
 * All setState calls live in promise continuations; the effect body itself
 * performs no synchronous state writes (keeps react-hooks/set-state-in-effect
 * happy and avoids cascading renders).
 *
 * Phase 8: accepts an optional `prefetchedUrl` string.  When supplied the hook
 * skips decryption and enters the ready state immediately.  The caller must NOT
 * revoke this URL — the hook takes ownership and revokes on cleanup.
 *
 * Phase 10: for chunked video entries, delegates to createVideoStream() for
 * MSE-based progressive playback.  Falls back to full-assembly Blob if MSE
 * is unsupported or the codec probe fails.  Exposes `streamProgress` (0–1) so
 * callers can render a buffering bar while chunks arrive.
 *
 * Return shape: { objectUrl, loading, error, streaming, streamProgress }
 *   streaming      — true while an MSE stream is in progress
 *   streamProgress — 0–1 fraction of chunks received (0 until first chunk)
 */
export function useViewer(entry, prefetchedUrl) {
  const [objectUrl, setObjectUrl] = useState(null)
  const [state, setState] = useState({ loading: true, error: null })
  const [streamProgress, setStreamProgress] = useState(0)
  const [streaming, setStreaming] = useState(false)

  useEffect(() => {
    if (!entry) return undefined

    // ── Phase 8: instant path — a prefetched URL is already in memory ────────
    if (prefetchedUrl) {
      let active = true
      // Defer all setState calls to a microtask — same pattern as the normal path.
      // This satisfies react-hooks/set-state-in-effect and avoids cascading renders.
      Promise.resolve().then(() => {
        if (!active) return
        setObjectUrl(prefetchedUrl)
        setState({ loading: false, error: null })
        setStreaming(false)
        setStreamProgress(1)
      })
      return () => {
        active = false
        URL.revokeObjectURL(prefetchedUrl)
      }
    }

    // ── Phase 10: MSE streaming for chunked video ─────────────────────────────
    if (entry.chunked && entry.type === 'video') {
      const mime = inferMimeType(entry)

      if (isMseSupported(mime)) {
        let mseActive = true

        // Defer initial state updates to microtask (satisfies set-state-in-effect rule)
        Promise.resolve().then(() => {
          if (!mseActive) return
          setStreamProgress(0)
          setStreaming(true)
        })

        const stream = createVideoStream(entry, mime, {
          onProgress: (p) => setStreamProgress(p),
          onError: (err) => {
            // If MSE fails mid-stream, mark error so the user sees it rather than a frozen video.
            setState({ loading: false, error: err })
            setStreaming(false)
          },
        })

        if (stream) {
          const cleanupFn = stream.cleanup
          // Hand the URL to the video element via microtask — stream.url is already set.
          Promise.resolve().then(() => {
            if (!mseActive) return
            setObjectUrl(stream.url)
            setState({ loading: false, error: null })
          })
          return () => {
            mseActive = false
            setStreaming(false)
            cleanupFn?.()
          }
        }
        // stream === null means isMseSupported returned true but
        // createVideoStream returned null (race/unsupported). Fall through.
        Promise.resolve().then(() => { if (mseActive) setStreaming(false) })
        mseActive = false
      }
      // MSE unsupported — fall through to full-assembly path below.
    }

    // ── Normal decrypt path (single-file or chunked non-video) ───────────────
    let url = null
    let cancelled = false

    // Reset to loading for the new entry via the async microtask, not synchronously.
    Promise.resolve().then(() => {
      if (!cancelled) {
        setState({ loading: true, error: null })
        setStreaming(false)
        setStreamProgress(0)
      }
    })


    loadFullMedia(entry, inferMimeType(entry))
      .then((created) => {
        if (cancelled) {
          URL.revokeObjectURL(created)
          return
        }
        url = created
        setObjectUrl(created)
        setStreamProgress(1)
        setState({ loading: false, error: null })
      })
      .catch((e) => {
        if (cancelled) return
        setState({ loading: false, error: e })
      })

    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [entry, prefetchedUrl])

  return {
    objectUrl,
    loading: state.loading,
    error: state.error,
    streaming,
    streamProgress,
  }
}

function inferMimeType(entry) {
  if (entry?.type === 'video') {
    const ext = entry.name?.toLowerCase().split('.').pop()
    if (ext === 'mp4') return 'video/mp4'
    if (ext === 'webm') return 'video/webm'
    if (ext === 'mov') return 'video/quicktime'
    return 'video/mp4'
  }
  if (entry?.type === 'image') {
    const ext = entry.name?.toLowerCase().split('.').pop()
    if (ext === 'png') return 'image/png'
    if (ext === 'webp') return 'image/webp'
    if (ext === 'gif') return 'image/gif'
    return 'image/jpeg'
  }
  return 'application/octet-stream'
}
