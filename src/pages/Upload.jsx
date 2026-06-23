import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { UploadCloud, Plus } from 'lucide-react'
import { Topbar } from '../components/Topbar'
import { UploadProgress } from '../components/UploadProgress'
import { useUpload } from '../hooks/useUpload'

export function Upload() {
  const navigate = useNavigate()
  const inputRef = useRef(null)
  const [queue, setQueue] = useState([]) // [{ id, file, status, error }]
  const { upload, STATUS } = useUpload()
  const [doneCount, setDoneCount] = useState(0)

  async function handleFiles(fileList) {
    const files = Array.from(fileList).filter(
      (f) => f.type.startsWith('image/') || f.type.startsWith('video/'),
    )
    if (files.length === 0) return

    const pending = files.map((file) => ({
      id: `${file.name}-${file.size}-${file.lastModified}`,
      file,
      status: STATUS.IDLE,
      error: null,
    }))
    setQueue((prev) => [...pending, ...prev])

    for (const item of pending) {
      setQueue((prev) =>
        prev.map((q) =>
          q.id === item.id ? { ...q, status: STATUS.READING, error: null } : q,
        ),
      )
      try {
        await upload(item.file)
        setDoneCount((c) => c + 1)
        setQueue((prev) =>
          prev.map((q) => (q.id === item.id ? { ...q, status: STATUS.DONE } : q)),
        )
      } catch (e) {
        setQueue((prev) =>
          prev.map((q) =>
            q.id === item.id ? { ...q, status: STATUS.ERROR, error: e } : q,
          ),
        )
      }
    }
  }

  function finish() {
    navigate('/gallery')
  }

  const allDone =
    queue.length > 0 && queue.every((q) => q.status === STATUS.DONE)

  return (
    <div className="min-h-screen bg-neutral-950">
      <Topbar title="Upload" />
      <main className="mx-auto max-w-2xl px-4 py-6">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="flex w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-white/15 bg-neutral-900/40 py-12 text-neutral-400 transition hover:border-white/25 hover:bg-neutral-900/70"
        >
          <UploadCloud size={26} />
          <span className="text-sm font-medium text-neutral-200">
            Choose photos or videos
          </span>
          <span className="text-xs text-neutral-500">
            Files are encrypted on this device before upload.
          </span>
        </button>

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

        {queue.length > 0 && (
          <div className="mt-6 space-y-3">
            <div className="flex items-center justify-between px-1">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                {doneCount} of {queue.length} done
              </h3>
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="inline-flex items-center gap-1 text-xs font-medium text-sky-400 hover:text-sky-300"
              >
                <Plus size={13} /> Add more
              </button>
            </div>

            {queue.map((item) => (
              <UploadProgress
                key={item.id}
                status={item.status}
                fileName={item.file.name}
                error={item.error}
              />
            ))}

            {allDone && (
              <button
                type="button"
                onClick={finish}
                className="w-full rounded-lg bg-sky-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-sky-400"
              >
                Done — view gallery
              </button>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
