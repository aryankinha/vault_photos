export const utf8 = (value) => new TextEncoder().encode(value)

export function bytes(value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  throw new TypeError('Expected bytes')
}

export function concat(...parts) {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) { output.set(part, offset); offset += part.length }
  return output
}

export function uint32(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new Error('Invalid uint32')
  const result = new Uint8Array(4)
  new DataView(result.buffer).setUint32(0, value, false)
  return result
}

export function uint64(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid uint64')
  const result = new Uint8Array(8)
  new DataView(result.buffer).setBigUint64(0, BigInt(value), false)
  return result
}

export function lengthPrefixed(...parts) {
  return concat(...parts.flatMap((part) => [uint32(part.length), part]))
}

export function toHex(value) {
  return Array.from(bytes(value), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function fromHex(value, length) {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${length * 2}}$`).test(value)) throw new Error('Invalid hex')
  return Uint8Array.from(value.match(/../g), (part) => Number.parseInt(part, 16))
}

export function toBase64(value) {
  return btoa(String.fromCharCode(...bytes(value)))
}

export function fromBase64(value, length) {
  // Every keyring field has a fixed, small length. Bound before decoding.
  if (typeof value !== 'string' || value.length !== 4 * Math.ceil(length / 3)) throw new Error('Invalid base64')
  const result = Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
  if (result.length !== length || toBase64(result) !== value) throw new Error('Invalid base64')
  return result
}

export function equalBytes(left, right) {
  const a = bytes(left)
  const b = bytes(right)
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index]
  return difference === 0
}

export function exactFields(object, names) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error('Invalid object')
  const fields = Object.keys(object)
  if (fields.length !== names.length || names.some((name) => !Object.hasOwn(object, name))) throw new Error('Invalid fields')
}
