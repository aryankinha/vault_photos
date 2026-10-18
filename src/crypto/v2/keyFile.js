import { exactFields, fromHex, toBase64 } from './binary.js'
import { decodeSecret } from './secrets.js'

export function generateApiToken() {
  const raw = crypto.getRandomValues(new Uint8Array(32))
  try { return toBase64(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
  finally { raw.fill(0) }
}

export function parseSecretKeyFile(text, expectedVaultId) {
  if (typeof text !== 'string' || text.length > 8192) throw new Error('Invalid Secret Key file')
  const file = JSON.parse(text)
  exactFields(file, ['format', 'vault_id', 'secret_key', 'api_token'])
  if (file.format !== 'VPKEY2') throw new Error('Invalid Secret Key file')
  fromHex(file.vault_id, 16)
  if (expectedVaultId && file.vault_id !== expectedVaultId) throw new Error('This key file belongs to a different vault')
  if (typeof file.api_token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(file.api_token)) throw new Error('Invalid API token')
  const decoded = decodeSecret(file.secret_key, 'secret')
  decoded.fill(0)
  return { format: file.format, vault_id: file.vault_id, secret_key: file.secret_key, api_token: file.api_token }
}

export function serializeSecretKeyFile(vaultId, secretKeyText, apiToken) {
  const text = JSON.stringify({ format: 'VPKEY2', vault_id: vaultId, secret_key: secretKeyText, api_token: apiToken }, null, 2)
  parseSecretKeyFile(text, vaultId)
  return text
}

export function secretKeyFilename(vaultId) {
  fromHex(vaultId, 16)
  return `VaultPhotos-SecretKey-${vaultId.slice(0, 8)}.vpkey`
}
