/**
 * KDF parameter sidecar (audit finding S5).
 *
 * Argon2id parameters are currently hard-coded, so strengthening them later
 * would break every existing vault (old vaults must keep deriving with the old
 * parameters). This module pins the CURRENT parameters as the explicit default
 * and provides a sidecar codec so the parameters can be persisted beside the
 * vault salt in a future worker route.
 *
 * IMPORTANT: the sidecar upload route does NOT exist yet — nothing here is
 * wired into the worker API on purpose. Persisting a sidecar must never change
 * or re-upload the salt itself (that would brick existing unlocks).
 *
 * Dependency-free: usable from the main thread, workers, and Node tests.
 */
export const KDF_ALGORITHM = 'argon2id'
// Argon2 v19 (0x13) — RFC 9106. argon2-browser's ArgonType.Argon2id encodes v19.
export const KDF_ALGORITHM_VERSION = 19

/** Frozen defaults matching the historic hard-coded derivation exactly. */
export const DEFAULT_KDF_PARAMS = Object.freeze({
  alg: KDF_ALGORITHM,
  argon2Version: KDF_ALGORITHM_VERSION,
  time: 3,
  memKiB: 65536,
  parallelism: 4,
  hashLen: 32,
})

const LIMITS = {
  time: [1, 16],
  memKiB: [8192, 1048576],
  parallelism: [1, 16],
  hashLen: [32, 64],
}

/**
 * Validate and normalize KDF parameters. Throws RangeError on anything the
 * current derivation could not honour — never silently clamp.
 *
 * @returns {Readonly<{alg, argon2Version, time, memKiB, parallelism, hashLen}>}
 */
export function validateKdfParams(params) {
  if (!params || typeof params !== 'object') {
    throw new TypeError('KDF params must be an object')
  }
  if (params.alg !== KDF_ALGORITHM) {
    throw new RangeError(`Unsupported KDF algorithm: ${params.alg}`)
  }
  if (params.argon2Version !== KDF_ALGORITHM_VERSION) {
    throw new RangeError(`Unsupported Argon2 version: ${params.argon2Version}`)
  }
  const normalized = { alg: params.alg, argon2Version: params.argon2Version }
  for (const [field, [min, max]] of Object.entries(LIMITS)) {
    const value = params[field]
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new RangeError(`KDF ${field} must be an integer in [${min}, ${max}]`)
    }
    normalized[field] = value
  }
  return Object.freeze(normalized)
}

/**
 * Encode params as the JSON sidecar text to persist beside the salt.
 * @param {object} [params] — defaults to DEFAULT_KDF_PARAMS
 * @returns {string}
 */
export function encodeKdfParamsSidecar(params) {
  return JSON.stringify({ sidecar: 1, ...validateKdfParams(params ?? DEFAULT_KDF_PARAMS) })
}

/**
 * Decode a sidecar (JSON string or bytes) back into validated params.
 * @param {string|ArrayBuffer|Uint8Array} input
 */
export function decodeKdfParamsSidecar(input) {
  let text = input
  if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
    text = new TextDecoder().decode(bytes)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('KDF params sidecar is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || parsed.sidecar !== 1) {
    throw new Error('Not a KDF params sidecar')
  }
  return validateKdfParams(parsed)
}
