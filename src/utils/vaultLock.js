/**
 * Cross-tab vault mutation serialization via the Web Locks API.
 *
 * Finalizing an upload batch is a read–mutate–commit transaction against the
 * worker. Two tabs (or a tab + service worker) finalizing concurrently used to
 * race to last-writer-wins and silently lose manifest entries. Holding one
 * named lock around the whole finalize keeps tabs serialized; the worker-side
 * parentCommit CAS (409 VAULT_STALE) covers the remaining window (e.g. another
 * device).
 *
 * When navigator.locks is unavailable (older browsers, Node test process) the
 * module degrades to an in-process async mutex — same serialization contract
 * for everything inside a single JS context.
 */

export const VAULT_LOCK_NAME = 'vaultphotos-vault'

let inProcessTail = Promise.resolve()

function runWithInProcessLock(run) {
  const result = inProcessTail.then(run, run)
  // Keep the chain alive even if a holder throws; the next holder must run.
  inProcessTail = result.then(
    () => {},
    () => {},
  )
  return result
}

/**
 * Run `run` while holding the vault lock.
 *
 * @template T
 * @param {() => T | Promise<T>} run
 * @returns {Promise<T>} — the result of `run`
 */
export async function withVaultLock(run) {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : null
  if (!locks?.request) {
    return runWithInProcessLock(run)
  }
  return locks.request(VAULT_LOCK_NAME, () => run())
}

/**
 * AbortReason for aborting an in-flight upload because the vault was LOCKED
 * (as opposed to a user cancel). Upload code distinguishes the two:
 * cancel deletes the affected queue rows, lock must preserve them so the
 * uploads resume after the next unlock.
 *
 * Sanity: consumers check `signal.reason.vaultLock` (see uploadService
 * isLockAbort); the exception still satisfies isAbortError.
 * @returns {DOMException}
 */
export function createLockAbortError() {
  const error = new DOMException('Vault locked', 'AbortError')
  Object.defineProperty(error, 'vaultLock', { value: true })
  return error
}
