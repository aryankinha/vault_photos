import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Lock, Play } from 'lucide-react'

/**
 * Single thumbnail tile. Reads its image bytes from the gallery's in-memory
 * thumb map (object URL memoized by parent to avoid re-creating per render).
 *
 * V3: When thumbUrl is absent the card shows an animated shimmer skeleton
 * instead of the old "No thumb" text. Thumbnails fade in on arrival.
 *
 * V3: Accepts an optional `uploadState` prop to show an in-progress overlay:
 *   { status: 'encrypting' | 'uploading' | 'done' | 'error', progress: 0-1, error: string | null }
 */
export function PhotoCard({ entry, thumbUrl, onClick, uploadState, onRetry }) {
  const navigate = useNavigate()

  function open() {
    if (onClick) onClick()
    else navigate(`/view/${entry.id}`)
  }

  const showOverlay = uploadState && uploadState.status !== 'done'

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

      {entry.type === 'video' && !showOverlay && (
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

      {/* ------------------------------------------------------------------ */}
      {/* V3 — Upload state overlay                                           */}
      {/* ------------------------------------------------------------------ */}
      {showOverlay && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/55 backdrop-blur-[2px]">
          {uploadState.status === 'encrypting' && (
            <span className="animate-spin text-white/80">
              <Lock size={20} />
            </span>
          )}

          {uploadState.status === 'uploading' && (
            <ProgressRing progress={uploadState.progress} />
          )}

          {uploadState.status === 'error' && (
            <div className="flex flex-col items-center gap-1">
              <AlertTriangle size={18} className="text-red-400" />
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onRetry && onRetry(entry.id) }}
                className="mt-0.5 rounded bg-white/10 px-2 py-0.5 text-[9px] font-medium text-white ring-1 ring-white/20 hover:bg-white/20"
              >
                Retry
              </button>
            </div>
          )}
        </div>
      )}
    </button>
  )
}

/** Circular SVG progress ring for upload percentage. */
function ProgressRing({ progress }) {
  const radius = 14
  const stroke = 2.5
  const normalizedRadius = radius - stroke
  const circumference = normalizedRadius * 2 * Math.PI
  const offset = circumference - Math.max(0, Math.min(1, progress)) * circumference

  return (
    <svg height={radius * 2} width={radius * 2} className="-rotate-90">
      {/* Track */}
      <circle
        stroke="rgba(255,255,255,0.2)"
        fill="transparent"
        strokeWidth={stroke}
        r={normalizedRadius}
        cx={radius}
        cy={radius}
      />
      {/* Fill */}
      <circle
        stroke="white"
        fill="transparent"
        strokeWidth={stroke}
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={offset}
        strokeLinecap="round"
        r={normalizedRadius}
        cx={radius}
        cy={radius}
        style={{ transition: 'stroke-dashoffset 0.2s ease' }}
      />
    </svg>
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

