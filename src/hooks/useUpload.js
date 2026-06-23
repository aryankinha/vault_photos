import { useCallback, useState } from 'react'
import { uploadMedia } from '../services/uploadService'

const STATUS = {
  IDLE: 'idle',
  READING: 'reading',
  ENCRYPTING: 'encrypting',
  UPLOADING: 'uploading',
  FINALIZING: 'finalizing',
  DONE: 'done',
  ERROR: 'error',
}

export function useUpload() {
  const [status, setStatus] = useState(STATUS.IDLE)
  const [error, setError] = useState(null)
  const [lastEntry, setLastEntry] = useState(null)
  // Upload progress 0..1 for the direct-to-S3 path (null on proxy path).
  const [percent, setPercent] = useState(null)

  const upload = useCallback(async (file) => {
    setStatus(STATUS.READING)
    setError(null)
    setPercent(null)
    try {
      const entry = await uploadMedia(file, (event) => {
        if (event.phase === 'reading') {
          setStatus(STATUS.READING)
        } else if (event.phase === 'encrypting') {
          setStatus(STATUS.ENCRYPTING)
        } else if (event.phase === 'uploading') {
          setStatus(STATUS.UPLOADING)
          setPercent(typeof event.percent === 'number' ? event.percent : null)
        } else if (event.phase === 'finalizing') {
          setStatus(STATUS.FINALIZING)
        }
      })
      setLastEntry(entry)
      setStatus(STATUS.DONE)
      return entry
    } catch (e) {
      setError(e)
      setStatus(STATUS.ERROR)
      throw e
    }
  }, [])

  const reset = useCallback(() => {
    setStatus(STATUS.IDLE)
    setError(null)
    setLastEntry(null)
    setPercent(null)
  }, [])

  return { status, error, lastEntry, percent, upload, reset, STATUS }
}
