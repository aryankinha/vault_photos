import { useEffect, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { deleteMedia } from '../services/deleteService'

export function DeleteMediaButton({ entry, onDeleted }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])
  if (!entry) return null
  const remove = async () => {
    if (busy || !window.confirm(`Remove “${entry.name}” from this vault?\n\nOld repository revisions and encrypted thumbnail pages may still retain copies. This is not secure erasure.`)) return
    setBusy(true)
    setError(null)
    try {
      await deleteMedia(entry.id)
      if (active.current) onDeleted()
    } catch {
      if (!active.current) return
      setError('Unable to remove this item. Check your connection and retry.')
      setBusy(false)
    }
  }
  return (
    <div className="ml-auto flex items-center gap-2">
      {error && <span role="alert" className="max-w-56 text-xs text-red-300">{error}</span>}
      <button
        type="button" disabled={busy} onClick={remove}
        aria-label={`Delete ${entry.name}`}
        className="rounded-full p-2 text-neutral-400 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-40"
      >
        <Trash2 size={15} />
      </button>
    </div>
  )
}
