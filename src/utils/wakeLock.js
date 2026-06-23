/**
 * Screen Wake Lock utility.
 *
 * Acquires a 'screen' wake lock to prevent the display from sleeping during
 * long uploads. Degrades silently on browsers that don't support the API.
 *
 * Usage:
 *   const lock = await requestWakeLock()
 *   // ... upload runs ...
 *   await releaseWakeLock(lock)
 *
 * Reacquire on visibilitychange if the page regains focus during an active upload:
 *   document.addEventListener('visibilitychange', async () => {
 *     if (document.visibilityState === 'visible' && isUploading) {
 *       lock = await requestWakeLock()
 *     }
 *   })
 */

/**
 * Request a screen wake lock.
 * @returns {Promise<WakeLockSentinel|null>} lock handle, or null if unsupported
 */
export async function requestWakeLock() {
  try {
    if (!navigator.wakeLock) return null
    return await navigator.wakeLock.request('screen')
  } catch {
    // User denied or browser threw — degrade gracefully.
    return null
  }
}

/**
 * Release a previously acquired wake lock.
 * @param {WakeLockSentinel|null} lock
 */
export async function releaseWakeLock(lock) {
  try {
    if (lock) await lock.release()
  } catch {
    // Ignore — lock may already have been released by the browser.
  }
}
