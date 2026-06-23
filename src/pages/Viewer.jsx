import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Loader2, AlertTriangle } from 'lucide-react'
import { useGallery } from '../hooks/useGallery'
import { useViewer } from '../hooks/useViewer'

export function Viewer() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { entries, loading: loadingGallery } = useGallery()

  const entry = useMemo(() => entries.find((e) => e.id === id), [entries, id])
  const { objectUrl, loading, error } = useViewer(entry)

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
            <video
              src={objectUrl}
              controls
              autoPlay
              playsInline
              className="max-h-[calc(100vh-6rem)] max-w-full rounded-lg"
            />
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
