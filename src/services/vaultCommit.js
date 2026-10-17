/**
 * Vault commit transaction helpers (W1 snapshot-consistent finalize).
 *
 * Pure coordination logic pulled out of uploadService so it can be unit tested
 * in Node. The network/storage steps stay in uploadService + workerClient.
 *
 * Incoming worker contract (owned by the worker session):
 *   GET /vault-head                       → { oid: string } (current head commit)
 *   GET /get-manifest?revision=<oid>      → manifest bytes pinned to that revision
 *   GET /get-bundle?revision=<oid>        → legacy bundle bytes pinned
 *   GET /get-bundle-page/<n>?revision=<oid>
 *   POST /commit-batch { ..., parentCommit: <oid> } → 409 VAULT_STALE when head moved
 */

import { isChunkRowComplete } from './uploadRecovery.js'

// One finalize batch may rebase at most this many times when the vault head
// moved underneath us (another device/tab committed first).
export const MAX_FINALIZE_REBASE = 3

/**
 * Parse a /vault-head response into `{ oid }` (oid may be null for an empty
 * vault). Returns null so callers can distinguish "route missing on a legacy
 * worker" from "empty vault".
 *
 * @param {unknown} data — parsed JSON body or undefined
 * @returns {{ oid: string | null }}
 */
export function parseVaultHead(data) {
  if (!data || typeof data !== 'object') return null
  const oid = typeof data.oid === 'string' && /^[0-9a-f]{40}$/i.test(data.oid)
    ? data.oid
    : null
  return { oid }
}

/**
 * Whether a commitBatch failure means our parentCommit is stale and a bounded
 * rebase (re-read head → manifest → drop already-present → recommit) should
 * run. Matches the worker's 409 `code: 'VAULT_STALE'` contract, and tolerates
 * plain 409 responses while other writers roll out.
 *
 * @param {{ status?: number, code?: string, retryable?: boolean }} error
 */
export function isVaultStaleError(error) {
  if (!error) return false
  if (error.code === 'VAULT_STALE') return true
  return error.status === 409 && error.code !== 'MISSING_PARENT'
}

/**
 * Filter batch items down to what the manifest doesn't already have. Works on
 * any iterable of items with an `id`.
 *
 * @param {Iterable<{ id: string }>} items
 * @param {Iterable<{ id: string }>} manifestFiles
 */
export function selectPendingItems(items, manifestFiles) {
  const existingIds = new Set()
  for (const entry of manifestFiles) existingIds.add(entry.id)
  return [...items].filter((item) => item != null && !existingIds.has(item.id))
}

/**
 * Aggregate LFS receipts for the pending items into the commitBatch payload
 * arrays, enforcing (not sparse-finalizing — U1) full chunk receipt coverage.
 * Returns null when a chunked item is missing receipts; the caller must then
 * NOT finalize that batch unchanged (the row stays queued for source resume).
 *
 * @param {Array<{ id: string }>} pending
 * @param {Array<{ ok?: boolean, file?: object, chunks?: object[] }>} uploadResults — same index space as pending
 * @returns {{ files: object[], chunks: object[], uncoveredItemIds: string[] }}
 */
function isValidFileReceipt(receipt) {
  return (
    !!receipt &&
    typeof receipt === 'object' &&
    typeof receipt.sha256 === 'string' &&
    receipt.sha256.length > 0 &&
    Number.isFinite(receipt.size) &&
    receipt.size > 0
  )
}

function isValidChunkReceipt(receipt, expectedIndex) {
  return (
    !!receipt &&
    typeof receipt === 'object' &&
    typeof receipt.sha256 === 'string' &&
    receipt.sha256.length > 0 &&
    Number.isFinite(receipt.size) &&
    receipt.size > 0 &&
    Number.isInteger(receipt.index) &&
    receipt.index === expectedIndex
  )
}

export function collectCommitReceipts(pending, uploadResults) {
  const files = []
  const chunks = []
  const uncoveredItemIds = []
  for (let index = 0; index < pending.length; index += 1) {
    const item = pending[index]
    const upload = uploadResults[index] ?? {}
    const itemId = item?.id
    if (upload.file) {
      if (!isValidFileReceipt(upload.file)) {
        uncoveredItemIds.push(itemId ?? '')
        continue
      }
      // Attach the trusted item id; never trust a receipt-carried id.
      files.push({ ...upload.file, id: itemId })
    }
    if (upload.chunks) {
      if (!isChunkRowComplete(item ?? {}, upload.chunks)) {
        uncoveredItemIds.push(itemId ?? '')
        continue
      }
      let chunkInvalid = false
      for (let chunkIndex = 0; chunkIndex < upload.chunks.length; chunkIndex += 1) {
        const receipt = upload.chunks[chunkIndex]
        if (!isValidChunkReceipt(receipt, chunkIndex)) {
          chunkInvalid = true
          break
        }
        // Trusted id + validated index.
        chunks.push({ ...receipt, id: itemId, index: chunkIndex })
      }
      if (chunkInvalid) {
        uncoveredItemIds.push(itemId ?? '')
        continue
      }
    }
  }
  if (uncoveredItemIds.length > 0) {
    return { files: [], chunks: [], uncoveredItemIds }
  }
  return { files, chunks, uncoveredItemIds }
}
