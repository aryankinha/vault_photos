/**
 * Crypto context (cross-object AAD binding) — audit finding S3.
 *
 * v1 objects authenticate at most the chunk index as AAD, so chunks and packed
 * blobs are interchangeable between files/objects under the same vault key.
 * v2 binds a canonical context — kind + id + index — as AES-GCM additional
 * authenticated data, so a swapped object fails authentication.
 *
 * Version/mode disambiguation is EXPLICIT, never wire-sniffed:
 *   - the manifest entry carries `crypto_version: 2` for context-bound files
 *     (written by the upload pipeline; callers pass it to the decrypt APIs);
 *   - the packed/chunk wire layouts are unchanged, so there is no heuristic
 *     format detection and therefore no downgrade path;
 *   - a context-bound object NEVER falls back to legacy decryption when
 *     authentication fails (see decrypt.js / chunkEncrypt.js).
 *
 * This module is dependency-free and runs on the main thread, in Web Workers,
 * and in Node tests. Manifest/bundle-page context kinds exist for a future
 * migration but current manifest/bundle encryption stays legacy on purpose
 * (migrating them would rewrite every vault; deferred).
 */

export const CRYPTO_VERSION_LEGACY = 1
export const CRYPTO_VERSION_CONTEXT = 2
export const CRYPTO_VERSION_CURRENT = CRYPTO_VERSION_CONTEXT

/** Context kinds. 'manifest'/'bundle' are reserved for a future migration. */
export const CONTEXT_KINDS = Object.freeze(['file', 'chunk', 'manifest', 'bundle'])

const MAGIC = 'VPC2'
const MAGIC_BYTES = Uint8Array.from(MAGIC, (char) => char.charCodeAt(0))
const FLAG_HAS_ID = 1 << 0
const FLAG_HAS_INDEX = 1 << 1
const ID_PATTERN = /^[0-9a-zA-Z_.-]{1,64}$/
const MAX_INDEX = Number.MAX_SAFE_INTEGER

/** Canonical whole-file context for a media entry. */
export function fileContext(id) {
  return { kind: 'file', id }
}

/** Canonical chunk context for one chunk of a media entry. */
export function chunkContext(id, index) {
  return { kind: 'chunk', id, index }
}

/**
 * Resolve the crypto version of a manifest entry. Absent/undefined = legacy
 * (every existing vault). Unknown versions throw — we never silently downgrade
 * a mode we do not understand.
 */
export function resolveCryptoVersion(entry) {
  const version = entry?.crypto_version
  if (version === undefined || version === null) return CRYPTO_VERSION_LEGACY
  return assertSupportedCryptoVersion(version)
}

export function assertSupportedCryptoVersion(version) {
  if (version === CRYPTO_VERSION_LEGACY || version === CRYPTO_VERSION_CONTEXT) {
    return version
  }
  throw new Error(`Unsupported crypto version: ${version}`)
}

/**
 * Normalize + validate a context object.
 * @returns {{ kind: string, id?: string, index?: number }}
 */
export function normalizeCryptoContext(context) {
  if (!context || typeof context !== 'object') {
    throw new TypeError('Crypto context must be an object')
  }
  const { kind } = context
  if (!CONTEXT_KINDS.includes(kind)) {
    throw new RangeError(`Unknown crypto context kind: ${kind}`)
  }
  const normalized = { kind }
  if (context.id !== undefined && context.id !== null) {
    if (typeof context.id !== 'string' || !ID_PATTERN.test(context.id)) {
      throw new RangeError('Crypto context id must be a 1-64 char [0-9a-zA-Z_.-] string')
    }
    normalized.id = context.id
  }
  if (context.index !== undefined && context.index !== null) {
    if (!Number.isInteger(context.index) || context.index < 0 || context.index > MAX_INDEX) {
      throw new RangeError('Crypto context index must be a non-negative safe integer')
    }
    normalized.index = context.index
  }
  return normalized
}

/**
 * Canonical, unambiguous, deterministic context encoding:
 *
 *   "VPC2"                     4 bytes magic (context format version)
 *   flags                      1 byte  — bit0: id present, bit1: index present
 *   kindLen                    1 byte
 *   kind                       kindLen bytes (ASCII)
 *   [idLen + id]               1 + idLen bytes, only when flag bit0 set
 *   [index]                    8 bytes big-endian uint64, only when flag bit1 set
 *
 * Length-prefixed segments make the encoding injective: no two distinct
 * contexts can encode to the same bytes, so AAD binding cannot be confused.
 *
 * @param {{ kind: string, id?: string, index?: number }} context
 * @returns {Uint8Array}
 */
export function encodeCryptoContext(context) {
  const normalized = normalizeCryptoContext(context)
  const encoder = new TextEncoder()
  const kindBytes = encoder.encode(normalized.kind)
  const hasId = normalized.id !== undefined
  const hasIndex = normalized.index !== undefined
  const idBytes = hasId ? encoder.encode(normalized.id) : null

  const size = 4 + 1 + 1 + kindBytes.length
    + (hasId ? 1 + idBytes.length : 0)
    + (hasIndex ? 8 : 0)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)

  out.set(MAGIC_BYTES, 0)
  out[4] = (hasId ? FLAG_HAS_ID : 0) | (hasIndex ? FLAG_HAS_INDEX : 0)
  out[5] = kindBytes.length
  out.set(kindBytes, 6)

  let offset = 6 + kindBytes.length
  if (hasId) {
    out[offset] = idBytes.length
    out.set(idBytes, offset + 1)
    offset += 1 + idBytes.length
  }
  if (hasIndex) {
    view.setBigUint64(offset, BigInt(normalized.index), false)
  }
  return out
}

/**
 * Resolve the decrypt/encrypt mode from caller options.
 *
 * Options: { context?, cryptoVersion? }
 *   - no context, no version (or version 1)  → legacy mode (existing vaults)
 *   - context (+ version 2)                  → context mode, AAD-bound
 *
 * Contradictions throw instead of guessing, and crypto_version 2 without a
 * context throws rather than degrading to legacy (S3 downgrade protection).
 *
 * @returns {{ mode: 'legacy'|'context', aad: Uint8Array|null }}
 */
export function resolveCryptoMode(options = {}) {
  const { context, cryptoVersion } = options
  if (cryptoVersion !== undefined && cryptoVersion !== null) {
    assertSupportedCryptoVersion(cryptoVersion)
  }
  if (cryptoVersion === CRYPTO_VERSION_LEGACY && context) {
    throw new Error('Crypto context cannot be combined with crypto_version 1')
  }
  if (cryptoVersion === CRYPTO_VERSION_CONTEXT && !context) {
    throw new Error('crypto_version 2 requires a crypto context — refusing legacy fallback')
  }
  if (!context) return { mode: 'legacy', aad: null }
  return { mode: 'context', aad: encodeCryptoContext(context) }
}
