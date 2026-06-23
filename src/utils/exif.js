import exifr from 'exifr'

export async function readMediaMetadata(file) {
  const type = getMediaType(file)
  const uploadedAt = new Date().toISOString()
  let dateTaken = uploadedAt
  let duration = null

  if (type === 'image') {
    try {
      const exif = await exifr.parse(file, ['DateTimeOriginal', 'CreateDate', 'ModifyDate'])
      const exifDate = exif?.DateTimeOriginal || exif?.CreateDate || exif?.ModifyDate
      if (exifDate instanceof Date && Number.isFinite(exifDate.getTime())) {
        dateTaken = exifDate.toISOString()
      }
    } catch {
      dateTaken = uploadedAt
    }
  }

  if (type === 'video') {
    duration = await readVideoDuration(file)
  }

  return { type, date_taken: dateTaken, duration }
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
