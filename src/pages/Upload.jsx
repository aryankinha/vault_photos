/**
 * Upload page — V2 + drag-drop & clipboard.
 *
 * The page is a thin trigger. It hands files to UploadContext.startBatch()
 * and shows a lightweight confirmation. All progress tracking lives in
 * PersistentUploadBar (visible on every route). The user can navigate away
 * immediately after tapping "Upload" — the bottom bar keeps them informed.
 *
 * V4 adds:
 *   - Drag-and-drop: files can be dragged onto the drop zone.
 *   - Clipboard paste: pasting images (e.g. screenshots) from the clipboard.
 *   - Unsupported feedback: files that are not images/videos are rejected
 *     with a visible message.
 */
import { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { UploadCloud, CheckCircle2, ArrowRight, X, ClipboardPaste, AlertCircle } from 'lucide-react'
import { Topbar } from '../components/Topbar'
import { useUploadContext } from '../context/useUploadContext'

const ACCEPTED_TYPES = ['image/', 'video/']

export function Upload() {
  const navigate = useNavigate()
  const inputRef = useRef(null)
  const [started, setStarted] = useState(false)
  const [fileCount, setFileCount] = useState(0)
  const { startBatch, isUploading, cancelBatch } = useUploadContext()

  // Drag-drop state
  const [dragOver, setDragOver] = useState(false)
  const [unsupportedFiles, setUnsupportedFiles] = useState([])
  const [showUnsupported, setShowUnsupported] = useState(false)
  const dragDepthRef = useRef(0)

  const filterFiles = useCallback((fileList) => {
    const files = Array.from(fileList || [])
    const accepted = []
    const rejected = []
    for (const f of files) {
      if (ACCEPTED_TYPES.some((prefix) => f.type.startsWith(prefix))) {
        accepted.push(f)
      } else {
        rejected.push(f.name || 'Unknown file')
      }
    }
    return { accepted, rejected }
  }, [])

  const handleFiles = useCallback(async (fileList) => {
    const { accepted, rejected } = filterFiles(fileList)
    if (rejected.length > 0) {
      setUnsupportedFiles(rejected)
      setShowUnsupported(true)
      setTimeout(() => setShowUnsupported(false), 4000)
    }
    if (accepted.length === 0) return

    setFileCount((prev) => prev + accepted.length)
    setStarted(true)

    // Hand off to context — this returns immediately; upload runs in background.
    startBatch(accepted)
  }, [filterFiles, startBatch])

  // ── Clipboard paste ──────────────────────────────────────────────────────
  const handlePaste = useCallback((e) => {
    const items = e.clipboardData?.items
    if (!items) return
    const files = []
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    if (files.length > 0) {
      e.preventDefault()
      void handleFiles(files)
    }
  }, [handleFiles])

  // ── Drag-and-drop ────────────────────────────────────────────────────────
  function handleDragEnter(e) {
    e.preventDefault()
    dragDepthRef.current += 1
    if (e.dataTransfer?.types?.includes('Files')) {
      setDragOver(true)
    }
  }

  function handleDragLeave(e) {
    e.preventDefault()
    dragDepthRef.current -= 1
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0
      setDragOver(false)
    }
  }

  function handleDragOver(e) {
    e.preventDefault()
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy'
    }
  }

  function handleDrop(e) {
    e.preventDefault()
    dragDepthRef.current = 0
    setDragOver(false)
    void handleFiles(e.dataTransfer?.files)
  }

  return (
    <div
      className="min-h-screen bg-neutral-950 pb-24"
      onPaste={handlePaste}
    >
      <Topbar title="Upload" />
      <main className="mx-auto max-w-2xl px-4 py-6">

        {/* Unsupported file feedback */}
        {showUnsupported && unsupportedFiles.length > 0 && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2">
            <AlertCircle size={15} className="mt-0.5 shrink-0 text-amber-400" />
            <div>
              <p className="text-xs font-medium text-amber-200">
                {unsupportedFiles.length} file{unsupportedFiles.length === 1 ? '' : 's'} not supported
              </p>
              <p className="mt-0.5 text-[10px] text-amber-200/60">
                Only image and video files can be uploaded.{' '}
                {unsupportedFiles.slice(0, 3).join(', ')}
                {unsupportedFiles.length > 3 ? ` and ${unsupportedFiles.length - 3} more` : ''}
              </p>
            </div>
          </div>
        )}

        {!started ? (
          /* — Pick files — */
          <>
            <div
              role="button"
              tabIndex={0}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click() }}
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              className={`flex w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed py-16 text-neutral-400 transition ${
                dragOver
                  ? 'border-sky-400/60 bg-sky-500/10 text-sky-300'
                  : 'border-white/15 bg-neutral-900/40 hover:border-white/25 hover:bg-neutral-900/70'
              } ${isUploading ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
            >
              <UploadCloud size={28} />
              <span className="text-sm font-medium text-neutral-200">
                {isUploading
                  ? 'Upload in progress…'
                  : dragOver
                    ? 'Drop to upload'
                    : 'Choose photos or videos'}
              </span>
              <span className="text-xs text-neutral-500">
                Files are encrypted on this device before upload.
              </span>
              <div className="mt-2 flex items-center gap-3 text-[10px] text-neutral-600">
                <span>Drag & drop</span>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1">
                  <ClipboardPaste size={10} /> Paste from clipboard
                </span>
              </div>
            </div>

            <input
              ref={inputRef}
              id="upload-file-input"
              type="file"
              accept="image/*,video/*"
              multiple
              className="hidden"
              onChange={(e) => {
                handleFiles(e.target.files)
                e.target.value = ''
              }}
            />
          </>
        ) : (
          /* — Upload started confirmation — */
          <div className="flex flex-col items-center gap-5 py-16 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-sky-500/10 text-sky-400 ring-1 ring-sky-500/20">
              <CheckCircle2 size={28} />
            </span>
            <div>
              <p className="text-sm font-semibold text-neutral-100">
                Upload started
              </p>
              <p className="mt-1 text-xs text-neutral-500">
                {fileCount} {fileCount === 1 ? 'file' : 'files'} — encrypting and uploading in the
                background. You can navigate anywhere; the progress bar at the bottom keeps you
                updated.
              </p>
            </div>

            <button
              id="upload-go-gallery-btn"
              type="button"
              onClick={() => navigate('/gallery')}
              className="inline-flex items-center gap-2 rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-400"
            >
              Go to gallery <ArrowRight size={15} />
            </button>

            {/* Let the user add more files even while uploading */}
            <button
              id="upload-add-more-btn"
              type="button"
              onClick={() => {
                setStarted(false)
                setTimeout(() => inputRef.current?.click(), 50)
              }}
              className="text-xs text-neutral-500 hover:text-neutral-300 transition"
            >
              Add more files
            </button>

            {isUploading && (
              <button
                id="upload-cancel-btn"
                type="button"
                onClick={() => {
                  cancelBatch()
                  setStarted(false)
                }}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-red-300 ring-1 ring-red-500/25 transition hover:bg-red-500/10"
              >
                <X size={14} /> Cancel upload
              </button>
            )}
          </div>
        )}
      </main>

      {/* Hidden input re-used for "add more" */}
      {started && (
        <input
          ref={inputRef}
          type="file"
          accept="image/*,video/*"
          multiple
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files)
            e.target.value = ''
          }}
        />
      )}
    </div>
  )
}
