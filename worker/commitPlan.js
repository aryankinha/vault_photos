// Keep comfortably below Hugging Face's recommended 50-100 HTTP operations
// per commit.
export const MAX_HF_OPERATIONS_PER_COMMIT = 40
export const MAX_LFS_POINTERS_PER_COMMIT = MAX_HF_OPERATIONS_PER_COMMIT

export class MetadataBatchTooLargeError extends Error {
  constructor(count) {
    super(
      `Batch metadata needs ${count} file operations but only ` +
        `${MAX_HF_OPERATIONS_PER_COMMIT} can be published atomically in one commit`,
    )
    this.name = 'MetadataBatchTooLargeError'
    this.code = 'METADATA_TOO_LARGE'
    this.metadataCount = count
  }
}

/**
 * Atomic batch planner used by the worker.
 *
 * Every `file` operation — `manifest.enc`, the legacy `thumbs.bundle`, and
 * every `thumbs_page_N.bundle` (including pages that re-encrypt content which
 * already exists and is referenced by the current manifest) — is placed in the
 * single final commit, together with whatever LFS pointers fit in the
 * remaining capacity. This keeps the manifest and the pages it indexes in one
 * Git transaction: a reader either sees the old manifest with the old pages or
 * the new manifest with the new pages, never a mutated page under an old
 * manifest.
 *
 * LFS pointers are safe to stage in earlier commits because nothing points at
 * them until the final manifest lands. If the metadata set cannot fit in a
 * single commit the request is rejected ({@link MetadataBatchTooLargeError})
 * rather than staging metadata early.
 *
 * Within the final commit `manifest.enc` is always emitted last.
 */
export function planAtomicCommitBatches(filesToCommit, lfsFilesToCommit) {
  const metadata = Array.from(filesToCommit || [])
  const pointers = Array.from(lfsFilesToCommit || [])

  if (metadata.length > MAX_HF_OPERATIONS_PER_COMMIT) {
    throw new MetadataBatchTooLargeError(metadata.length)
  }

  const total = metadata.length + pointers.length
  if (total === 0) return []

  // Manifest is the publication pointer: emit it last in the final commit.
  const orderedMetadata = [
    ...metadata.filter((file) => file.path !== 'manifest.enc'),
    ...metadata.filter((file) => file.path === 'manifest.enc'),
  ]

  const batchCount = Math.ceil(total / MAX_HF_OPERATIONS_PER_COMMIT)
  const earlyBatchCount = batchCount - 1

  // Maximise pointers staged early so the final atomic commit stays small, but
  // never reserve more of the final commit than its spare capacity.
  const earlyPointerCapacity = earlyBatchCount * MAX_HF_OPERATIONS_PER_COMMIT
  const finalPointerCount = Math.max(0, pointers.length - earlyPointerCapacity)
  const earlyPointerCount = pointers.length - finalPointerCount

  const batches = []
  let offset = 0
  for (let index = 0; index < earlyBatchCount; index += 1) {
    const take = Math.min(
      MAX_HF_OPERATIONS_PER_COMMIT,
      earlyPointerCount - offset,
    )
    batches.push({
      filesToCommit: [],
      lfsFilesToCommit: pointers.slice(offset, offset + take),
    })
    offset += take
  }

  batches.push({
    filesToCommit: orderedMetadata,
    lfsFilesToCommit: pointers.slice(offset),
  })

  return batches
}

/**
 * Deprecated alias kept for the legacy import in `tests/core.test.js`.
 *
 * The old planner staged non-manifest metadata in early commits, which could
 * publish a mutated existing bundle page before the manifest that indexes it.
 * It now behaves exactly like {@link planAtomicCommitBatches}: metadata is only
 * ever published in the final commit, and an oversized metadata set throws
 * {@link MetadataBatchTooLargeError} instead of being staged early.
 *
 * Note for whoever owns `tests/core.test.js`: the
 * "many encrypted thumbnail pages are staged before the manifest" fixture
 * (95 pages + manifest = 96 metadata ops) must now either expect
 * `MetadataBatchTooLargeError` or be reduced to ≤39 pages + manifest.
 */
export function planCommitBatches(filesToCommit, lfsFilesToCommit) {
  return planAtomicCommitBatches(filesToCommit, lfsFilesToCommit)
}
