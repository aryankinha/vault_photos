import exifr from 'exifr'

/**
 * Maximum bytes read from a file for EXIF extraction.
 * JPEG/HEIC/TIFF EXIF data always starts near the beginning of the file.
 * 64 KB covers even the most complex multi-segment EXIF headers.
 * For a 50 MB RAW file this reduces the disk/memory read by 99.9%.
 */
const EXIF_HEADER_SIZE = 64 * 1024

const EXIF_TAGS = ['DateTimeOriginal', 'CreateDate', 'ModifyDate']

export async function readMediaMetadata(file) {
  const type = getMediaType(file)
  const uploadedAt = new Date().toISOString()
  let dateTaken = uploadedAt
  let duration = null

  if (type === 'image') {
    dateTaken = await readExifDate(file, uploadedAt)
  }

  if (type === 'video') {
    duration = await readVideoDuration(file)
  }

  return { type, date_taken: dateTaken, duration }
}

/**
 * Extract the earliest EXIF date from the file.
 * First tries reading only the first EXIF_HEADER_SIZE bytes (fast path).
 * Falls back to reading the entire file if the header slice doesn't contain EXIF.
 *
 * @param {File} file
 * @param {string} fallback — ISO string to return when no date is found
 * @returns {Promise<string>} ISO date string
 */
async function readExifDate(file, fallback) {
  // Fast path — read only the first 64 KB.
  try {
    const header = file.slice(0, EXIF_HEADER_SIZE)
    const exif = await exifr.parse(header, EXIF_TAGS)
    const exifDate = exif?.DateTimeOriginal ?? exif?.CreateDate ?? exif?.ModifyDate
    if (exifDate instanceof Date && Number.isFinite(exifDate.getTime())) {
      return exifDate.toISOString()
    }
  } catch {
    // Header parse failed — fall through to full-file read.
  }

  // Slow path fallback — full file (handles files smaller than 64 KB and rare
  // formats where EXIF metadata is stored beyond the first 64 KB).
  try {
    const exif = await exifr.parse(file, EXIF_TAGS)
    const exifDate = exif?.DateTimeOriginal ?? exif?.CreateDate ?? exif?.ModifyDate
    if (exifDate instanceof Date && Number.isFinite(exifDate.getTime())) {
      return exifDate.toISOString()
    }
  } catch {
    // No EXIF or unreadable — fall through.
  }

  return fallback
}

function getMediaType(file) {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  throw new Error('Only image and video files are supported')
}

function readVideoDuration(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    const url = URL.createObjectURL(file)

    video.preload = 'metadata'
    video.muted = true
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : null
      URL.revokeObjectURL(url)
      resolve(duration)
    }
    video.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Unable to read video metadata'))
    }
    video.src = url
  })
}

