/** Accept the whole selection or leave the queue untouched. */
export function enqueueSelectedFiles(queue, files, limit) {
  const selection = Array.from(files)
  if (queue.length + selection.length > limit) {
    throw new Error(`Upload queue is full. Wait for the current uploads, then select these ${selection.length} files again.`)
  }
  queue.push(...selection.map((file) => ({ type: 'file', file })))
}
