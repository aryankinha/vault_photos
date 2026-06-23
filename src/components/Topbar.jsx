import { useNavigate, useLocation } from 'react-router-dom'
import { Lock, Upload, LayoutGrid } from 'lucide-react'
import { clearActiveKey } from '../crypto/keyDerivation'
import { clearCache } from '../session/cache'

export function Topbar({ title = 'VaultPhotos' }) {
  const navigate = useNavigate()
  const location = useLocation()
  const isUploadPage = location.pathname === '/upload'

  function handleLock() {
    clearActiveKey()
    void clearCache()
    navigate('/unlock', { replace: true })
  }

  return (
    <header className="sticky top-0 z-20 border-b border-white/10 bg-neutral-950/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
        <h1 className="text-sm font-semibold tracking-tight text-neutral-100">{title}</h1>
        <div className="flex items-center gap-1">
          {isUploadPage ? (
            <button
              type="button"
              onClick={() => navigate('/gallery')}
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-neutral-200 transition hover:bg-white/10"
              aria-label="Gallery"
            >
              <LayoutGrid size={15} />
              <span className="hidden sm:inline">Gallery</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => navigate('/upload')}
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-neutral-200 transition hover:bg-white/10"
              aria-label="Upload"
            >
              <Upload size={15} />
              <span className="hidden sm:inline">Upload</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleLock}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-neutral-300 transition hover:bg-white/10"
            aria-label="Lock vault"
          >
            <Lock size={15} />
            <span className="hidden sm:inline">Lock</span>
          </button>
        </div>
      </div>
    </header>
  )
}
