import { useEffect, useState } from 'react'
import { loadFullMedia } from '../services/viewerService'
import { createVideoStream, isMseSupported } from '../services/videoStreamService'
import { claimPrefetched } from './usePrefetch'

const claimedPrefetchUrls = new Set()

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
export function useViewer(entry, prefetchedMedia, reloadKey = 0) {
  const [objectUrl, setObjectUrl] = useState(null)
  const [objectEntryId, setObjectEntryId] = useState(null)
  const [state, setState] = useState({ entryId: null, loading: true, error: null })
  const [streamProgress, setStreamProgress] = useState(0)
  const [streaming, setStreaming] = useState(false)

  useEffect(() => {
    if (!entry) return undefined

    // ── Phase 8: instant path — a prefetched URL is already in memory ────────
    if (prefetchedMedia) {
      let active = true
      let ownedUrl = null
      claimPrefetched(entry.id, prefetchedMedia)
      // Defer all setState calls to a microtask — same pattern as the normal path.
      // This satisfies react-hooks/set-state-in-effect and avoids cascading renders.
      Promise.resolve(prefetchedMedia)
        .then((createdUrl) => {
          if (!active) {
            setTimeout(() => {
              if (!claimedPrefetchUrls.has(createdUrl)) {
                URL.revokeObjectURL(createdUrl)
              }
            }, 0)
            return
          }
          ownedUrl = createdUrl
          claimedPrefetchUrls.add(createdUrl)
          setObjectUrl(createdUrl)
          setObjectEntryId(entry.id)
          setState({ entryId: entry.id, loading: false, error: null })
          setStreaming(false)
          setStreamProgress(1)
        })
        .catch((error) => {
          if (active) setState({ entryId: entry.id, loading: false, error })
        })
      return () => {
        active = false
        if (ownedUrl) {
          claimedPrefetchUrls.delete(ownedUrl)
          URL.revokeObjectURL(ownedUrl)
        }
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
        })

        if (stream) {
          const cleanupFn = stream.cleanup
          let fallbackOwnedUrl = null
          // Hand the URL to the video element via microtask — stream.url is already set.
          Promise.resolve().then(() => {
            if (!mseActive) return
            setObjectUrl(stream.url)
            setObjectEntryId(entry.id)
            setState({ entryId: entry.id, loading: false, error: null })
          })
          stream.done
            .then(() => {
              if (!mseActive) return
              setStreaming(false)
              setStreamProgress(1)
            })
            .catch(() => {
              if (!mseActive) return
              cleanupFn?.()
              setStreaming(false)
              setState({ entryId: entry.id, loading: true, error: null })
              return loadFullMedia(entry, mime)
                .then((fallbackUrl) => {
                  if (!mseActive) {
                    URL.revokeObjectURL(fallbackUrl)
                    return
                  }
                  fallbackOwnedUrl = fallbackUrl
                  setObjectUrl(fallbackUrl)
                  setObjectEntryId(entry.id)
                  setState({ entryId: entry.id, loading: false, error: null })
                })
                .catch((error) => {
                  if (mseActive) setState({ entryId: entry.id, loading: false, error })
                })
            })
          return () => {
            mseActive = false
            setStreaming(false)
            cleanupFn?.()
            if (fallbackOwnedUrl) URL.revokeObjectURL(fallbackOwnedUrl)
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
        setState({ entryId: entry.id, loading: true, error: null })
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
        setObjectEntryId(entry.id)
        setStreamProgress(1)
        setState({ entryId: entry.id, loading: false, error: null })
      })
      .catch((e) => {
        if (cancelled) return
        setState({ entryId: entry.id, loading: false, error: e })
      })

    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [entry, prefetchedMedia, reloadKey])

  const isCurrentEntry = state.entryId === entry?.id
  return {
    objectUrl: objectEntryId === entry?.id ? objectUrl : null,
    loading: isCurrentEntry ? state.loading : Boolean(entry),
    error: isCurrentEntry ? state.error : null,
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
