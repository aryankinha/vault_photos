import { useNavigate } from 'react-router-dom'
import { Play } from 'lucide-react'

/**
 * Single thumbnail tile. Reads its image bytes from the gallery's in-memory
 * thumb map (object URL memoized by parent to avoid re-creating per render).
 *
 * V3: When thumbUrl is absent the card shows an animated shimmer skeleton
 * instead of the old "No thumb" text. Thumbnails fade in on arrival.
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
      {/* Shimmer skeleton — visible while thumb is loading */}
      {!thumbUrl && (
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            background: 'linear-gradient(90deg, #1a1a1a 25%, #252525 50%, #1a1a1a 75%)',
            backgroundSize: '200% 100%',
            animation: 'vp-shimmer 1.6s ease-in-out infinite',
          }}
        />
      )}

      {thumbUrl && (
        <img
          src={thumbUrl}
          alt={entry.name}
          loading="lazy"
          className="h-full w-full object-cover transition-opacity duration-300 group-hover:brightness-110"
          style={{ opacity: thumbUrl ? 1 : 0 }}
        />
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

