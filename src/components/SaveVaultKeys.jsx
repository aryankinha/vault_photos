import { useState } from 'react'
import { confirmSavedKey } from '../crypto/v2/secrets.js'
import { secretKeyFilename } from '../crypto/v2/keyFile.js'

function download(text, filename, type) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function SaveVaultKeys({ candidate, onCommit, onCancel, busy, error, downloadFile = download }) {
  const [secretConfirmation, setSecretConfirmation] = useState('')
  const [recoveryConfirmation, setRecoveryConfirmation] = useState('')
  const [serverConfigured, setServerConfigured] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const savedSecret = !candidate.secretKeyText || (downloaded && confirmSavedKey(candidate.secretKeyText, secretConfirmation))
  const savedRecovery = !candidate.recoveryKeyText || confirmSavedKey(candidate.recoveryKeyText, recoveryConfirmation)
  const ready = savedSecret && savedRecovery && (candidate.operation !== 'create' || serverConfigured)
  return <section className="space-y-4" aria-label="Save your vault keys">
    <h2 className="text-lg font-semibold">Save these keys before continuing</h2>
    <p className="text-sm text-neutral-300">These keys are shown once. Keep the Secret Key file and Recovery Key in two separate safe places. Your passphrase is separate.</p>
    {candidate.secretKeyText && <div className="space-y-2">
      <h3 className="font-semibold">Secret Key</h3>
      <code className="block break-all rounded bg-black p-3 text-sm" data-testid="new-secret-key">{candidate.secretKeyText}</code>
      <button type="button" className="rounded bg-sky-600 px-3 py-2" onClick={() => {
        downloadFile(candidate.keyFile, secretKeyFilename(candidate.keyring.vault_id), 'application/json')
        setDownloaded(true)
      }}>Download Secret Key file</button>
      <label className="block text-sm">Last two groups of your Secret Key
        <input autoComplete="off" value={secretConfirmation} onChange={(event) => setSecretConfirmation(event.target.value)} className="mt-1 w-full rounded bg-black p-2" />
      </label>
    </div>}
    {candidate.recoveryKeyText && <div className="space-y-2">
      <h3 className="font-semibold">Recovery Key</h3>
      <code className="block break-all rounded bg-black p-3 text-sm" data-testid="new-recovery-key">{candidate.recoveryKeyText}</code>
      <p className="text-xs text-neutral-400">Print or write this down and store it offline, away from the Secret Key file. It can unlock the vault on its own.</p>
      <button type="button" className="rounded bg-white/10 px-3 py-2" onClick={() => downloadFile(candidate.recoveryKeyText, `VaultPhotos-RecoveryKey-${candidate.keyring.vault_id.slice(0, 8)}.txt`, 'text/plain')}>Download Recovery Key separately</button>
      <label className="block text-sm">Last two groups of your Recovery Key
        <input autoComplete="off" value={recoveryConfirmation} onChange={(event) => setRecoveryConfirmation(event.target.value)} className="mt-1 w-full rounded bg-black p-2" />
      </label>
    </div>}
    {candidate.operation === 'create' && <div className="space-y-2 rounded border border-amber-500/30 p-3 text-sm">
      <h3 className="font-semibold">Connect this new vault to its server</h3>
      <p>The key file includes a random server access token. Configure its verifier as the Worker secret AUTH_TOKEN_SHA256 before creating the vault. Only this verifier goes to Cloudflare.</p>
      <code id="api-verifier" className="block break-all">{candidate.apiVerifier}</code>
      <label className="flex gap-2"><input type="checkbox" checked={serverConfigured} onChange={(event) => setServerConfigured(event.target.checked)} />I configured this vault&apos;s server verifier.</label>
    </div>}
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    <div className="flex gap-3">
      <button disabled={busy || !ready} type="button" onClick={onCommit} className="rounded bg-sky-600 px-4 py-2 disabled:opacity-40">{busy ? 'Saving…' : 'I saved my keys — continue'}</button>
      <button disabled={busy} type="button" onClick={onCancel} className="rounded bg-white/10 px-3 py-2">Cancel</button>
    </div>
  </section>
}
