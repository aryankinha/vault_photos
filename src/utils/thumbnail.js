const MAX_DIMENSION = 400
const JPEG_QUALITY = 0.7
// Small probe decode: cheap for engines with decode-to-scale (Blink), and
// gives us the aspect ratio without holding a full-resolution bitmap.
const PROBE_DIMENSION = 8

/**
 * Thumbnail generation. The image path decodes at bounded scale when the
 * browser supports resize options on createImageBitmap, falling back to the
 * classic full decode — either way the source bitmap is released promptly so
 * peak memory stays far below one full-resolution decode + canvas copy (U4).
 *
 * @param {File|Blob} file
 * @param {'image'|'video'} type
 * @returns {Promise<Blob>} — re-encoded JPEG (EXIF/GPS stripped by re-encode)
 */
export async function generateThumbnail(file, type) {
  if (type === 'image') return generateImageThumbnail(file)
  if (type === 'video') return generateVideoThumbnail(file)
  throw new Error('Unsupported media type for thumbnail')
}

async function generateImageThumbnail(file) {
  let bitmap = null
  try {
    bitmap = await decodeAtScale(file)
  } catch {
    // resize/probe options unsupported — null keeps us on the full decode path
  }

  if (!bitmap || bitmap.width === 0 || bitmap.height === 0) {
    const full = await createImageBitmap(file)
    try {
      return canvasToJpeg(drawScaled(full.width, full.height, (ctx, width, height) => {
        ctx.drawImage(full, 0, 0, width, height)
      }))
    } finally {
      full.close()
    }
  }

  try {
    const { width, height } = fitDimensions(bitmap.width, bitmap.height)
    // The scale-decoded bitmap is close to the target; canvas-copy to the
    // exact JPEG target (also normalizes any engine quirks).
    return canvasToJpeg(drawFixed(width, height, bitmap))
  } finally {
    bitmap.close()
  }
}

function drawFixed(width, height, bitmap) {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { alpha: false })
  canvas.width = width
  canvas.height = height
  ctx.drawImage(bitmap, 0, 0, width, height)
  return canvas
}

/**
 * Decode bounded by MAX_DIMENSION without knowing the aspect ratio first:
 * a tiny probe decode gives the aspect, then a single decode-at-scale for the
 * final size anchored on the longer edge.
 */
async function decodeAtScale(file) {
  const probe = await createImageBitmap(file, {
    resizeWidth: PROBE_DIMENSION,
    resizeQuality: 'low',
  })
  const aspect = probe.height / probe.width
  probe.close()

  // Anchor the LONGER edge to MAX_DIMENSION so both dimensions stay ≤ 400.
  const options = aspect >= 1
    ? { resizeHeight: MAX_DIMENSION, resizeQuality: 'medium' }
    : { resizeWidth: MAX_DIMENSION, resizeQuality: 'medium' }
  return createImageBitmap(file, options)
}

function fitDimensions(width, height) {
  const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

function drawScaled(sourceWidth, sourceHeight, draw) {
  const scale = Math.min(1, MAX_DIMENSION / Math.max(sourceWidth, sourceHeight))
  const width = Math.max(1, Math.round(sourceWidth * scale))
  const height = Math.max(1, Math.round(sourceHeight * scale))
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { alpha: false })

  canvas.width = width
  canvas.height = height
  draw(ctx, width, height)
  return canvas
}

function generateVideoThumbnail(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    const url = URL.createObjectURL(file)

    video.muted = true
    video.playsInline = true
    video.preload = 'metadata'

    video.onloadedmetadata = () => {
      const target = Math.min(1, Math.max(0, video.duration / 2 || 0))
      video.currentTime = target
    }

    video.onseeked = async () => {
      try {
        const blob = await canvasToJpeg(drawScaled(video.videoWidth, video.videoHeight, (ctx, width, height) => {
          ctx.drawImage(video, 0, 0, width, height)
        }))
        URL.revokeObjectURL(url)
        resolve(blob)
      } catch (error) {
        URL.revokeObjectURL(url)
        reject(error)
      }
    }

    video.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Unable to generate video thumbnail'))
    }

    video.src = url
  })
}

function canvasToJpeg(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Unable to encode thumbnail'))
        return
      }
      resolve(blob)
    }, 'image/jpeg', JPEG_QUALITY)
  })
}
