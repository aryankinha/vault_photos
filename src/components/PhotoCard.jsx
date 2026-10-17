import { memo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, ImageOff, Lock, Play, WifiOff } from 'lucide-react'
import { usePrefetch } from '../hooks/usePrefetch'

export const PhotoCard = memo(function PhotoCard({ entry, thumbUrl, onClick, uploadState, onRetry, prefetchEntry }) {
  const navigate = useNavigate()
  const [failedUrl, setFailedUrl] = useState(null)
  const prefetchTarget = prefetchEntry ?? (uploadState ? null : entry)
  const { hoverProps, touchProps } = usePrefetch(prefetchTarget)
  const showOverlay = uploadState && uploadState.status !== 'done'
  const thumbFailed = Boolean(thumbUrl && failedUrl === thumbUrl)

  const open = () => {
    if (showOverlay) return
    if (onClick) onClick()
    else navigate(`/view/${entry.id}`)
  }

  return (
    <div
      className="group relative h-full w-full overflow-hidden rounded-lg bg-neutral-900 ring-1 ring-white/5"
      {...hoverProps}
      {...touchProps}
    >
      <button
        type="button"
        onClick={open}
        disabled={Boolean(showOverlay)}
        className="absolute inset-0 block h-full w-full disabled:cursor-default"
        aria-label={`Open ${entry.name}`}
      >
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

        {thumbUrl && !thumbFailed && (
          <img
            key={thumbUrl}
            src={thumbUrl}
            alt={entry.name}
            loading="lazy"
            onError={() => setFailedUrl(thumbUrl)}
            className="h-full w-full object-cover transition duration-300 group-hover:brightness-110"
          />
        )}

        {thumbFailed && (
          <span className="absolute inset-0 flex items-center justify-center text-neutral-600">
            <ImageOff size={20} />
          </span>
        )}

        {entry.type === 'video' && !showOverlay && (
          <>
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="rounded-full bg-black/55 p-2 text-white backdrop-blur-sm transition group-hover:scale-110">
                <Play size={16} fill="currentColor" />
              </span>
            </span>
            {entry.duration > 0 && (
              <span className="absolute bottom-1.5 right-1.5 rounded bg-black/65 px-1.5 py-0.5 text-[9px] font-medium tabular-nums text-white">
                {formatDuration(entry.duration)}
              </span>
            )}
          </>
        )}
      </button>

      {showOverlay && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center bg-black/55 backdrop-blur-[2px]">
          {uploadState.status === 'encrypting' && (
            <Lock size={20} className="animate-spin text-white/85" />
          )}
          {uploadState.status === 'uploading' && (
            <ProgressRing progress={uploadState.progress} />
          )}
          {uploadState.status === 'waiting' && (
            <span className="flex flex-col items-center gap-1 text-white/85">
              <WifiOff size={19} />
              <span className="text-[9px]">Waiting for connection</span>
            </span>
          )}
          {uploadState.status === 'error' && (
            <AlertTriangle size={19} className="text-red-400" />
          )}
        </div>
      )}

      {uploadState?.status === 'error' && (
        <button
          type="button"
          onClick={() => onRetry?.(entry.id)}
          className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-white/15 px-2 py-1 text-[9px] font-semibold text-white ring-1 ring-white/25 hover:bg-white/25"
        >
          Retry
        </button>
      )}
    </div>
  )
})

function ProgressRing({ progress = 0 }) {
  const radius = 17
  const stroke = 2.5
  const normalizedRadius = radius - stroke
  const circumference = normalizedRadius * 2 * Math.PI
  const normalized = Math.max(0, Math.min(1, progress))

  return (
    <span className="relative flex h-[34px] w-[34px] items-center justify-center">
      <svg height={radius * 2} width={radius * 2} className="absolute -rotate-90">
        <circle stroke="rgba(255,255,255,.2)" fill="none" strokeWidth={stroke} r={normalizedRadius} cx={radius} cy={radius} />
        <circle
          stroke="white"
          fill="none"
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - normalized)}
          strokeLinecap="round"
          r={normalizedRadius}
          cx={radius}
          cy={radius}
        />
      </svg>
      <span className="text-[8px] font-semibold tabular-nums text-white">
        {Math.round(normalized * 100)}%
      </span>
    </span>
  )
}

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.floor(seconds % 60)
  return `${minutes}:${remainder.toString().padStart(2, '0')}`
}

export const VideoThumb = memo(function VideoThumb({ entry, thumbUrl, onClick }) {
  return <PhotoCard entry={entry} thumbUrl={thumbUrl} onClick={onClick} />
})
