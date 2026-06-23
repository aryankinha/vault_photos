import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ShieldCheck, Loader2, AlertTriangle } from 'lucide-react'
import { unlockWithPassphrase } from '../crypto/keyDerivation'
import { getSalt, uploadSalt } from '../storage/workerClient'
import { decryptPacked } from '../crypto/decrypt'
import { getManifest } from '../storage/workerClient'
import { clearCache } from '../session/cache'

export function Unlock() {
  const navigate = useNavigate()
  const [mode, setMode] = useState('checking') // 'checking' | 'create' | 'unlock'
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // On mount, probe the worker for a salt. Missing salt = first run (create mode).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        await getSalt()
        if (!cancelled) setMode('unlock')
      } catch (e) {
        if (cancelled) return
        if (e.status === 404) setMode('create')
        else setError(e)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handleSubmit = useCallback(
    async (event) => {
      event.preventDefault()
      if (busy) return
      setBusy(true)
      setError(null)

      try {
        if (mode === 'create') {
          if (passphrase.length < 8) {
            throw new Error('Passphrase must be at least 8 characters')
          }
          if (passphrase !== confirm) {
            throw new Error('Passphrases do not match')
          }
          const salt = crypto.getRandomValues(new Uint8Array(16))
          await uploadSalt(salt)
          await unlockWithPassphrase(passphrase, salt)
          // Fresh vault — clear any stale cache from a prior session.
          await clearCache()
          navigate('/gallery', { replace: true })
          return
        }

        // Unlock mode: fetch salt, derive key, verify against the manifest.
        const salt = await getSalt()
        const key = await unlockWithPassphrase(passphrase, salt)
        // Confirm the passphrase is correct by decrypting something real.
        try {
          const manifestBytes = await getManifest()
          await decryptPacked(manifestBytes, key)
        } catch {
          throw new WrongPassphraseError()
        }
        navigate('/gallery', { replace: true })
      } catch (e) {
        setError(e)
      } finally {
        setBusy(false)
      }
    },
    [busy, mode, passphrase, confirm, navigate],
  )

  const isCreate = mode === 'create'

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-neutral-950 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/5 text-neutral-100 ring-1 ring-white/10">
            <ShieldCheck size={22} />
          </span>
          <h1 className="text-lg font-semibold text-neutral-100">VaultPhotos</h1>
          <p className="mt-1 text-xs text-neutral-400">
            {mode === 'checking'
              ? 'Checking vault…'
              : isCreate
                ? 'Create a passphrase to encrypt your vault'
                : 'Enter your passphrase to unlock'}
          </p>
        </div>

        {mode !== 'checking' && (
          <form
            onSubmit={handleSubmit}
            className="space-y-3 rounded-2xl border border-white/10 bg-neutral-900/60 p-5"
          >
            <input
              type="password"
              autoComplete={isCreate ? 'new-password' : 'current-password'}
              placeholder="Passphrase"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoFocus
              className="w-full rounded-lg border border-white/10 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-sky-500/50"
            />
            {isCreate && (
              <input
                type="password"
                autoComplete="new-password"
                placeholder="Confirm passphrase"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-sky-500/50"
              />
            )}

            {error && (
              <div className="flex items-start gap-2 rounded-lg bg-red-500/10 p-2 text-xs text-red-300">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span className="break-words">{error.message}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={busy || passphrase.length === 0}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-sky-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy && <Loader2 size={15} className="animate-spin" />}
              {isCreate ? 'Create vault' : 'Unlock'}
            </button>
          </form>
        )}

        {mode === 'checking' && (
          <div className="flex justify-center text-neutral-500">
            <Loader2 className="animate-spin" size={20} />
          </div>
        )}

        <p className="mt-4 text-center text-[11px] leading-relaxed text-neutral-600">
          Your passphrase is never stored or transmitted. It only lives in memory
          while the vault is unlocked.
        </p>
      </div>
    </div>
  )
}

class WrongPassphraseError extends Error {
  constructor() {
    super('Wrong passphrase. Try again.')
    this.name = 'WrongPassphraseError'
  }
}
