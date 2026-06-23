import { useState, useMemo, useEffect, useRef } from 'react'
import { ImageOff, Loader2, RefreshCw, LayoutGrid, Image as ImageIcon, Film } from 'lucide-react'
import { Topbar } from '../components/Topbar'
import { PhotoGrid } from '../components/PhotoGrid'
import { useGallery } from '../hooks/useGallery'
import { useUploadContext } from '../context/useUploadContext'

export function Gallery() {
  const { entries, thumbs, loading, error, reload } = useGallery()
  const { isUploading } = useUploadContext()
  const [filter, setFilter] = useState('all')

  // Auto-reload when background upload finishes
  const wasUploadingRef = useRef(false)
  useEffect(() => {
    if (wasUploadingRef.current && !isUploading) {
      void reload()
    }
    wasUploadingRef.current = isUploading
  }, [isUploading, reload])

  // Filter entries locally based on tab
  const filteredEntries = useMemo(() => {
    if (filter === 'photos') return entries.filter((e) => e.type === 'image')
    if (filter === 'videos') return entries.filter((e) => e.type === 'video')
    return entries
  }, [entries, filter])

  return (
    <div className="min-h-screen bg-neutral-950">
      <Topbar />

      {/* Category Tabs */}
      {entries.length > 0 && (
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

      <main className="pb-16">
        {loading && entries.length === 0 ? (
          <div className="flex justify-center py-24 text-neutral-500">
            <Loader2 className="animate-spin" size={22} />
          </div>
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : entries.length === 0 ? (
          <EmptyState />
        ) : filteredEntries.length === 0 ? (
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
          <PhotoGrid entries={filteredEntries} thumbs={thumbs} />
        )}
      </main>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 py-24 text-center">
      <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/5 text-neutral-500 ring-1 ring-white/10">
        <ImageOff size={24} />
      </span>
      <h2 className="text-sm font-semibold text-neutral-200">Your vault is empty</h2>
      <p className="mt-1 text-xs text-neutral-500">
        Upload a photo or video to get started. Everything is encrypted on your
        device before it leaves.
      </p>
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
        {error.message}
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
