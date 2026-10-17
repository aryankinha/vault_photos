import { useEffect, useState } from 'react'
import { connectionHeaders, setOwnerToken } from '../session/connection'

const workerUrl = import.meta.env.VITE_WORKER_URL?.replace(/\/$/, '')

export function ConnectionGate({ children }) {
  const [mode, setMode] = useState('checking')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    fetch(`${workerUrl}/auth-mode`, { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Unable to connect to the vault server.')
        const result = await response.json()
        if (active) setMode(result.mode === 'token' ? 'token' : 'ready')
      }).catch(() => { if (active) setMode('error') })
    return () => { active = false }
  }, [retry])
  if (mode === 'ready') return children
  const connect = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    setOwnerToken(code.trim())
    try {
      const response = await fetch(`${workerUrl}/vault-head`, {
        headers: connectionHeaders(), credentials: 'include',
      })
      if (!response.ok) throw new Error(response.status === 401
        ? 'That access code is incorrect.' : 'Unable to connect. Try again.')
      setCode('')
      setMode('ready')
    } catch (reason) {
      setOwnerToken('')
      setError(reason.message)
    } finally { setBusy(false) }
  }
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-950 px-4 text-neutral-100">
      <div className="w-full max-w-sm space-y-4 rounded-2xl border border-white/10 bg-neutral-900 p-6">
        <h1 className="text-lg font-semibold">VaultPhotos</h1>
        {mode === 'checking' ? <p>Connecting…</p> : mode === 'error' ? <>
          <p role="alert">Unable to reach your vault server.</p>
          <button onClick={() => setRetry((value) => value + 1)}>Retry connection</button>
        </> : <form onSubmit={connect} className="space-y-4">
          <p className="text-sm text-neutral-400">Enter your private access code to connect. Your vault passphrase is requested next.</p>
          <label className="block text-sm">Access code
            <input type="password" autoComplete="current-password" value={code}
              onChange={(event) => setCode(event.target.value)} required
              className="mt-2 w-full rounded-lg border border-white/10 bg-neutral-950 px-3 py-2" />
          </label>
          {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
          <button disabled={busy || !code.trim()} className="w-full rounded-lg bg-sky-500 px-3 py-2 font-semibold disabled:opacity-50">
            {busy ? 'Connecting…' : 'Connect to vault'}
          </button>
        </form>}
      </div>
    </main>
  )
}
