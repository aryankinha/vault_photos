/**
 * useUploadContext hook — separated from UploadContext.jsx to satisfy
 * react-refresh/only-export-components (fast refresh requires files to only
 * export React components or only export non-component values, not both).
 */
import { useContext } from 'react'
import { UploadContext } from './uploadContextValue'

export function useUploadContext() {
  const ctx = useContext(UploadContext)
  if (!ctx) throw new Error('useUploadContext must be used inside <UploadProvider>')
  return ctx
}
