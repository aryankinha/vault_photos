export const MANIFEST_VERSION = 1

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
}

function isIsoString(value) {
  if (typeof value !== 'string') return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}
