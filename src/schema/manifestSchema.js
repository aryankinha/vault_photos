export const MANIFEST_VERSION = 1

/**
 * Create an empty manifest.
 *
 * Root shape (V3 adds optional bundle_pages):
 * {
 *   version: 1,
 *   created_at: ISO string,
 *   updated_at: ISO string,
 *   bundle_pages: number,   // total bundle pages; absent on V1/V2 → treated as 1
 *   files: MediaEntry[]
 * }
 *
 * MediaEntry optional fields added in V3 (all backward-compatible — undefined = old entry):
 *   page_index:   number   — which bundle page this entry's thumbnail lives in
 *                            undefined → treated as page 0 (legacy thumbs.bundle)
 *   chunked:      boolean  — true if the file was encrypted in chunks (Feature 5)
 *   chunk_size:   number   — bytes per chunk before encryption
 *   chunk_count:  number   — total number of chunks
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

  manifest.files.forEach(validateMediaEntry)
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
}

function isIsoString(value) {
  if (typeof value !== 'string') return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

