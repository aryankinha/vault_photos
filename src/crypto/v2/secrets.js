import { bytes, equalBytes, utf8 } from './binary.js'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CHECK_ALPHABET = `${ALPHABET}*~$=U`
const PREFIXES = { secret: 'SK2', recovery: 'RK2' }

/** Crockford Base32 with its standard modulo-37 check symbol, in groups of 4. */
export function encodeSecret(value, kind) {
  const raw = bytes(value)
  if (raw.length !== 32 || !Object.hasOwn(PREFIXES, kind)) throw new Error('Invalid secret')
  let buffer = 0
  let bits = 0
  let encoded = ''
  for (const byte of raw) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      encoded += ALPHABET[(buffer >>> bits) & 31]
    }
    buffer &= (1 << bits) - 1
  }
  if (bits) encoded += ALPHABET[(buffer << (5 - bits)) & 31]
  let check = 0
  for (const symbol of encoded) check = (check * 32 + ALPHABET.indexOf(symbol)) % 37
  return `${PREFIXES[kind]}-${encoded.match(/.{1,4}/g).join('-')}-${CHECK_ALPHABET[check]}`
}

export function decodeSecret(text, kind) {
  if (typeof text !== 'string' || text.length > 128 || !Object.hasOwn(PREFIXES, kind)) throw new Error('Invalid key text')
  const normalized = text.trim().toUpperCase().replace(/[\s-]/g, '')
  const prefix = PREFIXES[kind]
  if (!normalized.startsWith(prefix)) throw new Error('Invalid key text')
  // Human-friendly Crockford aliases apply to the payload and check symbol.
  const encoded = normalized.slice(prefix.length).replace(/O/g, '0').replace(/[IL]/g, '1')
  if (encoded.length !== 53) throw new Error('Invalid key text')
  const raw = new Uint8Array(32)
  let buffer = 0
  let bits = 0
  let offset = 0
  let check = 0
  try {
    for (const symbol of encoded.slice(0, -1)) {
      const value = ALPHABET.indexOf(symbol)
      if (value < 0) throw new Error('Invalid key text')
      check = (check * 32 + value) % 37
      buffer = (buffer << 5) | value
      bits += 5
      if (bits >= 8) {
        bits -= 8
        raw[offset++] = (buffer >>> bits) & 255
      }
      buffer &= (1 << bits) - 1
    }
    if (offset !== 32 || buffer !== 0 || CHECK_ALPHABET[check] !== encoded.at(-1)) throw new Error('Invalid key text')
    return raw
  } catch (error) {
    raw.fill(0)
    throw error
  }
}

/** Consume a raw SK buffer; the caller must not use it after this operation. */
export async function importSecretKey(value) {
  const raw = bytes(value)
  try {
    if (raw.length !== 32) throw new Error('Invalid Secret Key')
    return await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  } finally { raw.fill(0) }
}

/** Consume a raw RK buffer; preserve only its non-extractable HKDF key. */
export async function importRecoveryKey(value) {
  const raw = bytes(value)
  try {
    if (raw.length !== 32) throw new Error('Invalid Recovery Key')
    return await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey'])
  } finally { raw.fill(0) }
}

export function confirmationGroups(text) {
  return text.split('-').slice(-2).join('-')
}

export function confirmSavedKey(text, confirmation) {
  if (typeof confirmation !== 'string' || confirmation.length > 16) return false
  const normalize = (value) => value.trim().toUpperCase().replace(/[\s-]/g, '')
  return equalBytes(utf8(normalize(confirmationGroups(text))), utf8(normalize(confirmation)))
}
