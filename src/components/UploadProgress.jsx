import { Check, Loader2, X } from 'lucide-react'

const STEPS = [
  { key: 'reading', label: 'Reading file' },
  { key: 'encrypting', label: 'Encrypting' },
  { key: 'uploading', label: 'Uploading' },
  { key: 'finalizing', label: 'Saving to vault' },
]

const ORDER = ['reading', 'encrypting', 'uploading', 'finalizing', 'done']

export function UploadProgress({ status, fileName, error, percent }) {
  const failed = status === 'error'
  const currentIdx = ORDER.indexOf(status)

  return (
    <div className="rounded-xl border border-white/10 bg-neutral-900/60 p-4">
      <div className="mb-3 truncate text-xs font-medium text-neutral-200">
        {fileName || 'Uploading…'}
      </div>

      <ol className="space-y-2">
        {STEPS.map((step) => {
          const stepIdx = ORDER.indexOf(step.key)
          const isDone = !failed && currentIdx > stepIdx
          const isActive = !failed && status === step.key
          return (
            <li key={step.key} className="flex items-center gap-2 text-xs">
              <span className="flex h-4 w-4 items-center justify-center">
                {isDone ? (
                  <Check size={14} className="text-emerald-400" />
                ) : isActive ? (
                  <Loader2 size={14} className="animate-spin text-sky-400" />
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-neutral-600" />
                )}
              </span>
              <span
                className={
                  isDone || isActive ? 'text-neutral-100' : 'text-neutral-500'
                }
              >
                {step.label}
                {step.key === 'uploading' && isActive && percent != null && (
                  <span className="ml-1 text-neutral-400">
                    {Math.round(percent * 100)}%
                  </span>
                )}
              </span>
            </li>
          )
        })}
      </ol>

      {failed && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-red-500/10 p-2 text-xs text-red-300">
          <X size={14} className="mt-0.5 shrink-0" />
          <span className="break-words">{error?.message || 'Upload failed'}</span>
        </div>
      )}
    </div>
  )
}
