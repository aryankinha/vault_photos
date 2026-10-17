// Bound each encrypted metadata publication independently of the selection size.
// One media item is never split: its manifest entry only appears after all of
// its pointers can be committed. Existing remote objects are safe to retry.
export function groupPublications(items, { maxItems = 250, maxPointers = 1800 } = {}) {
  const groups = []
  let group = []
  let pointers = 0
  for (const item of items) {
    const count = item.isChunked ? item.chunkCount : 1
    if (!Number.isSafeInteger(count) || count < 1 || count > maxPointers) {
      throw new Error(`A file exceeds the supported ${maxPointers}-object publication limit`)
    }
    if (group.length && (group.length >= maxItems || pointers + count > maxPointers)) {
      groups.push(group)
      group = []
      pointers = 0
    }
    group.push(item)
    pointers += count
  }
  if (group.length) groups.push(group)
  return groups
}
