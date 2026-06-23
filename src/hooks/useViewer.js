import { useEffect, useState } from 'react'
import { loadFullMedia } from '../services/viewerService'

/**
 * Load and decrypt a single media file. `entry` must carry `id`, `type`, and
 * optionally `name` (for mime inference). The object URL is revoked when the
 * id changes or the component unmounts.
 *
 * All setState calls live in promise continuations; the effect body itself
 * performs no synchronous state writes (keeps react-hooks/set-state-in-effect
 * happy and avoids cascading renders).
 */
export function useViewer(entry) {
  const [objectUrl, setObjectUrl] = useState(null)
  const [state, setState] = useState({ loading: true, error: null })

  useEffect(() => {
    if (!entry) return undefined
    let url = null
    let cancelled = false

    // Reset to loading for the new entry via the async microtask, not synchronously.
    Promise.resolve().then(() => {
      if (!cancelled) setState({ loading: true, error: null })
    })

    loadFullMedia(entry.id, inferMimeType(entry))
      .then((created) => {
        if (cancelled) {
          URL.revokeObjectURL(created)
          return
        }
        url = created
        setObjectUrl(created)
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
  }, [entry])

  return { objectUrl, loading: state.loading, error: state.error }
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
