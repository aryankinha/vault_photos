/**
 * Cloudflare Access (Zero Trust) application-token verification.
 *
 * Why this exists: the worker origin allow-list (`ALLOWED_ORIGIN`) is CORS,
 * not authentication — any non-browser client can forge an `Origin` header, and
 * any website can drive a browser. The only real authentication for the vault
 * is a Cloudflare Access policy in front of the Worker, which injects a signed
 * `Cf-Access-Jwt-Assertion` header on every request it forwards. This module
 * proves that header was signed by Cloudflare Access for *this* team and *this*
 * application. `Origin`/`Referer`/`CF-Connecting-IP` are never trusted here.
 *
 * Contract (integration with `worker/index.js`):
 *
 *   const identity = await verifyAccess(request, env)
 *
 *   - Resolves to a frozen identity object on success.
 *   - Rejects with an {@link AccessAuthError} that carries `status` 401
 *     (the caller is not authenticated / not allowed) or 503 (this Worker is
 *     misconfigured, or Access key material could not be obtained).
 *   - Throws nothing else for auth failures; unexpected internal errors are
 *     converted into 503 by the guards below, so callers only ever need to
 *     handle `AccessAuthError` plus their own errors.
 *
 * Environment (all fail closed — there is deliberately no bypass flag):
 *   - `ACCESS_TEAM_DOMAIN` — required. `https://<team>.cloudflareaccess.com`
 *     with no path, port, credentials, query or fragment. The JWKS URL is
 *     *constructed* from this value plus a fixed path; it is never taken from a
 *     token, a request, or a response.
 *   - `ACCESS_AUD` — required. The Access application's AUD tag.
 *   - `ACCESS_EMAILS` — optional comma-separated email allow-list. When unset,
 *     any identity (including service tokens) that Access authenticated is
 *     accepted; when set, a matching `email` claim is mandatory.
 *
 * Security properties:
 *   - Only the `Cf-Access-Jwt-Assertion` header is read. The `CF_Authorization`
 *     cookie is NOT accepted as a fallback (a cookie can outlive/replay and is
 *     not guaranteed to be present; Cloudflare recommends the header).
 *   - RS256 is enforced from a fixed constant. The token's `alg` can never
 *     select the verification algorithm, and `none` / HS* / embedded
 *     `jwk`/`jku`/`x5u`/`x5c` / `crit` headers are rejected outright, so
 *     "algorithm confusion" (HMAC keyed with the public modulus) cannot work.
 *   - The JWKS request is pinned to the validated team host, refuses redirects,
 *     is aborted after {@link JWKS_FETCH_TIMEOUT_MS}, and is read through a
 *     byte-bounded reader so a hostile/large response cannot exhaust the isolate.
 *   - JWKS entries must be RSA signature keys with `alg` RS256, `use` "sig",
 *     exponent 65537 and a >= 2048-bit modulus, and must carry no private
 *     material.
 *   - Claim checks (`iss` exact, `aud` array-or-string, `exp`/`nbf`/`iat`
 *     numeric with a hard 30 s clock skew, `type` app) happen *after* signature
 *     verification, so nothing untrusted influences key selection or policy.
 *   - Nothing here logs. The module has no `console` usage, and errors carry
 *     only a code, a status and a short `reason` — never the assertion, the
 *     cookie, the JWKS body, PEM material or key bytes.
 *
 * Wire format verified against the Cloudflare docs (fetched 2026-10-17):
 *   - Header `{ "alg": "RS256", "kid": "<hex>", "typ": "JWT" }`.
 *   - Identity payload includes `aud` (array), `email`, `exp`, `iat`, `nbf`,
 *     `iss` = `https://<team>.cloudflareaccess.com`, `type: "app"`,
 *     `identity_nonce`, `sub`, `country`; service tokens swap `email` for
 *     `common_name` and carry `sub: ""`.
 *   - JWKS at `/cdn-cgi/access/certs` returns `{ keys: [JWK x2], public_cert,
 *     public_certs }`; `keys` is the source of truth (do not use
 *     `public_cert`, which can be a stale cached value).
 */

/** Fixed JWKS path on the team host. Never configurable. */
export const JWKS_PATH = '/cdn-cgi/access/certs'

/** Only issuer suffix accepted for `ACCESS_TEAM_DOMAIN`. */
export const TEAM_DOMAIN_SUFFIX = '.cloudflareaccess.com'

/** Hard abort budget for the JWKS request. */
export const JWKS_FETCH_TIMEOUT_MS = 2000

/** Hard cap on the JWKS response body. */
export const JWKS_MAX_BYTES = 64 * 1024

/** How long a fetched key set is used without re-fetching. */
export const JWKS_TTL_MS = 15 * 60 * 1000

/**
 * Resilience-only window: if a re-fetch fails, keys are still trusted this long
 * past their TTL. After that, verification fails closed with 503. Cloudflare
 * keeps a rotated-out key valid for 7 days, so 24 h stays inside that window.
 */
export const JWKS_STALE_MS = 24 * 60 * 60 * 1000

/** Cloudflare publishes exactly two keys; refuse absurd sets. */
export const JWKS_MAX_KEYS = 8

/** Floor for an accepted RSA modulus. */
export const MIN_RSA_MODULUS_BITS = 2048

/** Fixed clock tolerance. Not configurable, by design. */
export const CLOCK_SKEW_SECONDS = 30

/** Guard rail before any base64 parsing (Access tokens are ~1-3 KB). */
export const MAX_TOKEN_LENGTH = 8192

/** Minimum spacing between forced refreshes triggered by an unknown `kid`. */
export const FORCED_REFRESH_MIN_INTERVAL_MS = 5000

/** Upper bound on the optional email allow-list. */
export const MAX_ALLOWED_EMAILS = 500

const TOKEN_ALG = 'RS256'
const SIGNING_ALG = 'RSASSA-PKCS1-v1_5'
const SIGNING_HASH = 'SHA-256'
const RSA_EXPONENT = 'AQAB' // 65537, the exponent Cloudflare publishes
const SERVICE_TOKEN_SUFFIX = '.access'

// kid is a hex digest upstream; keep the charset tight so cache lookups can
// never be influenced by header injection characters.
const KID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const AUD_PATTERN = /^[A-Za-z0-9_-]{8,256}$/
const SUBDOMAIN_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/
const JWT_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true })
const TEXT_ENCODER = new TextEncoder()

/**
 * Typed failure. `status` is only ever 401 (caller) or 503 (us); `code` and
 * `reason` are safe to log, `message` is safe to return to a caller but says
 * nothing about the token.
 */
export class AccessAuthError extends Error {
  constructor(code, message, status, reason = null) {
    super(message)
    this.name = 'AccessAuthError'
    this.code = code
    this.status = status === 503 ? 503 : 401
    this.reason = reason
    this.retryable = this.status === 503
  }

  /** Safe for structured logs: contains no token, key or cookie material. */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      status: this.status,
      reason: this.reason,
      retryable: this.retryable,
    }
  }
}

function unauthorized(code, message) {
  return new AccessAuthError(code, message, 401)
}

function misconfigured(code, message, reason = null) {
  return new AccessAuthError(code, message, 503, reason)
}

/**
 * Per-isolate JWKS cache. Metadata only: kid -> imported verify key plus
 * timestamps. No PEM, no JWK fields, no response bodies, no tokens.
 * @type {Map<string, {origin: string, keys: Map<string, {kid: string, alg: string, key: CryptoKey}>, fetchedAt: number, expiresAt: number, staleUntil: number, lastForcedAt: number}>}
 */
const jwksCache = new Map()

/** De-duplicates concurrent refreshes for one team host. */
const inflightRefreshes = new Map()

/**
 * Validates the Access configuration without touching the network.
 * Use at boot / in a health check so a missing var surfaces as an operator
 * error instead of a stream of 401s.
 *
 * @param {Record<string, unknown>} env
 * @returns {{teamDomain: string, audience: string, emailCount: number}}
 */
export function checkAccessConfig(env) {
  const config = loadConfig(env)
  return {
    teamDomain: config.origin,
    audience: config.audience,
    emailCount: config.emails ? config.emails.size : 0,
  }
}

/**
 * Drops every cached key set. Intended for tests and for responding to a
 * manual key rotation; normal operation relies on the TTL.
 */
export function clearAccessJwksCache() {
  jwksCache.clear()
  inflightRefreshes.clear()
}

/**
 * Verifies the Cloudflare Access application token on `request`.
 *
 * @param {Request} request
 * @param {Record<string, unknown>} env worker bindings/vars
 * @returns {Promise<Readonly<{issuer: string, audience: string, subject: string|null, email: string|null, commonName: string|null, serviceToken: boolean, country: string|null, identityNonce: string|null, issuedAt: number|null, expiresAt: number, expiresInSeconds: number, keyId: string}>>}
 */
export async function verifyAccess(request, env) {
  const config = loadConfig(env)
  const token = readAssertion(request)
  const parsed = parseToken(token)
  const key = await resolveSigningKey(config, parsed.kid)
  await assertSignature(parsed, key)
  const payload = parsePayload(parsed.payloadSegment)
  const nowSeconds = Math.floor(Date.now() / 1000)
  const claims = validateClaims(payload, config, nowSeconds)
  return buildIdentity(payload, claims, parsed.kid, config, nowSeconds)
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function loadConfig(env) {
  const source = env && typeof env === 'object' ? env : {}
  const rawDomain = typeof source.ACCESS_TEAM_DOMAIN === 'string'
    ? source.ACCESS_TEAM_DOMAIN.trim()
    : ''
  const rawAudience = typeof source.ACCESS_AUD === 'string' ? source.ACCESS_AUD.trim() : ''

  if (!rawDomain && !rawAudience) {
    throw misconfigured(
      'ACCESS_NOT_CONFIGURED',
      'Cloudflare Access is not configured: set ACCESS_TEAM_DOMAIN and ACCESS_AUD',
      'missing_config',
    )
  }

  const origin = parseTeamOrigin(rawDomain)

  if (!rawAudience) {
    throw misconfigured(
      'ACCESS_AUD_MISSING',
      'Cloudflare Access is not configured: set ACCESS_AUD',
      'missing_aud',
    )
  }
  if (!AUD_PATTERN.test(rawAudience)) {
    throw misconfigured(
      'ACCESS_AUD_INVALID',
      'Cloudflare Access is misconfigured: ACCESS_AUD is not a valid audience tag',
      'bad_aud',
    )
  }

  return Object.freeze({
    origin,
    audience: rawAudience,
    emails: parseEmailAllowlist(source.ACCESS_EMAILS),
  })
}

/**
 * Strict `https://<team>.cloudflareaccess.com` origin parser. Rejects userinfo,
 * ports, paths, queries, fragments, trailing dots, IP literals and any other
 * host, so the JWKS fetch can only ever target an Access team host.
 */
function parseTeamOrigin(value) {
  if (!value) {
    throw misconfigured(
      'ACCESS_TEAM_DOMAIN_MISSING',
      'Cloudflare Access is not configured: set ACCESS_TEAM_DOMAIN to https://<team>.cloudflareaccess.com',
      'missing_team_domain',
    )
  }
  if (hasWhitespaceOrControl(value)) {
    throw misconfigured(
      'ACCESS_TEAM_DOMAIN_INVALID',
      'Cloudflare Access is misconfigured: ACCESS_TEAM_DOMAIN must be a bare https origin',
      'whitespace',
    )
  }

  let url
  try {
    url = new URL(value)
  } catch {
    url = null
  }

  const host = url ? url.hostname.toLowerCase() : ''
  const sub = host.endsWith(TEAM_DOMAIN_SUFFIX) ? host.slice(0, -TEAM_DOMAIN_SUFFIX.length) : ''
  const valid =
    url !== null &&
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    url.search === '' &&
    url.hash === '' &&
    (url.pathname === '' || url.pathname === '/') &&
    sub !== '' &&
    SUBDOMAIN_PATTERN.test(sub)

  if (!valid) {
    throw misconfigured(
      'ACCESS_TEAM_DOMAIN_INVALID',
      'Cloudflare Access is misconfigured: ACCESS_TEAM_DOMAIN must be https://<team>.cloudflareaccess.com with no path, port, credentials, query or fragment',
      'bad_team_domain',
    )
  }

  return `https://${host}`
}

/** True for any whitespace or C0/DEL control character (no regex escapes). */
function hasWhitespaceOrControl(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x20 || code === 0x7f) return true
  }
  return false
}

function parseEmailAllowlist(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') {
    throw misconfigured(
      'ACCESS_EMAILS_INVALID',
      'Cloudflare Access is misconfigured: ACCESS_EMAILS must be a comma-separated string',
      'bad_email_allowlist',
    )
  }

  const emails = new Set()
  for (const part of value.split(',')) {
    const email = part.trim().toLowerCase()
    if (!email) continue
    if (emails.size >= MAX_ALLOWED_EMAILS) {
      throw misconfigured(
        'ACCESS_EMAILS_INVALID',
        `Cloudflare Access is misconfigured: ACCESS_EMAILS may list at most ${MAX_ALLOWED_EMAILS} addresses`,
        'email_allowlist_too_large',
      )
    }
    emails.add(email)
  }

  return emails.size > 0 ? emails : null
}

// ---------------------------------------------------------------------------
// Token extraction and parsing
// ---------------------------------------------------------------------------

function readAssertion(request) {
  const headers = request ? request.headers : null
  const raw = headers && typeof headers.get === 'function'
    ? headers.get('cf-access-jwt-assertion')
    : null

  if (raw === null || raw === undefined) {
    throw unauthorized(
      'ACCESS_ASSERTION_MISSING',
      'Cloudflare Access authentication is required for this request',
    )
  }

  const token = String(raw).trim()
  if (token.length === 0) {
    throw unauthorized(
      'ACCESS_ASSERTION_MISSING',
      'Cloudflare Access authentication is required for this request',
    )
  }
  if (token.length > MAX_TOKEN_LENGTH) {
    throw unauthorized('ACCESS_TOKEN_MALFORMED', 'Cloudflare Access token is not acceptable')
  }
  if (token.includes(',')) {
    // A duplicated header is joined with ", " and can never be a JWT.
    throw unauthorized('ACCESS_TOKEN_MALFORMED', 'Cloudflare Access token is not acceptable')
  }
  return token
}

function parseToken(token) {
  const parts = token.split('.')
  if (parts.length !== 3) {
    throw unauthorized('ACCESS_TOKEN_MALFORMED', 'Cloudflare Access token is not acceptable')
  }

  const [headerSegment, payloadSegment, signatureSegment] = parts
  if (!JWT_SEGMENT_PATTERN.test(headerSegment) ||
      !JWT_SEGMENT_PATTERN.test(payloadSegment) ||
      !JWT_SEGMENT_PATTERN.test(signatureSegment)) {
    throw unauthorized('ACCESS_TOKEN_MALFORMED', 'Cloudflare Access token is not acceptable')
  }

  let signature
  try {
    signature = decodeBase64Url(signatureSegment)
  } catch {
    throw unauthorized('ACCESS_TOKEN_MALFORMED', 'Cloudflare Access token is not acceptable')
  }

  const header = parseJsonSegment(headerSegment, 'header')

  // `alg` is compared against a constant; the token never picks the algorithm.
  if (header.alg !== TOKEN_ALG) {
    throw unauthorized(
      'ACCESS_ALG_UNSUPPORTED',
      'Cloudflare Access token is signed with an unsupported algorithm',
    )
  }
  // `typ` is optional in the wild; when present it must be a JWT media type.
  if (header.typ !== undefined && !(typeof header.typ === 'string' && /^(jwt|at\+jwt)$/i.test(header.typ))) {
    throw unauthorized('ACCESS_TOKEN_MALFORMED', 'Cloudflare Access token is not acceptable')
  }
  // No critical extensions are supported, and embedded/remote key material is
  // never used (RFC 8725: reject rather than ignore).
  if (header.crit !== undefined || header.jku !== undefined || header.x5u !== undefined ||
      header.jwk !== undefined || header.x5c !== undefined) {
    throw unauthorized('ACCESS_TOKEN_MALFORMED', 'Cloudflare Access token is not acceptable')
  }

  const kid = header.kid
  if (typeof kid !== 'string' || !KID_PATTERN.test(kid)) {
    throw unauthorized('ACCESS_KEY_UNKNOWN', 'Cloudflare Access token references an unknown key')
  }

  return {
    kid,
    payloadSegment,
    signature,
    signingInput: `${headerSegment}.${payloadSegment}`,
  }
}

function parsePayload(payloadSegment) {
  const payload = parseJsonSegment(payloadSegment, 'payload')
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    throw unauthorized('ACCESS_TOKEN_EXPIRED', 'Cloudflare Access token has expired')
  }
  return payload
}

function parseJsonSegment(segment, label) {
  let bytes
  try {
    bytes = decodeBase64Url(segment)
  } catch {
    throw unauthorized('ACCESS_TOKEN_MALFORMED', `Cloudflare Access token ${label} is not acceptable`)
  }

  let value
  try {
    value = JSON.parse(TEXT_DECODER.decode(bytes))
  } catch {
    throw unauthorized('ACCESS_TOKEN_MALFORMED', `Cloudflare Access token ${label} is not acceptable`)
  }

  if (!isPlainObject(value)) {
    throw unauthorized('ACCESS_TOKEN_MALFORMED', `Cloudflare Access token ${label} is not acceptable`)
  }
  return value
}

function decodeBase64Url(segment) {
  if (!JWT_SEGMENT_PATTERN.test(segment) || segment.length % 4 === 1) {
    throw new Error('invalid base64url')
  }
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (segment.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

async function assertSignature(parsed, key) {
  let verified
  try {
    verified = await crypto.subtle.verify(
      { name: SIGNING_ALG },
      key,
      parsed.signature,
      TEXT_ENCODER.encode(parsed.signingInput),
    )
  } catch {
    verified = false
  }

  if (verified !== true) {
    throw unauthorized(
      'ACCESS_SIGNATURE_INVALID',
      'Cloudflare Access token signature verification failed',
    )
  }
}

/**
 * Returns a verify key for `kid`.
 *
 *   - A cached key set inside its TTL is used with no network call at all.
 *   - Past the TTL (or with an unknown `kid`, which is what a key rotation
 *     looks like) the set is refreshed at most once per
 *     {@link FORCED_REFRESH_MIN_INTERVAL_MS}.
 *   - If a refresh fails, the previous set is used only while it is still
 *     inside the {@link JWKS_STALE_MS} window. Beyond that, verification fails
 *     closed with 503 rather than trusting keys of unbounded age.
 */
async function resolveSigningKey(config, kid) {
  const now = Date.now()
  const cached = jwksCache.get(config.origin)
  const cachedRecord = cached ? cached.keys.get(kid) : undefined

  // Fast path: a known kid inside the TTL needs no network access.
  if (cachedRecord && now < cached.expiresAt) return cachedRecord.key

  // Cold cache, or the cached set is past its trust window: a refresh is
  // mandatory and any failure is fatal.
  if (!cached || now >= cached.staleUntil) {
    const entry = await refreshKeys(config, { forced: false })
    const record = entry.keys.get(kid)
    if (record) return record.key
    throw unknownKid(entry)
  }

  // Inside the stale window: try one refresh (key rotation), else keep using
  // what we have rather than failing every request during an Access outage.
  if (now - cached.lastForcedAt >= FORCED_REFRESH_MIN_INTERVAL_MS) {
    try {
      const entry = await refreshKeys(config, { forced: true })
      const record = entry.keys.get(kid)
      if (record) return record.key
      throw unknownKid(entry)
    } catch (error) {
      if (!(error instanceof AccessAuthError)) throw error
      if (error.code !== 'ACCESS_KEYS_UNAVAILABLE' && error.code !== 'ACCESS_KEYS_INVALID') {
        throw error
      }
      // Fall through to the cached set.
    }
  }

  if (cachedRecord) return cachedRecord.key
  throw unknownKid(cached)
}

function unknownKid(entry) {
  return entry && entry.keys.size > 0
    ? unauthorized('ACCESS_KEY_UNKNOWN', 'Cloudflare Access token references an unknown key')
    : misconfigured(
        'ACCESS_KEYS_UNAVAILABLE',
        'Cloudflare Access signing keys could not be obtained',
        'no_keys',
      )
}

function refreshKeys(config, { forced }) {
  const pending = inflightRefreshes.get(config.origin)
  if (pending) return pending

  const request = loadKeys(config, forced)
    .catch((error) => {
      // A failed *forced* refresh must not become a per-request fetch
      // amplifier: stamp the attempt so the interval rate limit still applies.
      if (forced) {
        const cached = jwksCache.get(config.origin)
        if (cached) cached.lastForcedAt = Date.now()
      }
      throw error
    })
  inflightRefreshes.set(config.origin, request)
  const clear = () => {
    if (inflightRefreshes.get(config.origin) === request) inflightRefreshes.delete(config.origin)
  }
  request.then(clear, clear)
  return request
}

async function loadKeys(config, forced) {
  const response = await fetchJwks(config)
  const body = await readBoundedText(response)
  const jwks = parseJwks(body)

  const keys = new Map()
  for (const jwk of jwks) {
    const record = await importSigningKey(jwk)
    if (keys.has(record.kid)) throw invalidKey('duplicate_kid')
    keys.set(record.kid, record)
  }

  const now = Date.now()
  const entry = {
    origin: config.origin,
    keys,
    fetchedAt: now,
    expiresAt: now + JWKS_TTL_MS,
    staleUntil: now + JWKS_STALE_MS,
    lastForcedAt: forced ? now : 0,
  }
  jwksCache.set(config.origin, entry)
  return entry
}

/**
 * The only outbound request this module can make: the fixed certs path on the
 * allow-listed team host. Redirects are refused so a 30x can never move the
 * fetch to another origin.
 */
async function fetchJwks(config) {
  const url = trustedJwksUrl(config.origin)

  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
    })
  } catch {
    throw misconfigured(
      'ACCESS_KEYS_UNAVAILABLE',
      'Cloudflare Access signing keys could not be fetched',
      'fetch_failed',
    )
  }

  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    throw misconfigured(
      'ACCESS_KEYS_UNAVAILABLE',
      'Cloudflare Access signing keys could not be fetched',
      'redirect_refused',
    )
  }
  if (response.status !== 200) {
    throw misconfigured(
      'ACCESS_KEYS_UNAVAILABLE',
      'Cloudflare Access signing keys could not be fetched',
      `status_${response.status}`,
    )
  }
  return response
}

/** Re-derives and re-checks the JWKS URL: defence in depth around `fetch`. */
function trustedJwksUrl(origin) {
  let url
  try {
    url = new URL(`${origin}${JWKS_PATH}`)
  } catch {
    throw misconfigured(
      'ACCESS_TEAM_DOMAIN_INVALID',
      'Cloudflare Access is misconfigured: ACCESS_TEAM_DOMAIN must be https://<team>.cloudflareaccess.com',
      'bad_team_domain',
    )
  }

  const host = url.hostname.toLowerCase()
  const sub = host.endsWith(TEAM_DOMAIN_SUFFIX) ? host.slice(0, -TEAM_DOMAIN_SUFFIX.length) : ''
  if (url.protocol !== 'https:' || url.pathname !== JWKS_PATH || url.port !== '' ||
      url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' ||
      sub === '' || !SUBDOMAIN_PATTERN.test(sub)) {
    throw misconfigured(
      'ACCESS_TEAM_DOMAIN_INVALID',
      'Cloudflare Access is misconfigured: ACCESS_TEAM_DOMAIN must be https://<team>.cloudflareaccess.com',
      'bad_team_domain',
    )
  }
  return url.toString()
}

/** Byte-bounded body read: never buffers an unbounded response. */
async function readBoundedText(response) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > JWKS_MAX_BYTES) {
    throw misconfigured(
      'ACCESS_KEYS_INVALID',
      'Cloudflare Access signing keys response is not acceptable',
      'too_large',
    )
  }

  let bytes
  const body = response.body
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > JWKS_MAX_BYTES) {
          await reader.cancel()
          throw misconfigured(
            'ACCESS_KEYS_INVALID',
            'Cloudflare Access signing keys response is not acceptable',
            'too_large',
          )
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
  } else {
    bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > JWKS_MAX_BYTES) {
      throw misconfigured(
        'ACCESS_KEYS_INVALID',
        'Cloudflare Access signing keys response is not acceptable',
        'too_large',
      )
    }
  }

  try {
    return TEXT_DECODER.decode(bytes)
  } catch {
    throw misconfigured(
      'ACCESS_KEYS_INVALID',
      'Cloudflare Access signing keys response is not acceptable',
      'bad_encoding',
    )
  }
}

function parseJwks(body) {
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    throw misconfigured(
      'ACCESS_KEYS_INVALID',
      'Cloudflare Access signing keys response is not acceptable',
      'bad_json',
    )
  }

  if (!isPlainObject(parsed) || !Array.isArray(parsed.keys) || parsed.keys.length === 0) {
    throw misconfigured(
      'ACCESS_KEYS_INVALID',
      'Cloudflare Access signing keys response is not acceptable',
      'no_keys',
    )
  }
  if (parsed.keys.length > JWKS_MAX_KEYS) {
    throw misconfigured(
      'ACCESS_KEYS_INVALID',
      'Cloudflare Access signing keys response is not acceptable',
      'too_many_keys',
    )
  }
  return parsed.keys
}

async function importSigningKey(jwk) {
  if (!isPlainObject(jwk)) throw invalidKey('bad_key')
  if (jwk.kty !== 'RSA') throw invalidKey('bad_kty')
  if (jwk.alg !== undefined && jwk.alg !== TOKEN_ALG) throw invalidKey('bad_alg')
  if (jwk.use !== undefined && jwk.use !== 'sig') throw invalidKey('bad_use')
  // Cloudflare's JWKS omits `key_ops`, but a real exported JWK carries
  // `key_ops: ['verify']`. Accept only that (or its absence); never accept
  // signing/decryption operations or a malformed value.
  if (jwk.key_ops !== undefined) {
    if (!Array.isArray(jwk.key_ops) ||
        jwk.key_ops.some((op) => typeof op !== 'string') ||
        jwk.key_ops.some((op) => op !== 'verify')) {
      throw invalidKey('bad_key_ops')
    }
  }
  // Reject any private RSA material, not just `d` (defence in depth).
  if (jwk.d !== undefined || jwk.p !== undefined || jwk.q !== undefined ||
      jwk.dp !== undefined || jwk.dq !== undefined || jwk.qi !== undefined ||
      jwk.oth !== undefined) throw invalidKey('private_key_material')
  if (typeof jwk.kid !== 'string' || !KID_PATTERN.test(jwk.kid)) throw invalidKey('bad_kid')
  if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string') throw invalidKey('missing_modulus')
  if (jwk.e !== RSA_EXPONENT) throw invalidKey('bad_exponent')
  if (rsaModulusBits(jwk.n) < MIN_RSA_MODULUS_BITS) throw invalidKey('weak_modulus')

  let key
  try {
    key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: TOKEN_ALG },
      { name: SIGNING_ALG, hash: SIGNING_HASH },
      false,
      ['verify'],
    )
  } catch {
    throw invalidKey('import_failed')
  }

  return { kid: jwk.kid, alg: TOKEN_ALG, key }
}

function invalidKey(reason) {
  return misconfigured(
    'ACCESS_KEYS_INVALID',
    'Cloudflare Access signing keys response is not acceptable',
    reason,
  )
}

function rsaModulusBits(base64UrlModulus) {
  let bytes
  try {
    bytes = decodeBase64Url(base64UrlModulus)
  } catch {
    throw invalidKey('bad_modulus')
  }

  let start = 0
  while (start < bytes.length && bytes[start] === 0) start += 1
  if (start >= bytes.length) throw invalidKey('bad_modulus')

  return (bytes.length - start - 1) * 8 + (32 - Math.clz32(bytes[start]))
}

// ---------------------------------------------------------------------------
// Claims and identity
// ---------------------------------------------------------------------------

function validateClaims(payload, config, nowSeconds) {
  // `iss` must be the exact team origin — no trailing slash, no subdomain.
  if (typeof payload.iss !== 'string' || payload.iss !== config.origin) {
    throw unauthorized(
      'ACCESS_ISSUER_INVALID',
      'Cloudflare Access token was issued for a different issuer',
    )
  }

  // `aud` is an array in Access application tokens; tolerate a bare string.
  const audiences = Array.isArray(payload.aud)
    ? payload.aud
    : typeof payload.aud === 'string'
      ? [payload.aud]
      : null
  if (!audiences || audiences.length === 0) {
    throw unauthorized(
      'ACCESS_AUDIENCE_INVALID',
      'Cloudflare Access token is not valid for this application',
    )
  }
  let audience = null
  for (const candidate of audiences) {
    if (typeof candidate === 'string' && timingSafeEqual(candidate, config.audience)) {
      audience = candidate
      break
    }
  }
  if (audience === null) {
    throw unauthorized(
      'ACCESS_AUDIENCE_INVALID',
      'Cloudflare Access token is not valid for this application',
    )
  }

  if (!Number.isFinite(payload.exp) || payload.exp <= nowSeconds - CLOCK_SKEW_SECONDS) {
    throw unauthorized('ACCESS_TOKEN_EXPIRED', 'Cloudflare Access token has expired')
  }
  if (payload.nbf !== undefined &&
      (!Number.isFinite(payload.nbf) || payload.nbf > nowSeconds + CLOCK_SKEW_SECONDS)) {
    throw unauthorized(
      'ACCESS_TOKEN_NOT_YET_VALID',
      'Cloudflare Access token is not valid yet',
    )
  }
  if (payload.iat !== undefined &&
      (!Number.isFinite(payload.iat) || payload.iat > nowSeconds + CLOCK_SKEW_SECONDS)) {
    throw unauthorized(
      'ACCESS_TOKEN_NOT_YET_VALID',
      'Cloudflare Access token is not valid yet',
    )
  }
  if (payload.type !== undefined && payload.type !== 'app') {
    throw unauthorized(
      'ACCESS_TOKEN_TYPE_INVALID',
      'Cloudflare Access token is not an application token',
    )
  }

  const email = typeof payload.email === 'string' && payload.email.trim() !== ''
    ? payload.email.trim().toLowerCase()
    : null
  if (config.emails && (email === null || !config.emails.has(email))) {
    throw unauthorized(
      'ACCESS_IDENTITY_NOT_ALLOWED',
      'This identity is not allowed to use the vault',
    )
  }

  return { email, audience }
}

function buildIdentity(payload, claims, kid, config, nowSeconds) {
  const { email, audience } = claims
  const commonName = typeof payload.common_name === 'string' && payload.common_name !== ''
    ? payload.common_name
    : null
  const subject = typeof payload.sub === 'string' && payload.sub !== '' ? payload.sub : null

  return Object.freeze({
    issuer: config.origin,
    audience,
    subject,
    email,
    commonName,
    // Service tokens carry `common_name` and an empty `sub` instead of email.
    serviceToken: commonName !== null && commonName.endsWith(SERVICE_TOKEN_SUFFIX),
    country: typeof payload.country === 'string' ? payload.country : null,
    identityNonce: typeof payload.identity_nonce === 'string' ? payload.identity_nonce : null,
    issuedAt: typeof payload.iat === 'number' && Number.isFinite(payload.iat) ? payload.iat : null,
    expiresAt: payload.exp,
    expiresInSeconds: payload.exp - nowSeconds,
    keyId: kid,
  })
}

function timingSafeEqual(left, right) {
  // Length is not a secret for an audience tag; content comparison is constant
  // time so a probing client learns nothing from response timing.
  if (left.length !== right.length) return false
  let diff = 0
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i)
  }
  return diff === 0
}
