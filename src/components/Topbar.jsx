import { useEffect, useRef, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Lock, Upload, LayoutGrid, Settings, Trash2, AlertTriangle, X } from 'lucide-react'
import { clearActiveKey } from '../crypto/keyDerivation'
import { clearCache, clearThumbCache, getThumbCacheStats } from '../session/cache'
import { purgePrefetchCache } from '../hooks/usePrefetch'
import {
  clearOPFSCache,
  getOPFSCacheStats,
  getOPFSQuotaStatus,
} from '../storage/opfsCache'
import { useUploadContext } from '../context/useUploadContext'

const CACHE_ON_LOCK_KEY = 'vp-cache-on-lock'

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function Topbar({ title = 'VaultPhotos' }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { lockUploadSession } = useUploadContext()
  const isUploadPage = location.pathname === '/upload'

  const [cachePanelOpen, setCachePanelOpen] = useState(false)
  const [thumbStats, setThumbStats] = useState(null)
  const [opfsStats, setOpfsStats] = useState(null)
  const [quota, setQuota] = useState(null)
  const [clearing, setClearing] = useState(false)
  const [cacheOnLock, setCacheOnLock] = useState(
    () => localStorage.getItem(CACHE_ON_LOCK_KEY) === '1',
  )
  const panelRef = useRef(null)

  // Load cache stats when the panel opens
  useEffect(() => {
    if (!cachePanelOpen) return
    let cancelled = false
    async function loadStats() {
      const [thumb, opfs, q] = await Promise.all([
        getThumbCacheStats().catch(() => null),
        getOPFSCacheStats().catch(() => null),
        getOPFSQuotaStatus().catch(() => null),
      ])
      if (cancelled) return
      setThumbStats(thumb)
      setOpfsStats(opfs)
      setQuota(q)
    }
    loadStats()
    return () => { cancelled = true }
  }, [cachePanelOpen])

  // Close panel on outside click
  useEffect(() => {
    if (!cachePanelOpen) return
    const handler = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        setCachePanelOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [cachePanelOpen])

  async function handleLock() {
    // Clear thumb cache if the user opted in
    if (cacheOnLock) {
      await clearThumbCache().catch(() => {})
    }
    lockUploadSession()
    clearActiveKey()
    purgePrefetchCache()
    await clearCache().catch(() => {})
    navigate('/unlock', { replace: true })
  }

  function toggleCacheOnLock() {
    const next = !cacheOnLock
    setCacheOnLock(next)
    localStorage.setItem(CACHE_ON_LOCK_KEY, next ? '1' : '0')
  }

  async function handleClearThumbCache() {
    setClearing(true)
    try {
      await clearThumbCache()
      setThumbStats({ count: 0, estimatedBytes: 0 })
    } catch {
      // Non-fatal
    } finally {
      setClearing(false)
    }
  }

  async function handleClearOpfsCache() {
    setClearing(true)
    try {
      await clearOPFSCache()
      setOpfsStats({ count: 0, totalBytes: 0 })
    } catch {
      // Non-fatal
    } finally {
      setClearing(false)
    }
  }

  const quotaWarning = quota && quota.percentUsed > 0.8

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

          {/* Cache settings */}
          <div className="relative" ref={panelRef}>
            <button
              type="button"
              onClick={() => setCachePanelOpen((o) => !o)}
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-neutral-200 transition hover:bg-white/10"
              aria-label="Cache settings"
              aria-expanded={cachePanelOpen}
            >
              <Settings size={15} />
              <span className="hidden sm:inline">Cache</span>
            </button>

            {cachePanelOpen && (
              <div className="absolute right-0 top-full mt-2 w-72 rounded-xl border border-white/10 bg-neutral-900 p-4 shadow-2xl">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-xs font-semibold text-neutral-200">Cache Settings</h2>
                  <button
                    type="button"
                    onClick={() => setCachePanelOpen(false)}
                    className="text-neutral-500 hover:text-neutral-300"
                    aria-label="Close"
                  >
                    <X size={14} />
                  </button>
                </div>

                {/* Thumb cache */}
                <div className="mb-3 rounded-lg bg-white/5 p-3">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[11px] font-medium text-neutral-300">Thumb cache</span>
                    <button
                      type="button"
                      onClick={() => void handleClearThumbCache()}
                      disabled={clearing || !thumbStats || thumbStats.count === 0}
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-red-300 transition hover:bg-red-500/10 disabled:opacity-40"
                    >
                      <Trash2 size={10} /> Clear
                    </button>
                  </div>
                  <p className="text-[10px] text-neutral-500">
                    {thumbStats
                      ? `${thumbStats.count} files · ${formatBytes(thumbStats.estimatedBytes)}`
                      : 'Loading…'}
                  </p>
                </div>

                {/* OPFS cache */}
                <div className="mb-3 rounded-lg bg-white/5 p-3">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[11px] font-medium text-neutral-300">Media cache (OPFS)</span>
                    <button
                      type="button"
                      onClick={() => void handleClearOpfsCache()}
                      disabled={clearing || !opfsStats || opfsStats.count === 0}
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-red-300 transition hover:bg-red-500/10 disabled:opacity-40"
                    >
                      <Trash2 size={10} /> Clear
                    </button>
                  </div>
                  <p className="text-[10px] text-neutral-500">
                    {opfsStats
                      ? `${opfsStats.count} files · ${formatBytes(opfsStats.totalBytes)}`
                      : 'Loading…'}
                  </p>
                </div>

                {/* Storage quota */}
                {quota && quota.quota > 0 && (
                  <div className="mb-3 rounded-lg bg-white/5 p-3">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-[11px] font-medium text-neutral-300">Storage</span>
                      <span className="text-[10px] text-neutral-500">
                        {formatBytes(quota.usage)} / {formatBytes(quota.quota)}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                      <div
                        className={`h-full rounded-full transition-all ${
                          quota.percentUsed > 0.9
                            ? 'bg-red-500'
                            : quota.percentUsed > 0.8
                              ? 'bg-amber-500'
                              : 'bg-sky-500'
                        }`}
                        style={{ width: `${Math.min(quota.percentUsed * 100, 100)}%` }}
                      />
                    </div>
                    {quotaWarning && (
                      <p className="mt-1.5 flex items-center gap-1 text-[10px] text-amber-400">
                        <AlertTriangle size={10} />
                        Storage is {Math.round(quota.percentUsed * 100)}% full
                      </p>
                    )}
                  </div>
                )}

                {/* Persistent opt-in */}
                <label className="flex cursor-pointer items-center gap-2 rounded-lg bg-white/5 p-3">
                  <input
                    type="checkbox"
                    checked={cacheOnLock}
                    onChange={toggleCacheOnLock}
                    className="h-3.5 w-3.5 rounded border-white/20 bg-neutral-800 accent-sky-500"
                  />
                  <span className="text-[11px] text-neutral-300">
                    Clear thumb cache on lock
                  </span>
                </label>
              </div>
            )}
          </div>

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
