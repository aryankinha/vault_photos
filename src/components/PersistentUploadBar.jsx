/**
 * PersistentUploadBar — fixed bottom progress bar shown during any active upload.
 *
 * Reads from UploadContext so it stays visible regardless of which route the
 * user is on. Renders nothing when isUploading is false.
 *
 * Visual layout:
 *   ┌───────────────────────────────────────────────────────────┐
 *   │  Uploading beach.jpg (3 of 8)              1 min 42 sec   │
 *   │  ███████████████░░░░░░░░░░░░░░░░░░░░░░░░░  38%   2 failed │
 *   └───────────────────────────────────────────────────────────┘
 */
import { useUploadContext } from '../context/useUploadContext'
import { AlertCircle } from 'lucide-react'

export function PersistentUploadBar() {
  const { isUploading, batchProgress } = useUploadContext()

  if (!isUploading && !batchProgress) return null

  const progress = batchProgress ?? {
    totalFiles: 0,
    completedFiles: 0,
    currentFile: '',
    overallPercent: 0,
    etaDisplay: 'calculating…',
    errors: [],
  }

  const {
    totalFiles,
    completedFiles,
    currentFile,
    overallPercent,
    etaDisplay,
    errors,
  } = progress

  const pct = Math.round(overallPercent * 100)
  const errorCount = errors?.length ?? 0

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Upload progress"
      className="fixed bottom-0 left-0 right-0 z-50 border-t border-white/10 bg-neutral-950/95 px-4 py-3 shadow-2xl backdrop-blur-md"
    >
      {/* Top row: filename + ETA */}
      <div className="flex items-center justify-between text-xs text-neutral-300 mb-2">
        <span className="truncate max-w-[60%]">
          {currentFile ? (
            <>
              Uploading{' '}
              <span className="font-medium text-neutral-100">{currentFile}</span>
              {totalFiles > 1 && (
                <span className="ml-1 text-neutral-500">
                  ({completedFiles + 1} of {totalFiles})
                </span>
              )}
            </>
          ) : (
            <span className="text-neutral-400">Finalising…</span>
          )}
        </span>

        <div className="flex items-center gap-3 shrink-0">
          {etaDisplay && (
            <span className="text-neutral-500">{etaDisplay}</span>
          )}
          {errorCount > 0 && (
            <span className="flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-medium text-red-400 ring-1 ring-red-500/20">
              <AlertCircle size={10} />
              {errorCount} failed
            </span>
          )}
        </div>
      </div>

      {/* Bottom row: progress bar + percent */}
      <div className="flex items-center gap-3">
        {/* Track */}
        <div className="relative flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
          <div
            className="absolute left-0 top-0 h-full rounded-full bg-sky-500 transition-[width] duration-300 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="shrink-0 text-xs font-medium tabular-nums text-neutral-400 w-8 text-right">
          {pct}%
        </span>
      </div>
    </div>
  )
}
