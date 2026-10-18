import { useEffect, useRef, useState } from 'react'
import { SaveVaultKeys } from '../components/SaveVaultKeys.jsx'
import { getRememberedSecretKey, rememberSecretKey } from '../session/deviceKeys.js'
import { parseSecretKeyFile } from '../crypto/v2/keyFile.js'
import { prepareVaultCreation, unlockVaultWithSecret, verifyRecovery, prepareCredentialChange, commitPreparedVault } from '../services/vaultLifecycle.js'

/** Adapter owns authenticated, CAS-protected storage; this screen owns secrets. */
export function VaultAccess({ adapter, onUnlocked }) {
  const [mode, setMode] = useState('checking')
  const [keyring, setKeyring] = useState(null)
  const [deviceKey, setDeviceKey] = useState(null)
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [keyText, setKeyText] = useState('')
  const [keyFile, setKeyFile] = useState('')
  const [importedName, setImportedName] = useState('')
  const [recoveryText, setRecoveryText] = useState('')
  const [recovery, setRecovery] = useState(null)
  const [candidate, setCandidate] = useState(null)
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])
  useEffect(() => {
    let active = true
    adapter.loadKeyring().then(async (value) => {
      const remembered = value ? await getRememberedSecretKey(value.vault_id).catch(() => null) : null
      if (!active) return
      setKeyring(value)
      setDeviceKey(remembered)
      setMode(value ? 'unlock' : 'create')
    }).catch(() => { if (active) { setError('Unable to load this vault. Check your connection and retry.'); setMode('error') } })
    return () => { active = false }
  }, [adapter, retry])

  const finish = (session) => {
    if (!active.current) return
    setPassphrase(''); setConfirm(''); setKeyText(''); setKeyFile('')
    setRecoveryText(''); setRecovery(null); setCandidate(null)
    onUnlocked(session)
  }
  const submit = async (event) => {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    try {
      if (mode === 'create') {
        if (passphrase !== confirm) throw new Error('Passphrases do not match')
        setCandidate(await prepareVaultCreation(passphrase))
        setPassphrase(''); setConfirm('')
      } else if (mode === 'recover') {
        const verified = await verifyRecovery({ keyring, recoveryText, adapter })
        setRecovery(verified)
        setRecoveryText('')
        setMode('recover-password')
      } else if (mode === 'recover-password') {
        if (passphrase !== confirm) throw new Error('Passphrases do not match')
        setCandidate(await prepareCredentialChange({ keyring, recoveryKey: recovery.recoveryKey,
          passphrase, mode: 'recover', apiToken: adapter.getApiToken() }))
        setPassphrase(''); setConfirm(''); setRecovery(null)
      } else {
        const session = await unlockVaultWithSecret({ keyring, passphrase, keyText, keyFile, deviceKey, adapter })
        if (remember) {
          try { await rememberSecretKey(keyring.vault_id, session.secretKey) }
          catch { session.deviceWarning = 'This browser could not remember your Secret Key. Import your key file next time.' }
        }
        finish(session)
      }
    } catch (reason) { setError(reason.message || 'Cannot unlock') }
    finally { setBusy(false) }
  }
  const commit = async () => {
    if (busy) return
    setBusy(true); setError('')
    try { finish(await commitPreparedVault(candidate, { adapter, remember })) }
    catch { setError('Unable to save. Keep your downloaded keys and retry; the server may have received the change.') }
    finally { setBusy(false) }
  }
  const importFile = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      if (file.size > 8192) throw new Error('Invalid Secret Key file')
      const text = await file.text()
      parseSecretKeyFile(text, keyring.vault_id)
      setKeyFile(text); setImportedName(file.name); setKeyText(''); setError('')
    } catch { setError('Cannot unlock'); setKeyFile(''); setImportedName('') }
  }
  const showPassphrase = ['create', 'unlock', 'recover-password'].includes(mode)
  return <main className="flex min-h-screen items-center justify-center bg-neutral-950 p-4 text-neutral-100">
    <div className="w-full max-w-lg space-y-4 rounded-2xl border border-white/10 bg-neutral-900 p-6">
      <h1 className="text-xl font-semibold">VaultPhotos</h1>
      {candidate ? <SaveVaultKeys candidate={candidate} busy={busy} error={error} downloadFile={adapter.downloadFile} onCommit={commit} onCancel={() => {
        setCandidate(null); setRecovery(null); setMode(keyring ? 'unlock' : 'create'); setError('')
      }} /> : mode === 'checking' ? <p>Checking vault…</p> : mode === 'error' ? <>
        <p role="alert">{error}</p><button onClick={() => { setMode('checking'); setRetry((value) => value + 1) }}>Retry</button>
      </> : <form onSubmit={submit} className="space-y-4">
        <p>{mode === 'create' ? 'Create a fresh encrypted vault' : mode === 'recover' ? 'Recover with your offline Recovery Key' : mode === 'recover-password' ? 'Choose a new passphrase. New Secret and Recovery Keys will be generated.' : 'Unlock with your passphrase and Secret Key'}</p>
        {showPassphrase && <label className="block text-sm">{mode === 'unlock' ? 'Passphrase' : 'New passphrase'}
          <input type="password" autoComplete={mode === 'unlock' ? 'current-password' : 'new-password'} required value={passphrase} onChange={(event) => setPassphrase(event.target.value)} className="mt-1 w-full rounded bg-black p-2" />
        </label>}
        {['create', 'recover-password'].includes(mode) && <>
          <p className="text-xs text-neutral-400">Use at least 12 characters; four or more random words are recommended.</p>
          <label className="block text-sm">Confirm passphrase<input type="password" autoComplete="new-password" required value={confirm} onChange={(event) => setConfirm(event.target.value)} className="mt-1 w-full rounded bg-black p-2" /></label>
        </>}
        {mode === 'unlock' && <div className="space-y-2">
          {deviceKey && !keyFile && !keyText ? <p>Secret Key is available on this device. <button type="button" className="underline" onClick={() => setDeviceKey(null)}>Use another key</button></p> : <label className="block text-sm">Secret Key text<input type="password" autoComplete="off" value={keyText} onChange={(event) => { setKeyText(event.target.value); setKeyFile(''); setImportedName('') }} className="mt-1 w-full rounded bg-black p-2" /></label>}
          <label className="block text-sm">Import Secret Key file<input type="file" accept=".vpkey,application/json" onChange={importFile} className="mt-1 block w-full" /></label>
          {importedName && <p className="text-xs">Loaded {importedName}</p>}
          <p className="text-xs text-neutral-400">The Secret Key stays on this device. If you clear browser data you must import it again.</p>
        </div>}
        {mode === 'recover' && <label className="block text-sm">Recovery Key<input type="password" autoComplete="off" required value={recoveryText} onChange={(event) => setRecoveryText(event.target.value)} className="mt-1 w-full rounded bg-black p-2" /></label>}
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />Remember Secret Key on this device</label>
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        <button disabled={busy} className="w-full rounded bg-sky-600 px-4 py-2 disabled:opacity-40">{busy ? 'Working…' : mode === 'unlock' ? 'Unlock' : mode === 'recover' ? 'Verify Recovery Key' : 'Continue'}</button>
        {mode === 'unlock' && <button type="button" disabled={busy} onClick={() => { setMode('recover'); setPassphrase(''); setError('') }} className="text-sm underline">Use Recovery Key instead</button>}
        {['recover', 'recover-password'].includes(mode) && <button type="button" disabled={busy} onClick={() => { setMode('unlock'); setRecovery(null); setRecoveryText(''); setPassphrase(''); setConfirm(''); setError('') }} className="block text-sm underline">Back to unlock</button>}
      </form>}
    </div>
  </main>
}
