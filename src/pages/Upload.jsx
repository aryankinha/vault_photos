/**
 * Upload page — V2.
 *
 * The page is now a thin trigger. It hands files to UploadContext.startBatch()
 * and shows a lightweight confirmation. All progress tracking lives in
 * PersistentUploadBar (visible on every route). The user can navigate away
 * immediately after tapping "Upload" — the bottom bar keeps them informed.
 *
 * UploadProgress.jsx is kept in the codebase but is no longer used here.
 */
import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { UploadCloud, CheckCircle2, ArrowRight } from 'lucide-react'
import { Topbar } from '../components/Topbar'
import { useUploadContext } from '../context/useUploadContext'

export function Upload() {
  const navigate = useNavigate()
  const inputRef = useRef(null)
  const { startBatch, isUploading } = useUploadContext()
  const [started, setStarted] = useState(false)
  const [fileCount, setFileCount] = useState(0)

  async function handleFiles(fileList) {
    const files = Array.from(fileList).filter(
      (f) => f.type.startsWith('image/') || f.type.startsWith('video/'),
    )
    if (files.length === 0) return

    setFileCount(files.length)
    setStarted(true)

    // Hand off to context — this returns immediately; upload runs in background.
    startBatch(files)
  }

  return (
    <div className="min-h-screen bg-neutral-950 pb-24">
      <Topbar title="Upload" />
      <main className="mx-auto max-w-2xl px-4 py-6">

        {!started ? (
          /* — Pick files — */
          <>
            <button
              id="upload-drop-zone"
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={isUploading}
              className="flex w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-white/15 bg-neutral-900/40 py-16 text-neutral-400 transition hover:border-white/25 hover:bg-neutral-900/70 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <UploadCloud size={28} />
              <span className="text-sm font-medium text-neutral-200">
                {isUploading ? 'Upload in progress…' : 'Choose photos or videos'}
              </span>
              <span className="text-xs text-neutral-500">
                Files are encrypted on this device before upload.
              </span>
            </button>

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
