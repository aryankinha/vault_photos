import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Loader2, AlertTriangle } from 'lucide-react'
import { useGallery } from '../hooks/useGallery'
import { useViewer } from '../hooks/useViewer'
import { consumePrefetched } from '../hooks/usePrefetch'

export function Viewer() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { entries, loading: loadingGallery } = useGallery()

  const entry = useMemo(() => entries.find((e) => e.id === id), [entries, id])

  // Phase 8 — drain the prefetch cache synchronously.
  // consumePrefetched returns the URL (and removes it from the cache) only on
  // the first render for this id.  We pass it straight to useViewer which owns
  // the revoke lifecycle.  useMemo with a stable dep ([id]) ensures we only
  // drain once, not on every re-render.
  const prefetchedUrl = useMemo(() => (id ? consumePrefetched(id) : null), [id])

  const { objectUrl, loading, error, streaming, streamProgress } = useViewer(entry, prefetchedUrl)

  const ready = !loadingGallery && entry && !loading && objectUrl

  return (
    <div className="flex min-h-screen flex-col bg-black">
      <header className="sticky top-0 z-20 flex h-12 items-center gap-2 border-b border-white/10 bg-black/80 px-2 backdrop-blur">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium text-neutral-200 transition hover:bg-white/10"
        >
          <ArrowLeft size={15} />
          Back
        </button>
        <span className="truncate text-xs text-neutral-400">{entry?.name}</span>

        {/* Phase 10 — buffering indicator in the header */}
        {streaming && streamProgress < 1 && (
          <span className="ml-auto flex items-center gap-1.5 text-[10px] text-neutral-500">
            <Loader2 size={11} className="animate-spin" />
            Buffering {Math.round(streamProgress * 100)}%
          </span>
        )}
      </header>

      <main className="flex flex-1 items-center justify-center overflow-hidden p-2">
        {loadingGallery || (entry && loading) ? (
          <Loader2 className="animate-spin text-neutral-500" size={22} />
        ) : error ? (
          <ViewerError error={error} />
        ) : !entry ? (
          <ViewerError error={new Error('Item not found')} />
        ) : ready ? (
          entry.type === 'video' ? (
            /* Phase 10 — wrap video in a relative container so the buffering
               progress bar can be absolutely positioned beneath it */
            <div className="relative">
              <video
                src={objectUrl}
                controls
                autoPlay
                playsInline
                className="max-h-[calc(100vh-6rem)] max-w-full rounded-lg"
              />
              {/* Buffering bar — thin accent line that grows left→right */}
              {streaming && streamProgress < 1 && (
                <div className="absolute bottom-0 left-0 h-[3px] w-full overflow-hidden rounded-b-lg bg-white/10">
                  <div
                    className="h-full rounded-b-lg bg-violet-500 transition-all duration-300 ease-out"
                    style={{ width: `${Math.round(streamProgress * 100)}%` }}
                  />
                </div>
              )}
            </div>
          ) : (
            <img
              src={objectUrl}
              alt={entry.name}
              className="max-h-[calc(100vh-6rem)] max-w-full rounded-lg object-contain"
            />
          )
        ) : null}
      </main>
    </div>
  )
}

function ViewerError({ error }) {
  return (
    <div className="flex flex-col items-center text-center text-neutral-400">
      <AlertTriangle size={22} className="mb-2 text-red-400" />
      <p className="text-xs">{error.message}</p>
    </div>
  )
}
