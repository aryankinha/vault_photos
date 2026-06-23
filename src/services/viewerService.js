/**
 * Viewer orchestration: fetch a single encrypted media file, decrypt it, and
 * hand back an object URL the caller can bind to an <img>/<video>. The caller
 * owns the URL's lifetime (the hook revokes on cleanup).
 */
import { decryptPacked } from '../crypto/decrypt'
import { getActiveKey } from '../crypto/keyDerivation'
import * as worker from '../storage/workerClient'

export async function loadFullMedia(id, mimeType) {
  const buffer = await worker.getFile(id)
  const decrypted = await decryptPacked(buffer, getActiveKey())
  const blob = new Blob([decrypted], { type: mimeType || 'application/octet-stream' })
  return URL.createObjectURL(blob)
}
