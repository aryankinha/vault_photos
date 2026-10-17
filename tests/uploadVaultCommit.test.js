import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'

if (!globalThis.crypto) globalThis.crypto = webcrypto

const {
  parseVaultHead,
  isVaultStaleError,
  selectPendingItems,
  collectCommitReceipts,
  MAX_FINALIZE_REBASE,
} = await import('../src/services/vaultCommit.js')
const { withVaultLock, VAULT_LOCK_NAME } = await import('../src/utils/vaultLock.js')

// ---------------------------------------------------------------------------
// /vault-head + VAULT_STALE contract parsing (W1)
// ---------------------------------------------------------------------------

test('parseVaultHead accepts the {oid} contract shape', () => {
  assert.deepEqual(parseVaultHead({ oid: 'a'.repeat(40) }), { oid: 'a'.repeat(40) })
  // empty vault — head exists as a resource but points at nothing
  assert.deepEqual(parseVaultHead({}), { oid: null })
  assert.deepEqual(parseVaultHead(null), null)
  assert.deepEqual(parseVaultHead(undefined), null)
  assert.deepEqual(parseVaultHead('garbage'), null)
})

test('isVaultStaleError matches the 409 VAULT_STALE contract', () => {
  assert.equal(isVaultStaleError({ status: 409, code: 'VAULT_STALE', retryable: false }), true)
  // a bare 409 (other writer mid-rollout) still rebases
  assert.equal(isVaultStaleError({ status: 409 }), true)
  // but a distinct 409 with its own code is not a rebase signal
  assert.equal(isVaultStaleError({ status: 409, code: 'MISSING_PARENT' }), false)
  assert.equal(isVaultStaleError({ status: 500 }), false)
  assert.equal(isVaultStaleError(null), false)
})

test('MAX_FINALIZE_REBASE bounds the rebase loop', () => {
  assert.equal(MAX_FINALIZE_REBASE, 3)
})

// ---------------------------------------------------------------------------
// Manifest filter + receipt aggregation
// ---------------------------------------------------------------------------

test('selectPendingItems drops ids already in the manifest', () => {
  const manifestFiles = [{ id: 'a' }, { id: 'b' }]
  const items = [{ id: 'a' }, { id: 'c' }, { id: 'b' }, { id: 'd' }]
  const pending = selectPendingItems(items, manifestFiles)
  assert.deepEqual(pending.map((item) => item.id), ['c', 'd'])
})

test('selectPendingItems tolerates null entries', () => {
  const pending = selectPendingItems([null, { id: 'x' }], [])
  assert.deepEqual(pending, [{ id: 'x' }])
})

test('collectCommitReceipts aggregates whole-file and covered chunk receipts', () => {
  const pending = [
    { id: 'small' },
    { id: 'video', chunkCount: 3 },
  ]
  const uploadResults = [
    { ok: true, file: { id: 'small', sha256: 'f1', size: 10 } },
    { ok: true, chunks: [
      { index: 0, sha256: 'c0', size: 3 },
      { index: 1, sha256: 'c1', size: 3 },
      { index: 2, sha256: 'c2', size: 3 },
    ] },
  ]
  const receipt = collectCommitReceipts(pending, uploadResults)
  assert.deepEqual(receipt.files, [{ id: 'small', sha256: 'f1', size: 10 }])
  assert.deepEqual(receipt.chunks, [
    { index: 0, sha256: 'c0', size: 3, id: 'video' },
    { index: 1, sha256: 'c1', size: 3, id: 'video' },
    { index: 2, sha256: 'c2', size: 3, id: 'video' },
  ])
  assert.deepEqual(receipt.uncoveredItemIds, [])
})

test('collectCommitReceipts refuses to finalize partial chunk coverage (U1)', () => {
  const pending = [{ id: 'video', chunkCount: 3 }]
  const uploadResults = [
    { ok: true, chunks: [
      { index: 0, sha256: 'c0', size: 3 },
      null, // interrupted before chunk 1
      { index: 2, sha256: 'c2', size: 3 },
    ] },
  ]
  const receipt = collectCommitReceipts(pending, uploadResults)
  assert.deepEqual(receipt.uncoveredItemIds, ['video'])
  // nothing must be committed for an under-covered batch
  assert.deepEqual(receipt.files, [])
  assert.deepEqual(receipt.chunks, [])
})

// ---------------------------------------------------------------------------
// Web Locks (W1) with in-process fallback
// ---------------------------------------------------------------------------

test('withVaultLock exposes the documented lock name', () => {
  assert.equal(VAULT_LOCK_NAME, 'vaultphotos-vault')
})

test('withVaultLock serializes concurrent holders so finalize cannot interleave', async () => {
  let inside = 0
  let maxInside = 0
  const run = async (value) => {
    inside += 1
    maxInside = Math.max(maxInside, inside)
    await new Promise((resolve) => setTimeout(resolve, 5))
    inside -= 1
    return value
  }

  const [a, b] = await Promise.all([
    withVaultLock(() => run(1)),
    withVaultLock(() => run(2)),
  ])
  assert.deepEqual([a, b], [1, 2])
  assert.equal(maxInside, 1, 'holders must never overlap')
})

test('withVaultLock propagates errors and releases the lock for the next holder', async () => {
  await assert.rejects(
    withVaultLock(async () => {
      throw new Error('boom')
    }),
    /boom/,
  )
  const result = await withVaultLock(() => 'recovered')
  assert.equal(result, 'recovered')
})
