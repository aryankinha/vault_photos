export class UserFacingError extends Error {}

export function getUserErrorMessage(error, fallback) {
  if (error instanceof UserFacingError) return error.message
  if (import.meta.env.DEV && error instanceof Error) return error.message
  if (import.meta.env.PROD && error instanceof Error) {
    console.error('VaultPhotos operation failed', error)
  }
  return fallback
}
