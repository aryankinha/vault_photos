// Keep comfortably below Hugging Face's recommended 50-100 HTTP operations
// per commit. Thumbnail pages may be staged early because no manifest points
// at them yet; manifest.enc is always reserved for the final publication batch.
export const MAX_HF_OPERATIONS_PER_COMMIT = 40
export const MAX_LFS_POINTERS_PER_COMMIT = MAX_HF_OPERATIONS_PER_COMMIT

export function planCommitBatches(filesToCommit, lfsFilesToCommit) {
  const metadata = Array.from(filesToCommit || [])
  const pointers = Array.from(lfsFilesToCommit || [])
  const publishFiles = metadata.filter((file) => file.path === 'manifest.enc')
  const stagedFiles = metadata.filter((file) => file.path !== 'manifest.enc')
  const batches = []

  while (
    stagedFiles.length + pointers.length + publishFiles.length >
    MAX_HF_OPERATIONS_PER_COMMIT
  ) {
    let capacity = MAX_HF_OPERATIONS_PER_COMMIT
    const batchPointers = pointers.splice(0, capacity)
    capacity -= batchPointers.length
    const batchFiles = stagedFiles.splice(0, capacity)
    batches.push({
      filesToCommit: batchFiles,
      lfsFilesToCommit: batchPointers,
    })
  }

  batches.push({
    filesToCommit: [...stagedFiles, ...publishFiles],
    lfsFilesToCommit: pointers,
  })

  return batches
}
