/**
 * Upload orchestration. Reads a File end to end: extracts metadata, builds a
 * thumbnail, encrypts the full media, uploads it, appends the thumbnail to the
 * bundle, and records the manifest entry. Emits progress events for the hook.
 *
 * Two upload paths, chosen by encrypted size:
 *   <  DIRECT_UPLOAD_THRESHOLD → proxy through the worker (workerClient.uploadFile)
 *   >= DIRECT_UPLOAD_THRESHOLD → direct-to-S3 (preauth → browser XHR PUT → commit)
 *
 * Progress callback receives one of:
 *   { phase: 'reading' | 'encrypting' | 'done' }
 *   { phase: 'uploading', percent: 0..1 }        (real byte progress on direct path)
 *   { phase: 'finalizing' }                       (commit step on direct path)
 */
import { encryptPacked } from '../crypto/encrypt'
import { getActiveKey } from '../crypto/keyDerivation'
import { addEntry } from '../storage/manifest'
import { appendThumb } from '../storage/bundle'
import {
  commitUpload,
  preauthUpload,
  uploadFile,
} from '../storage/workerClient'
import { readMediaMetadata } from '../utils/exif'
import { generateThumbnail } from '../utils/thumbnail'
import { generateMediaId } from '../utils/uuid'
import { clearCache } from '../session/cache'

// Files at or above this (encrypted) size bypass the worker for the byte
// transfer: the worker only authorizes (preauth) and finalizes (commit).
// Below it, bytes are proxied through the worker as before.
const DIRECT_UPLOAD_THRESHOLD = 50 * 1024 * 1024 // 50 MB

export async function uploadMedia(file, onProgress) {
  const emit = (phase) => onProgress && onProgress({ phase })

  emit('reading')
  const meta = await readMediaMetadata(file)
  const thumbnail = await generateThumbnail(file, meta.type)
  const thumbBytes = new Uint8Array(await thumbnail.arrayBuffer())

  emit('encrypting')
  const fileBytes = new Uint8Array(await file.arrayBuffer())
  const encrypted = new Uint8Array(await encryptPacked(fileBytes, getActiveKey()))

  emit('uploading')
  const id = generateMediaId()
  if (encrypted.byteLength < DIRECT_UPLOAD_THRESHOLD) {
    await uploadFile(id, encrypted)
  } else {
    await uploadDirect(id, encrypted, onProgress)
  }

  const { thumb_offset, thumb_length } = await appendThumb(id, thumbBytes)

  const entry = {
    id,
    name: file.name,
    type: meta.type,
    date_taken: meta.date_taken,
    size: file.size,
    duration: meta.duration,
    thumb_offset,
    thumb_length,
  }

  await addEntry(entry)
  // Manifest + bundle changed on the server — drop the session cache so the
  // next gallery load re-fetches.
  await clearCache()

  emit('done')
  return entry
}

/**
 * Direct-to-S3 upload for large encrypted files. The worker never sees the
 * bytes; it only negotiates LFS credentials (preauth) and finalizes (commit).
 * The S3 PUT runs via XMLHttpRequest so we get real upload progress.
 */
async function uploadDirect(id, encryptedBytes, onProgress) {
  // 1 — sha256 of the encrypted bytes (must match the LFS oid the worker commits).
  const hashBuffer = await crypto.subtle.digest('SHA-256', encryptedBytes)
  const sha256 = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  // 2 — authorize: get the S3 upload URL + headers (or alreadyExists).
  const size = encryptedBytes.byteLength
  const preauth = await preauthUpload(id, size, sha256)

  // 3 — PUT the bytes straight to S3, unless S3 already has this sha256.
  if (!preauth.alreadyExists) {
    const { uploadUrl, uploadHeaders } = preauth
    await putToS3(uploadUrl, uploadHeaders, encryptedBytes, onProgress)
  }

  // 4 — finalize: optional LFS verify + git-commit the LFS pointer.
  onProgress && onProgress({ phase: 'finalizing' })
  await commitUpload(id, sha256, size, preauth.verifyUrl, preauth.verifyHeaders)
}

/**
 * XMLHttpRequest PUT with byte-level progress. Uses XHR (not fetch) because
 * fetch upload progress is not widely supported. Throws on any non-2xx.
 */
function putToS3(uploadUrl, uploadHeaders, encryptedBytes, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', uploadUrl)
    if (uploadHeaders) {
      Object.entries(uploadHeaders).forEach(([k, v]) => xhr.setRequestHeader(k, v))
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress({ phase: 'uploading', percent: e.loaded / e.total })
      }
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(`S3 PUT failed: ${xhr.status}`))
    }
    xhr.onerror = () => reject(new Error('S3 PUT network error'))
    xhr.send(encryptedBytes)
  })
}
