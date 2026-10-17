export const MANIFEST_VERSION = 1

const HEX64 = /^[0-9a-f]{64}$/i

/**
 * Create an empty manifest.
 *
 * Root shape (V3 adds optional bundle_pages):
 * {
 *   version: 1,
 *   created_at: ISO string,
 *   updated_at: ISO string,
 *   bundle_pages: number,   // total bundle pages; absent on V1/V2 → treated as 1
 *   revision: number,       // optional monotonic counter for rollback detection (S4)
 *   files: MediaEntry[]
 * }
 *
 * MediaEntry optional fields added in V3 (all backward-compatible — undefined = old entry):
 *   page_index:   number   — which bundle page this entry's thumbnail lives in
 *                            undefined → treated as page 0 (legacy thumbs.bundle)
 *   chunked:      boolean  — true if the file was encrypted in chunks (Feature 5)
 *   chunk_size:   number   — bytes per chunk before encryption
 *   chunk_count:  number   — total number of chunks
 *
 * MediaEntry optional integrity/crypto fields (audit findings S3/U6):
 *   sha256:         string — lowercase hex SHA-256 of the whole-file ciphertext
 *                            (non-chunked entries)
 *   chunk_sha256:   string[]— per-chunk hex SHA-256 of the ciphertext, index-aligned
 *   crypto_version: 1|2    — 1/absent = legacy (no AAD), 2 = context-bound AAD
 */
export function createEmptyManifest(now = new Date().toISOString()) {
  return {
    version: MANIFEST_VERSION,
    created_at: now,
    updated_at: now,
    files: [],
  }
}

export function parseManifest(jsonText) {
  const manifest = JSON.parse(jsonText)
  validateManifest(manifest)
  return manifest
}

export function serializeManifest(manifest) {
  validateManifest(manifest)
  return JSON.stringify(manifest)
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Manifest must be an object')
  }

  if (manifest.version !== MANIFEST_VERSION) {
    throw new Error(`Unsupported manifest version: ${manifest.version}`)
  }

  if (!isIsoString(manifest.created_at) || !isIsoString(manifest.updated_at)) {
    throw new Error('Manifest timestamps must be ISO strings')
  }

  if (!Array.isArray(manifest.files)) {
    throw new Error('Manifest files must be an array')
  }

  // bundle_pages is optional — must be a positive integer if present.
  if (manifest.bundle_pages !== undefined) {
    if (!Number.isInteger(manifest.bundle_pages) || manifest.bundle_pages < 1) {
      throw new Error('Manifest bundle_pages must be a positive integer')
    }
  }

  // revision is optional — must be a non-negative integer when present.
  if (manifest.revision !== undefined) {
    if (!Number.isInteger(manifest.revision) || manifest.revision < 0) {
      throw new Error('Manifest revision must be a non-negative integer')
    }
  }

  // Duplicate ids would make per-file lookups ambiguous and could silently
  // shadow an entry, so reject them outright.
  const seenIds = new Set()
  manifest.files.forEach((entry) => {
    if (seenIds.has(entry?.id)) {
      throw new Error(`Manifest contains duplicate file id: ${entry.id}`)
    }
    if (entry && typeof entry.id === 'string') seenIds.add(entry.id)
    validateMediaEntry(entry)
  })
}

export function validateMediaEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Media entry must be an object')
  }

  const requiredStrings = ['id', 'name', 'date_taken']
  for (const field of requiredStrings) {
    if (typeof entry[field] !== 'string' || entry[field].length === 0) {
      throw new Error(`Media entry ${field} must be a non-empty string`)
    }
  }

  if (!/^[0-9a-f]{16}$/i.test(entry.id)) {
    throw new Error('Media entry id must be a 16 character hex string')
  }

  if (entry.type !== 'image' && entry.type !== 'video') {
    throw new Error('Media entry type must be image or video')
  }

  if (!isIsoString(entry.date_taken)) {
    throw new Error('Media entry date_taken must be an ISO string')
  }

  if (!Number.isInteger(entry.size) || entry.size < 0) {
    throw new Error('Media entry size must be a non-negative integer')
  }

  if (entry.duration !== null && (typeof entry.duration !== 'number' || entry.duration < 0)) {
    throw new Error('Media entry duration must be a non-negative number or null')
  }

  for (const field of ['thumb_offset', 'thumb_length']) {
    if (!Number.isInteger(entry[field]) || entry[field] < 0) {
      throw new Error(`Media entry ${field} must be a non-negative integer`)
    }
  }

  // ---------------------------------------------------------------------------
  // V3 optional fields — validated only when present; undefined = old V1/V2 entry
  // ---------------------------------------------------------------------------

  // page_index: which bundle page this thumbnail lives in (default 0 = legacy page)
  if (entry.page_index !== undefined) {
    if (!Number.isInteger(entry.page_index) || entry.page_index < 0) {
      throw new Error('Media entry page_index must be a non-negative integer')
    }
  }

  // chunked: true when the file was encrypted in chunks (Feature 5)
  if (entry.chunked !== undefined && typeof entry.chunked !== 'boolean') {
    throw new Error('Media entry chunked must be a boolean')
  }

  // chunk_size / chunk_count: only required when chunked === true
  if (entry.chunked === true) {
    if (!Number.isInteger(entry.chunk_size) || entry.chunk_size <= 0) {
      throw new Error('Chunked media entry must have a valid chunk_size')
    }
    if (!Number.isInteger(entry.chunk_count) || entry.chunk_count <= 0) {
      throw new Error('Chunked media entry must have a valid chunk_count')
    }
  }

  // ---------------------------------------------------------------------------
  // Integrity + crypto-version fields (audit findings S3/U6) — optional
  // ---------------------------------------------------------------------------

  // sha256: whole-file ciphertext digest (non-chunked entries only).
  if (entry.sha256 !== undefined) {
    if (entry.chunked === true) {
      throw new Error('Chunked media entry must use chunk_sha256, not sha256')
    }
    if (typeof entry.sha256 !== 'string' || !HEX64.test(entry.sha256)) {
      throw new Error('Media entry sha256 must be a 64-char hex string')
    }
  }

  // chunk_sha256: per-chunk ciphertext digests, index-aligned, size === chunk_count.
  if (entry.chunk_sha256 !== undefined) {
    if (entry.chunked !== true) {
      throw new Error('chunk_sha256 is only valid on chunked media entries')
    }
    if (!Array.isArray(entry.chunk_sha256)) {
      throw new Error('Media entry chunk_sha256 must be an array')
    }
    if (entry.chunk_sha256.length !== entry.chunk_count) {
      throw new Error(
        `chunk_sha256 length (${entry.chunk_sha256.length}) must equal chunk_count (${entry.chunk_count})`,
      )
    }
    for (const digest of entry.chunk_sha256) {
      if (typeof digest !== 'string' || !HEX64.test(digest)) {
        throw new Error('Every chunk_sha256 entry must be a 64-char hex string')
      }
    }
  }

  // crypto_version: 1 (or absent) = legacy no-AAD, 2 = context-bound AAD.
  // Version 2 requires its integrity digests so viewers can verify before
  // decrypt, and so a context-bound object can never be silently downgraded.
  if (entry.crypto_version !== undefined) {
    if (entry.crypto_version !== 1 && entry.crypto_version !== 2) {
      throw new Error(`Unsupported crypto_version: ${entry.crypto_version}`)
    }
    if (entry.crypto_version === 2) {
      if (entry.chunked === true) {
        if (!Array.isArray(entry.chunk_sha256)) {
          throw new Error('crypto_version 2 chunked entry must carry chunk_sha256')
        }
      } else if (entry.sha256 === undefined) {
        throw new Error('crypto_version 2 entry must carry sha256')
      }
    }
  }
}

function isIsoString(value) {
  if (typeof value !== 'string') return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

