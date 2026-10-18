import { useCallback, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { VaultAccess } from '../../src/pages/VaultAccess.jsx'
import { VaultCredentials } from '../../src/components/VaultCredentials.jsx'
import { useAutoLock } from '../../src/hooks/useAutoLock.js'
import { encryptObject, decryptObject } from '../../src/crypto/v2/objects.js'
import { utf8 } from '../../src/crypto/v2/binary.js'
import { shutdownPool } from '../../src/workers/cryptoWorkerPool.js'
import '../../src/index.css'

let keyring = null
let encryptedManifest
let apiToken
let commits = 0
let downloads = 0
const adapter = {
  loadKeyring: async () => keyring ? structuredClone(keyring) : null,
  getApiToken: () => apiToken,
  downloadFile() { downloads += 1 },
  async createVault(candidate) {
    if (keyring) throw new Error('Vault already exists')
    keyring = structuredClone(candidate.keyring)
    apiToken = candidate.apiToken
    encryptedManifest = await encryptObject(utf8('synthetic manifest'), candidate.session.keys.manifest, { vaultId: keyring.vault_id, kind: 'manifest' })
    commits += 1
  },
  async verifyUnlock(session) {
    const clear = await decryptObject(encryptedManifest, session.keys.manifest, { vaultId: keyring.vault_id, kind: 'manifest' })
    if (new TextDecoder().decode(clear) !== 'synthetic manifest') throw new Error('Invalid manifest')
  },
  async replaceKeyring(candidate) {
    if (candidate.keyring.generation !== keyring.generation + 1) throw new Error('Stale keyring')
    keyring = structuredClone(candidate.keyring)
    commits += 1
  },
}

export default function Harness() {
  const [session, setSession] = useState(null)
  const [settings, setSettings] = useState(false)
  const lock = useCallback(() => { shutdownPool(); setSession(null); setSettings(false) }, [])
  useAutoLock(Boolean(session), lock)
  if (!session) return <VaultAccess adapter={adapter} onUnlocked={setSession} />
  return <main className="min-h-screen bg-neutral-950 p-6 text-white">
    <h1>Test vault unlocked</h1>
    <p>Generation {session.generation}; {commits} commits; {downloads} simulated downloads.</p>
    {session.deviceWarning && <p role="alert">{session.deviceWarning}</p>}
    <button className="m-2 rounded bg-sky-700 p-2" onClick={lock}>Lock test vault</button>
    <button className="m-2 rounded bg-sky-700 p-2" onClick={() => setSettings(true)}>Security settings</button>
    {settings && <VaultCredentials adapter={adapter} session={session} onUpdated={setSession} onClose={() => setSettings(false)} />}
  </main>
}
createRoot(document.querySelector('#root')).render(<Harness />)
