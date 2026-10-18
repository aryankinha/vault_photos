import { useEffect, useRef, useState } from 'react'
import { SaveVaultKeys } from './SaveVaultKeys.jsx'
import { verifyRecovery, prepareCredentialChange, commitPreparedVault, assertCurrentSession } from '../services/vaultLifecycle.js'
import { IDLE_SETTING } from '../hooks/useAutoLock.js'
import { idleMinutes } from '../utils/idlePolicy.js'

export function VaultCredentials({ adapter, session, onUpdated, onClose }) {
  const [mode, setMode] = useState('passphrase')
  const [recoveryText, setRecoveryText] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [candidate, setCandidate] = useState(null)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])
  const [minutes, setMinutes] = useState(() => {
    try { return idleMinutes(localStorage.getItem(IDLE_SETTING)) } catch { return 5 }
  })
  const commit = async (next) => {
    const updated = await commitPreparedVault(next, { adapter })
    if (!active.current) return
    setCandidate(null); setRecoveryText(''); setPassphrase(''); setConfirm('')
    onUpdated(updated)
  }
  const prepare = async (event) => {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      if (passphrase !== confirm) throw new Error('Passphrases do not match')
      const keyring = assertCurrentSession(await adapter.loadKeyring(), session)
      const verified = await verifyRecovery({ keyring, recoveryText, adapter })
      const next = await prepareCredentialChange({ keyring, recoveryKey: verified.recoveryKey,
        passphrase, secretKey: session.secretKey, mode, apiToken: adapter.getApiToken() })
      setRecoveryText(''); setPassphrase(''); setConfirm('')
      if (next.secretKeyText) setCandidate(next)
      else await commit(next)
    } catch (reason) { setError(reason.message || 'Unable to change keys') }
    finally { setBusy(false) }
  }
  return <section className="space-y-4 rounded-xl bg-neutral-900 p-5 text-neutral-100" aria-label="Vault security settings">
    <h2 className="text-lg font-semibold">Vault security</h2>
    <p className="text-sm text-neutral-300">Your Recovery Key is required to change the passphrase or Secret Key. Media is not re-encrypted.</p>
    <p className="text-xs text-amber-200">Old keyrings can remain in repository history. Someone who copied an old keyring and has its old keys can still decrypt. These changes do not revoke those copies.</p>
    {candidate ? <SaveVaultKeys candidate={candidate} busy={busy} error={error} downloadFile={adapter.downloadFile} onCancel={() => setCandidate(null)} onCommit={async () => {
      setBusy(true); setError('')
      try { await commit(candidate) } catch { setError('Unable to save. Keep your new key file and retry.') } finally { setBusy(false) }
    }} /> : <form onSubmit={prepare} className="space-y-3">
      <label className="block">Change<select value={mode} onChange={(event) => setMode(event.target.value)} className="ml-2 rounded bg-black p-2"><option value="passphrase">Passphrase</option><option value="secret">Secret Key</option></select></label>
      <label className="block">Recovery Key<input type="password" autoComplete="off" required value={recoveryText} onChange={(event) => setRecoveryText(event.target.value)} className="mt-1 w-full rounded bg-black p-2" /></label>
      <label className="block">Passphrase to use from now on<input type="password" autoComplete="new-password" required value={passphrase} onChange={(event) => setPassphrase(event.target.value)} className="mt-1 w-full rounded bg-black p-2" /></label>
      {mode === 'secret' && <p className="text-xs">Use your current passphrase if you only want to rotate the Secret Key.</p>}
      <label className="block">Confirm passphrase<input type="password" autoComplete="new-password" required value={confirm} onChange={(event) => setConfirm(event.target.value)} className="mt-1 w-full rounded bg-black p-2" /></label>
      {error && <p role="alert" className="text-red-300">{error}</p>}
      <button disabled={busy} className="rounded bg-sky-600 px-4 py-2 disabled:opacity-40">{busy ? 'Working…' : 'Update credentials'}</button>
    </form>}
    <label className="block text-sm">Lock after inactivity<select value={minutes} onChange={(event) => {
      const value = idleMinutes(event.target.value)
      try { localStorage.setItem(IDLE_SETTING, String(value)); setMinutes(value) }
      catch { setError('This browser cannot save the lock setting. The five-minute default remains active.') }
    }} className="ml-2 rounded bg-black p-2">{[1, 5, 10, 15, 30, 60].map((value) => <option key={value} value={value}>{value} minutes</option>)}</select></label>
    <p className="text-xs text-neutral-400">Hidden tabs always lock within ten minutes, even with a longer inactivity setting.</p>
    <button type="button" disabled={busy} onClick={onClose} className="text-sm underline">Close security settings</button>
  </section>
}
