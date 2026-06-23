import { useNavigate } from 'react-router-dom'
import { Play } from 'lucide-react'

/**
 * Single thumbnail tile. Reads its image bytes from the gallery's in-memory
 * thumb map (object URL memoized by parent to avoid re-creating per render).
 */
export function PhotoCard({ entry, thumbUrl, onClick }) {
  const navigate = useNavigate()

  function open() {
    if (onClick) onClick()
    else navigate(`/view/${entry.id}`)
  }

  return (
    <button
      type="button"
      onClick={open}
      className="group relative block aspect-square w-full overflow-hidden rounded-lg bg-neutral-900 ring-1 ring-white/5"
    >
      {thumbUrl ? (
        <img
          src={thumbUrl}
          alt={entry.name}
          loading="lazy"
          className="h-full w-full object-cover transition duration-200 group-hover:brightness-110"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-neutral-600">
          <span className="text-[10px]">No thumb</span>
        </div>
      )}
      {entry.type === 'video' && (
        <>
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="rounded-full bg-black/50 p-2 text-white backdrop-blur-sm transition duration-200 group-hover:scale-110">
              <Play size={16} fill="currentColor" />
            </span>
          </span>
          {entry.duration && (
            <span className="absolute bottom-1.5 right-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-medium tabular-nums text-white backdrop-blur-sm">
              {formatDuration(entry.duration)}
            </span>
          )}
        </>
      )}
    </button>
  )
}

function formatDuration(seconds) {
  if (!seconds || !Number.isFinite(seconds)) return ''
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function VideoThumb({ entry, thumbUrl, onClick }) {
  return <PhotoCard entry={entry} thumbUrl={thumbUrl} onClick={onClick} />
}
