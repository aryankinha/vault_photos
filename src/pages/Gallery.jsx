import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { ImageOff, Loader2, RefreshCw, LayoutGrid, Image as ImageIcon, Film, Upload, Trash2 } from 'lucide-react'
import { Topbar } from '../components/Topbar'
import { PhotoGrid } from '../components/PhotoGrid'
import { useGallery } from '../hooks/useGallery'
import { useUploadContext } from '../context/useUploadContext'
import { getUserErrorMessage } from '../utils/errors'
import { hasActiveKey } from '../crypto/keyDerivation'

export function Gallery() {
  const navigate = useNavigate()
  const {
    entries, thumbs, loading, thumbsLoading,
    loadingPage, pageError, totalPages, loadedPages, loadPage,
    error, reload,
  } = useGallery()
  const {
    isUploading,
    optimisticEntries,
    optimisticThumbs,
    optimisticStates,
    retryOptimistic,
    resumePendingUploads,
    pendingUploadCount,
    discardPendingUploads,
  } = useUploadContext()
  const [filter, setFilter] = useState('all')

  // Auto-reload when background upload finishes
  const wasUploadingRef = useRef(false)
  useEffect(() => {
    if (wasUploadingRef.current && !isUploading && hasActiveKey()) {
      void reload()
    }
    wasUploadingRef.current = isUploading
  }, [isUploading, reload])

  // Filter entries locally based on tab
  const filteredEntries = useMemo(() => {
    const source = [...entries]
    if (filter === 'photos') return source.filter((e) => e.type === 'image')
    if (filter === 'videos') return source.filter((e) => e.type === 'video')
    return source
  }, [entries, filter])

  // Merge optimistic entries into filtered list (appear at top, deduped by id)
  const mergedEntries = useMemo(() => {
    const realIds = new Set(filteredEntries.map((e) => e.id))
    const pending = (optimisticEntries ?? []).filter((e) => {
      if (!realIds.has(e.id)) {
        if (filter === 'photos') return e.type === 'image'
        if (filter === 'videos') return e.type === 'video'
        return true
      }
      return false
    })
    if (pending.length === 0) return filteredEntries
    return [
      ...pending.sort((a, b) => b.date_taken.localeCompare(a.date_taken)),
      ...filteredEntries,
    ]
  }, [filteredEntries, optimisticEntries, filter])

  // Merge optimistic thumbs into the real thumb map
  const mergedThumbs = useMemo(() => {
    if (!optimisticThumbs || optimisticThumbs.size === 0) return thumbs
    return new Map([...thumbs, ...optimisticThumbs])
  }, [thumbs, optimisticThumbs])

  // Render only hydrated pages. Keeping the sentinel directly after the last
  // visible page prevents thousands of unloaded entries from appearing as a
  // wall of placeholders before page 1 is requested.
  const visibleEntries = useMemo(() => mergedEntries.filter((entry) => (
    optimisticStates?.has(entry.id) ||
    loadedPages.has(entry.page_index ?? 0) ||
    mergedThumbs.has(entry.id)
  )), [mergedEntries, optimisticStates, loadedPages, mergedThumbs])


  // ---------------------------------------------------------------------------
  // IntersectionObserver — trigger loadPage when user nears the bottom
  // ---------------------------------------------------------------------------
  const sentinelRef = useRef(null)

  const nextPage = useMemo(() => {
    for (let p = 0; p < totalPages; p++) {
      if (!loadedPages.has(p)) return p
    }
    return null  // all pages loaded
  }, [totalPages, loadedPages])

  const handleLoadNextPage = useCallback(() => {
    if (nextPage !== null && !loadingPage && !pageError) {
      loadPage(nextPage)
    }
  }, [nextPage, loadingPage, pageError, loadPage])

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || nextPage === null) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          handleLoadNextPage()
        }
      },
      { rootMargin: '500px' },  // trigger 500px before the sentinel enters viewport
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [nextPage, handleLoadNextPage])

  return (
    <div className="min-h-screen bg-neutral-950">
      <Topbar />

      {/* Category Tabs */}
      {(entries.length > 0 || (optimisticEntries?.length ?? 0) > 0) && (
        <div className="flex justify-center gap-2 py-3 border-b border-white/5 bg-neutral-900/10">
          <button
            type="button"
            onClick={() => setFilter('all')}
            className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-medium transition ${
              filter === 'all'
                ? 'bg-neutral-100 text-neutral-950 font-semibold'
                : 'text-neutral-400 hover:bg-white/5 hover:text-white'
            }`}
          >
            <LayoutGrid size={13} />
            All
          </button>
          <button
            type="button"
            onClick={() => setFilter('photos')}
            className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-medium transition ${
              filter === 'photos'
                ? 'bg-neutral-100 text-neutral-950 font-semibold'
                : 'text-neutral-400 hover:bg-white/5 hover:text-white'
            }`}
          >
            <ImageIcon size={13} />
            Photos
          </button>
          <button
            type="button"
            onClick={() => setFilter('videos')}
            className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-medium transition ${
              filter === 'videos'
                ? 'bg-neutral-100 text-neutral-950 font-semibold'
                : 'text-neutral-400 hover:bg-white/5 hover:text-white'
            }`}
          >
            <Film size={13} />
            Videos
          </button>
        </div>
      )}

      {pendingUploadCount > 0 && !isUploading && (
        <div className="border-b border-amber-500/15 bg-amber-500/5 px-4 py-3">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-amber-200">
                {pendingUploadCount} interrupted {pendingUploadCount === 1 ? 'upload' : 'uploads'}
              </p>
              <p className="mt-0.5 text-[10px] text-amber-200/60">
                Recovery is paused so files do not restart without your approval.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void resumePendingUploads()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-300 px-3 py-1.5 text-[11px] font-semibold text-neutral-950 hover:bg-amber-200"
            >
              <RefreshCw size={12} /> Resume
            </button>
            <button
              type="button"
              onClick={() => void discardPendingUploads()}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold text-amber-100 ring-1 ring-amber-300/20 hover:bg-amber-300/10"
            >
              <Trash2 size={12} /> Discard
            </button>
          </div>
        </div>
      )}

      <main className="pb-16">
        {loading && entries.length === 0 && (optimisticEntries?.length ?? 0) === 0 ? (
          <GallerySkeleton />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : entries.length === 0 && (optimisticEntries?.length ?? 0) === 0 ? (
          <EmptyState onUpload={() => navigate('/upload')} />
        ) : mergedEntries.length === 0 ? (
          <div className="mx-auto flex max-w-md flex-col items-center px-6 py-24 text-center">
            <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/5 text-neutral-500 ring-1 ring-white/10">
              <ImageOff size={24} />
            </span>
            <h2 className="text-sm font-semibold text-neutral-200">No {filter} found</h2>
            <p className="mt-1 text-xs text-neutral-500">
              Try switching filters or upload new files to this category.
            </p>
          </div>
        ) : (
          <>
            <PhotoGrid
              entries={visibleEntries}
              thumbs={mergedThumbs}
              optimisticStates={optimisticStates}
              onRetry={retryOptimistic}
            />

            {/* Subtle indicator that thumbnails are still streaming in */}
            {thumbsLoading && entries.length > 0 && (
              <div className="flex items-center justify-center gap-2 pb-4 text-xs text-neutral-600">
                <Loader2 className="animate-spin" size={12} />
                <span>Loading thumbnails…</span>
              </div>
            )}

            {/* Sentinel div — IntersectionObserver triggers next page load */}
            {nextPage !== null && <div ref={sentinelRef} aria-hidden="true" className="h-px" />}

            {/* Page loading indicator */}
            {loadingPage && (
              <div className="flex items-center justify-center gap-2 py-6 text-xs text-neutral-600">
                <Loader2 className="animate-spin" size={12} />
                <span>Loading more…</span>
              </div>
            )}
            {pageError && nextPage !== null && (
              <div className="flex items-center justify-center gap-3 py-6 text-xs text-neutral-500">
                <span>Couldn't load more thumbnails.</span>
                <button
                  type="button"
                  onClick={() => loadPage(nextPage)}
                  className="rounded-lg bg-white/5 px-2.5 py-1.5 font-medium text-neutral-200 ring-1 ring-white/10 hover:bg-white/10"
                >
                  Retry
                </button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}

function EmptyState({ onUpload }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 py-24 text-center">
      <svg viewBox="0 0 120 92" className="mb-5 h-24 w-32 text-neutral-500" aria-hidden="true">
        <rect x="17" y="18" width="86" height="62" rx="7" fill="none" stroke="currentColor" strokeWidth="3" />
        <circle cx="43" cy="39" r="8" fill="currentColor" opacity=".55" />
        <path d="M25 70 49 51l15 13 12-10 20 16" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M60 8v20M50 18h20" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <h2 className="text-sm font-semibold text-neutral-200">Your vault is empty</h2>
      <p className="mt-1 max-w-sm text-xs leading-relaxed text-neutral-500">
        Upload photos and videos — they will be encrypted before leaving your device
      </p>
      <button
        type="button"
        onClick={onUpload}
        className="mt-5 inline-flex items-center gap-2 rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-400"
      >
        <Upload size={15} />
        Upload your first photo
      </button>
    </div>
  )
}

function GallerySkeleton() {
  return (
    <div className="mx-auto max-w-6xl px-3 py-6" aria-label="Loading gallery">
      <div className="mb-3 h-3 w-28 animate-pulse rounded bg-white/10" />
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
        {Array.from({ length: 18 }, (_, index) => (
          <div key={index} className="aspect-square animate-pulse rounded-lg bg-neutral-900" />
        ))}
      </div>
    </div>
  )
}

function ErrorState({ error, onRetry }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 py-24 text-center">
      <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-red-500/10 text-red-400 ring-1 ring-red-500/20">
        <ImageOff size={24} />
      </span>
      <h2 className="text-sm font-semibold text-neutral-200">Couldn't load gallery</h2>
      <p className="mt-1 max-w-xs break-words text-xs text-neutral-500">
        {getUserErrorMessage(error, 'Check your connection and try again.')}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex items-center gap-2 rounded-lg bg-white/5 px-3 py-1.5 text-xs font-medium text-neutral-200 ring-1 ring-white/10 transition hover:bg-white/10"
      >
        <RefreshCw size={13} />
        Retry
      </button>
    </div>
  )
}
