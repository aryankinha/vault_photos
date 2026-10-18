let session = null
const subscribers = new Set()

export function getVaultSession() { return session }
export function activateVaultSession(next) {
  if (!next?.keys || next.root?.extractable !== false) throw new Error('Invalid vault session')
  session = next
  for (const listener of subscribers) listener(session)
}
export function clearVaultSession() {
  session = null
  for (const listener of subscribers) listener(null)
}
export function onVaultSessionChange(listener) {
  subscribers.add(listener)
  return () => subscribers.delete(listener)
}
