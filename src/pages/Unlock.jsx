import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ShieldCheck, Loader2, AlertTriangle } from 'lucide-react'
import { unlockWithPassphrase } from '../crypto/keyDerivation'
import { clearActiveKey } from '../crypto/keyDerivation'
import { estimatePassphraseStrength, validateNewPassphrase } from '../crypto/passphrasePolicy'
import { getSalt, initializeVault } from '../storage/workerClient'
import { decryptPacked } from '../crypto/decrypt'
import { encryptPacked } from '../crypto/encrypt'
import { getManifest } from '../storage/workerClient'
import { clearCache } from '../session/cache'
import { createEmptyManifest } from '../schema/manifestSchema'
import { createEmptyBundle } from '../schema/bundleSchema'
import { parseManifestBytes, serializeManifestCompressed } from '../storage/manifest'
import { getUserErrorMessage, UserFacingError } from '../utils/errors'

export function Unlock() {
  const navigate = useNavigate()
  const [mode, setMode] = useState('checking') // 'checking' | 'create' | 'unlock'
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [probeKey, setProbeKey] = useState(0)

  // Entropy guidance for the CREATE flow only — informational, never gates
  // unlock of an existing vault.
  const strength = useMemo(
    () => estimatePassphraseStrength(passphrase),
    [passphrase],
  )

  // On mount, probe the worker for a salt. Missing salt = first run (create mode).
  useEffect(() => {
    let cancelled = false
    Promise.resolve().then(async () => {
      if (cancelled) return
      setMode('checking')
      setError(null)
      try {
        await getSalt()
        if (!cancelled) setMode('unlock')
      } catch (e) {
        if (cancelled) return
        if (e.status === 404) setMode('create')
        else {
          setMode('error')
          setError(getUserErrorMessage(e, 'Unable to reach your vault. Check your connection and try again.'))
        }
      }
    })
    return () => {
      cancelled = true
    }
  }, [probeKey])

  const handleSubmit = useCallback(
    async (event) => {
      event.preventDefault()
      if (busy) return
      setBusy(true)
      setError(null)

      try {
        if (mode === 'create') {
          // New-vault policy only (audit S2): min 12 chars + local common-password
          // rejection. NEVER applied on unlock — existing vaults keep working
          // with the passphrase they were created with.
          const policy = validateNewPassphrase(passphrase)
          if (!policy.ok) {
            throw new UserFacingError(policy.errors[0])
          }
          if (passphrase !== confirm) {
            throw new UserFacingError('Passphrases do not match')
          }
          const salt = crypto.getRandomValues(new Uint8Array(16))
          const key = await unlockWithPassphrase(passphrase, salt)
          await initializeEncryptedVault(salt, key)
          // Fresh vault — clear any stale cache from a prior session.
          await clearCache()
          navigate('/gallery', { replace: true })
          return
        }

        // Unlock mode: fetch salt, derive key, verify against the manifest.
        const salt = await getSalt()
        const key = await unlockWithPassphrase(passphrase, salt)
        let manifestBytes
        try {
          manifestBytes = await getManifest()
        } catch (networkError) {
          if (networkError.status === 404) {
            // Repair a salt-only vault left by an interrupted older setup.
            await initializeEncryptedVault(salt, key)
            navigate('/gallery', { replace: true })
            return
          }
          throw networkError
        }

        let decrypted
        try {
          decrypted = await decryptPacked(manifestBytes, key)
        } catch {
          throw new WrongPassphraseError()
        }
        await parseManifestBytes(decrypted)
        navigate('/gallery', { replace: true })
      } catch (e) {
        clearActiveKey()
        setError(getUserErrorMessage(e, 'Unable to unlock the vault. Check your connection and try again.'))
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
              : mode === 'error'
                ? 'Unable to reach your encrypted storage'
              : isCreate
                ? 'Create a passphrase to encrypt your vault'
                : 'Enter your passphrase to unlock'}
          </p>
        </div>

        {(mode === 'create' || mode === 'unlock') && (
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

            {isCreate && passphrase.length > 0 && (
              <div className="space-y-1 text-[11px] leading-relaxed">
                <StrengthMeter strength={strength} />
                {strength.suggestions.slice(0, 2).map((suggestion) => (
                  <p key={suggestion} className="text-neutral-500">{suggestion}</p>
                ))}
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 rounded-lg bg-red-500/10 p-2 text-xs text-red-300">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span className="break-words">{error}</span>
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

        {mode === 'error' && (
          <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-center">
            <div className="flex items-start justify-center gap-2 text-xs text-red-300">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span className="break-words">{error}</span>
            </div>
            <button
              type="button"
              onClick={() => setProbeKey((value) => value + 1)}
              className="mt-3 rounded-lg bg-white/10 px-3 py-2 text-xs font-semibold text-white hover:bg-white/15"
            >
              Retry
            </button>
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

class WrongPassphraseError extends UserFacingError {
  constructor() {
    super('Wrong passphrase. Try again.')
    this.name = 'WrongPassphraseError'
  }
}

const STRENGTH_STYLES = {
  weak: { label: 'Weak passphrase', text: 'text-red-300', fill: 'bg-red-500', segments: 1 },
  fair: { label: 'Fair passphrase', text: 'text-amber-300', fill: 'bg-amber-400', segments: 2 },
  strong: { label: 'Strong passphrase', text: 'text-green-300', fill: 'bg-green-500', segments: 3 },
}

function StrengthMeter({ strength }) {
  const style = STRENGTH_STYLES[strength.level] ?? STRENGTH_STYLES.weak
  return (
    <div className="flex items-center gap-2">
      <div className="flex flex-1 gap-1" aria-hidden="true">
        {[1, 2, 3].map((segment) => (
          <span
            key={segment}
            className={`h-1 flex-1 rounded-full ${segment <= style.segments ? style.fill : 'bg-white/10'}`}
          />
        ))}
      </div>
      <span className={`${style.text} font-medium`}>{style.label}</span>
    </div>
  )
}

async function initializeEncryptedVault(salt, key) {
  const manifest = createEmptyManifest()
  manifest.bundle_pages = 1
  const compressedManifest = await serializeManifestCompressed(manifest)
  const encryptedManifest = await encryptPacked(compressedManifest, key)
  const encryptedPage = await encryptPacked(createEmptyBundle(), key)
  await initializeVault(salt, encryptedManifest, encryptedPage)
}
