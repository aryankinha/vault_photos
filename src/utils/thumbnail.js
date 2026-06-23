const MAX_DIMENSION = 400
const JPEG_QUALITY = 0.7

export async function generateThumbnail(file, type) {
  if (type === 'image') return generateImageThumbnail(file)
  if (type === 'video') return generateVideoThumbnail(file)
  throw new Error('Unsupported media type for thumbnail')
}

async function generateImageThumbnail(file) {
  const bitmap = await createImageBitmap(file)
  try {
    return canvasToJpeg(drawScaled(bitmap.width, bitmap.height, (ctx, width, height) => {
      ctx.drawImage(bitmap, 0, 0, width, height)
    }))
  } finally {
    bitmap.close()
  }
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
