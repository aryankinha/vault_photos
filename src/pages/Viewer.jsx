import { useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { useGallery } from '../hooks/useGallery'
import { useViewer } from '../hooks/useViewer'
import { consumePrefetched } from '../hooks/usePrefetch'

export function Viewer() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { entries, loading: loadingGallery } = useGallery()
  const [retryKey, setRetryKey] = useState(0)
  const [readyVideoUrl, setReadyVideoUrl] = useState(null)

  const entry = useMemo(() => entries.find((item) => item.id === id), [entries, id])
  const currentIndex = useMemo(
    () => entries.findIndex((item) => item.id === id),
    [entries, id],
  )
  const prefetchedMedia = useMemo(
    () => (id ? consumePrefetched(id) : null),
    [id],
  )
  const { objectUrl, loading, error, streaming, streamProgress } = useViewer(
    entry,
    retryKey === 0 ? prefetchedMedia : null,
    retryKey,
  )

  const previous = currentIndex > 0 ? entries[currentIndex - 1] : null
  const next = currentIndex >= 0 && currentIndex < entries.length - 1
    ? entries[currentIndex + 1]
    : null
  const openEntry = (target) => {
    if (target) navigate(`/view/${target.id}`, { replace: true })
  }
  const goBack = () => navigate('/gallery')
  const isLoading = loadingGallery || (entry && loading)

  return (
    <div className="flex min-h-screen flex-col bg-black">
      <header className="sticky top-0 z-20 flex h-12 items-center gap-2 border-b border-white/10 bg-black/85 px-2 backdrop-blur">
        <button
          type="button"
          onClick={goBack}
          className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium text-neutral-200 hover:bg-white/10"
        >
          <ArrowLeft size={15} />
          Back
        </button>
        <span className="truncate text-xs text-neutral-400">{entry?.name}</span>
        {streaming && readyVideoUrl !== objectUrl && (
          <span className="ml-auto flex items-center gap-1.5 text-[10px] text-neutral-500">
            <Loader2 size={11} className="animate-spin" />
            Buffering {Math.round(streamProgress * 100)}%
          </span>
        )}
      </header>

      <main className="relative flex flex-1 items-center justify-center overflow-hidden p-2">
        {isLoading ? (
          <ViewerSkeleton video={entry?.type === 'video'} />
        ) : error ? (
          <ViewerError
            message="This item could not be decrypted or downloaded."
            onRetry={() => setRetryKey((value) => value + 1)}
            onBack={goBack}
          />
        ) : !entry ? (
          <ViewerError
            message="This item is no longer in the vault."
            onRetry={() => window.location.reload()}
            onBack={goBack}
          />
        ) : objectUrl ? (
          <>
            {entry.type === 'video' ? (
              <div className="relative flex max-h-[calc(100vh-4rem)] max-w-full items-center justify-center">
                <video
                  key={objectUrl}
                  src={objectUrl}
                  controls
                  autoPlay
                  playsInline
                  onCanPlay={() => setReadyVideoUrl(objectUrl)}
                  className={`max-h-[calc(100vh-4rem)] max-w-full rounded-lg transition-opacity ${
                    readyVideoUrl === objectUrl ? 'opacity-100' : 'opacity-0'
                  }`}
                />
                {readyVideoUrl !== objectUrl && (
                  <div className="absolute inset-0 flex min-h-64 min-w-72 items-center justify-center rounded-lg bg-neutral-900">
                    <Loader2 size={24} className="animate-spin text-neutral-500" />
                  </div>
                )}
                {streaming && readyVideoUrl !== objectUrl && (
                  <div className="absolute bottom-0 left-0 h-[3px] w-full overflow-hidden rounded-b-lg bg-white/10">
                    <div
                      className="h-full bg-sky-500 transition-[width] duration-300"
                      style={{ width: `${Math.round(streamProgress * 100)}%` }}
                    />
                  </div>
                )}
              </div>
            ) : (
              <ZoomableImage
                key={objectUrl}
                src={objectUrl}
                alt={entry.name}
                onPrevious={() => openEntry(previous)}
                onNext={() => openEntry(next)}
                onDismiss={goBack}
              />
            )}

            {previous && (
              <button
                type="button"
                onClick={() => openEntry(previous)}
                aria-label="Previous item"
                className="absolute left-3 top-1/2 hidden -translate-y-1/2 rounded-full bg-black/55 p-2 text-white ring-1 ring-white/15 hover:bg-black/75 sm:block"
              >
                <ChevronLeft size={22} />
              </button>
            )}
            {next && (
              <button
                type="button"
                onClick={() => openEntry(next)}
                aria-label="Next item"
                className="absolute right-3 top-1/2 hidden -translate-y-1/2 rounded-full bg-black/55 p-2 text-white ring-1 ring-white/15 hover:bg-black/75 sm:block"
              >
                <ChevronRight size={22} />
              </button>
            )}
          </>
        ) : null}
      </main>
    </div>
  )
}

function ZoomableImage({ src, alt, onPrevious, onNext, onDismiss }) {
  const [loaded, setLoaded] = useState(false)
  const [scale, setScale] = useState(1)
  const gestureRef = useRef({ mode: null, lastTap: 0 })

  const handleTouchStart = (event) => {
    if (event.touches.length === 2) {
      gestureRef.current = {
        ...gestureRef.current,
        mode: 'pinch',
        distance: touchDistance(event.touches),
        initialScale: scale,
      }
      return
    }
    const touch = event.touches[0]
    gestureRef.current = {
      ...gestureRef.current,
      mode: 'swipe',
      startX: touch.clientX,
      startY: touch.clientY,
      currentX: touch.clientX,
      currentY: touch.clientY,
    }
  }

  const handleTouchMove = (event) => {
    if (gestureRef.current.mode === 'pinch' && event.touches.length === 2) {
      event.preventDefault()
      const ratio = touchDistance(event.touches) / gestureRef.current.distance
      setScale(clamp(gestureRef.current.initialScale * ratio, 1, 4))
      return
    }
    if (gestureRef.current.mode === 'swipe' && event.touches.length === 1) {
      gestureRef.current.currentX = event.touches[0].clientX
      gestureRef.current.currentY = event.touches[0].clientY
    }
  }

  const handleTouchEnd = () => {
    const gesture = gestureRef.current
    if (gesture.mode === 'pinch') {
      gestureRef.current.mode = null
      return
    }
    if (gesture.mode !== 'swipe') return

    const deltaX = gesture.currentX - gesture.startX
    const deltaY = gesture.currentY - gesture.startY
    gestureRef.current.mode = null

    if (scale <= 1.05 && deltaY > 90 && Math.abs(deltaY) > Math.abs(deltaX)) {
      onDismiss()
      return
    }
    if (scale <= 1.05 && Math.abs(deltaX) > 60 && Math.abs(deltaX) > Math.abs(deltaY)) {
      if (deltaX < 0) onNext()
      else onPrevious()
      return
    }

    if (Math.abs(deltaX) < 12 && Math.abs(deltaY) < 12) {
      const now = Date.now()
      if (now - gesture.lastTap < 300) {
        setScale((value) => value > 1 ? 1 : 2.5)
        gestureRef.current.lastTap = 0
      } else {
        gestureRef.current.lastTap = now
      }
    }
  }

  return (
    <div
      className="relative flex h-[calc(100vh-4rem)] w-full items-center justify-center overflow-hidden"
      style={{ touchAction: 'none' }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      {!loaded && <div className="absolute inset-4 animate-pulse rounded-lg bg-neutral-900" />}
      <img
        src={src}
        alt={alt}
        onLoad={() => setLoaded(true)}
        className={`max-h-full max-w-full rounded-lg object-contain transition-[opacity,transform] duration-200 ${loaded ? 'opacity-100' : 'opacity-0'}`}
        style={{ transform: `scale(${scale})` }}
        draggable="false"
      />
    </div>
  )
}

function ViewerSkeleton({ video }) {
  return (
    <div className="relative h-[70vh] w-full max-w-5xl animate-pulse rounded-lg bg-neutral-900">
      {video && (
        <span className="absolute inset-0 flex items-center justify-center">
          <Loader2 size={25} className="animate-spin text-neutral-600" />
        </span>
      )}
    </div>
  )
}

function ViewerError({ message, onRetry, onBack }) {
  return (
    <div className="flex max-w-sm flex-col items-center px-6 text-center text-neutral-400">
      <AlertTriangle size={24} className="mb-3 text-red-400" />
      <p className="text-sm text-neutral-300">{message}</p>
      <div className="mt-5 flex gap-2">
        <button type="button" onClick={onBack} className="rounded-lg bg-white/5 px-3 py-2 text-xs font-medium text-white ring-1 ring-white/10 hover:bg-white/10">
          Go back
        </button>
        <button type="button" onClick={onRetry} className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500 px-3 py-2 text-xs font-semibold text-white hover:bg-sky-400">
          <RefreshCw size={13} /> Retry
        </button>
      </div>
    </div>
  )
}

function touchDistance(touches) {
  return Math.hypot(
    touches[0].clientX - touches[1].clientX,
    touches[0].clientY - touches[1].clientY,
  )
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
