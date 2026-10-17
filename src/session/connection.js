// Connection credentials live in this document's RAM only, never browser storage.
let ownerToken = ''
export function setOwnerToken(value) { ownerToken = value }
export function getOwnerToken() { return ownerToken }
export function connectionHeaders() {
  return ownerToken ? { Authorization: `Bearer ${ownerToken}` } : {}
}
