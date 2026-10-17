import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  AccessAuthError,
  CLOCK_SKEW_SECONDS,
  FORCED_REFRESH_MIN_INTERVAL_MS,
  JWKS_MAX_BYTES,
  JWKS_PATH,
  JWKS_STALE_MS,
  JWKS_TTL_MS,
  MAX_TOKEN_LENGTH,
  checkAccessConfig,
  clearAccessJwksCache,
  verifyAccess,
} from '../security/access.js'

const TEAM = 'https://team.cloudflareaccess.com'
const OTHER_TEAM = 'https://other-team.cloudflareaccess.com'
const JWKS_URL = `${TEAM}${JWKS_PATH}`
const AUD = '1af0c2d4e6b8'.repeat(5) + 'abcd' // 64-char audience tag
const OTHER_AUD = '9f'.repeat(32)

const encoder = new TextEncoder()

// ---------------------------------------------------------------------------
// Local RSA material + JWT minting (nothing here talks to Cloudflare)
// ---------------------------------------------------------------------------

async function generateRsaKey(kid, modulusLength = 2048) {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return {
    privateKey: pair.privateKey,
    // Shape mirrors the real certs endpoint: kty/kid/alg/use/n/e.
    jwk: { kty: 'RSA', kid, alg: 'RS256', use: 'sig', n: jwk.n, e: jwk.e },
  }
}

const keyMaterial = new Map()
async function key(kid) {
  if (!keyMaterial.has(kid)) {
    keyMaterial.set(
      kid,
      kid === 'weak-kid'
        ? generateRsaKey(kid, 1024)
        : kid === 'unsigned-kid'
          ? Promise.resolve({ privateKey: null, jwk: null })
          : generateRsaKey(kid),
    )
  }
  return keyMaterial.get(kid)
}

function base64Url(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlJson(value) {
  return base64Url(encoder.encode(JSON.stringify(value)))
}

async function signRs256(kid, payload, headerOverrides = {}) {
  const { privateKey } = await key(kid)
  const header = { alg: 'RS256', kid, typ: 'JWT', ...headerOverrides }
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      privateKey,
      encoder.encode(signingInput),
    ),
  )
  return `${signingInput}.${base64Url(signature)}`
}

/** Classic algorithm-confusion attack: HMAC keyed with the public modulus. */
async function signHs256(kid, payload) {
  const { jwk } = await key(kid)
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    base64UrlBytes(jwk.n),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const header = { alg: 'HS256', kid, typ: 'JWT' }
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(signingInput)),
  )
  return `${signingInput}.${base64Url(signature)}`
}

function base64UrlBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

function appPayload(overrides = {}) {
  const now = nowSeconds()
  return {
    aud: [AUD],
    email: 'alice@example.com',
    exp: now + 3600,
    iat: now,
    nbf: now,
    iss: TEAM,
    type: 'app',
    identity_nonce: '6ei69kawdKzMIAPF',
    sub: '7335d417-61da-459d-899c-0a01c76a2f94',
    country: 'US',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Replaces global fetch for the duration of a test. Any URL that the module
 * fetches other than the ones the test arms is a hard failure, which keeps the
 * module honest about "only ever talks to the team certs endpoint".
 */
function installFetch(t, handler) {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const calls = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    return handler(url, init ?? {})
  }
  return calls
}

/** Serves a certs document shaped like the real endpoint (PEM copies included). */
function jwksResponse(jwks) {
  // Real endpoints also include PEM copies; the module must use `keys` only.
  return Response.json({
    keys: jwks,
    public_cert: { kid: jwks[0]?.kid ?? '', cert: '-----BEGIN CERTIFICATE-----\nSTALE\n-----END CERTIFICATE-----' },
    public_certs: jwks.map((jwk) => ({ kid: jwk.kid, cert: '-----BEGIN CERTIFICATE-----\nPEM\n-----END CERTIFICATE-----' })),
  })
}

function accessRequest(token, extraHeaders = {}) {
  const headers = new Headers(extraHeaders)
  if (token !== undefined && token !== null) {
    headers.set('Cf-Access-Jwt-Assertion', token)
  }
  return new Request('https://vaultphotos-proxy.example/list', { method: 'GET', headers })
}

function baseEnv(overrides = {}) {
  return { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ...overrides }
}

async function expectFailure(promise, code, status) {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof AccessAuthError, `expected AccessAuthError, received ${error}`)
    if (code) assert.equal(error.code, code)
    if (status) assert.equal(error.status, status)
    return error
  }
  return assert.fail('expected verifyAccess() to reject')
}

/** Arms the one endpoint the module is allowed to call: the team certs URL. */
function useCerts(t, jwks) {
  const state = { keys: jwks, fail: false, response: null }
  const calls = installFetch(t, async (url) => {
    if (url !== JWKS_URL) throw new Error(`unexpected fetch: ${url}`)
    if (state.response) return state.response()
    if (state.fail) throw new Error('network down')
    return jwksResponse(state.keys)
  })
  return { state, calls }
}

describe('security/access.js — Cloudflare Access JWT verification', () => {
  test('accepts a valid Access application token and returns a usable identity', async (t) => {
    const { jwk } = await key('kid-primary')
    const { calls } = useCerts(t, [jwk])
    clearAccessJwksCache()

    const payload = appPayload()
    const token = await signRs256('kid-primary', payload)
    const identity = await verifyAccess(accessRequest(token), baseEnv())

    assert.equal(identity.issuer, TEAM)
    assert.equal(identity.audience, AUD)
    assert.equal(identity.email, 'alice@example.com')
    assert.equal(identity.subject, payload.sub)
    assert.equal(identity.country, 'US')
    assert.equal(identity.identityNonce, payload.identity_nonce)
    assert.equal(identity.keyId, 'kid-primary')
    assert.equal(identity.serviceToken, false)
    assert.equal(identity.expiresAt, payload.exp)
    assert.ok(identity.expiresInSeconds > 3500)
    assert.ok(Object.isFrozen(identity))

    // The identity must not smuggle the assertion or any key material.
    for (const [name, value] of Object.entries(identity)) {
      assert.ok(!String(value).includes(token), `${name} must not contain the assertion`)
      assert.ok(!String(value).includes(jwk.n), `${name} must not contain key material`)
    }

    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, `${TEAM}${JWKS_PATH}`)
    assert.equal(calls[0].init.redirect, 'manual')
    assert.ok(calls[0].init.signal, 'JWKS fetch must be abort-bounded')
    t.after(clearAccessJwksCache)
  })

  test('never trusts a cookie or any request-controlled host for the JWKS fetch', async (t) => {
    const { jwk } = await key('kid-primary')
    const { calls } = useCerts(t, [jwk])
    clearAccessJwksCache()

    const token = await signRs256('kid-primary', appPayload())
    const request = new Request('https://worker.example/list', {
      headers: {
        Cookie: `CF_Authorization=${token}`,
        'X-Forwarded-Host': 'evil.example',
        Host: 'evil.example',
      },
    })

    const error = await expectFailure(verifyAccess(request, baseEnv()), 'ACCESS_ASSERTION_MISSING', 401)
    assert.equal(error.status, 401)
    assert.equal(calls.length, 0, 'no key fetch when there is no assertion header')
    t.after(clearAccessJwksCache)
  })

  test('no environment variable can bypass verification', async (t) => {
    const { jwk } = await key('kid-primary')
    useCerts(t, [jwk])
    clearAccessJwksCache()

    for (const [name, value] of [
      ['ACCESS_BYPASS', 'true'],
      ['SKIP_ACCESS', '1'],
      ['DISABLE_ACCESS', 'true'],
      ['ACCESS_DISABLED', 'yes'],
      ['ALLOW_UNAUTHENTICATED', 'true'],
      ['NODE_ENV', 'development'],
    ]) {
      await expectFailure(
        verifyAccess(accessRequest(null), baseEnv({ [name]: value })),
        'ACCESS_ASSERTION_MISSING',
        401,
      )
    }
    t.after(clearAccessJwksCache)
  })

  test('verifies nothing and logs nothing: no console output on success or failure', async (t) => {
    const { jwk } = await key('kid-primary')
    useCerts(t, [jwk])
    clearAccessJwksCache()

    const methods = ['log', 'info', 'warn', 'error', 'debug']
    const original = {}
    const seen = []
    for (const method of methods) {
      original[method] = console[method]
      console[method] = (...args) => { seen.push([method, ...args]) }
    }
    t.after(() => {
      for (const method of methods) console[method] = original[method]
      clearAccessJwksCache()
    })

    await verifyAccess(accessRequest(await signRs256('kid-primary', appPayload())), baseEnv())
    await expectFailure(verifyAccess(accessRequest('a.b.c'), baseEnv()), undefined, 401)
    await expectFailure(verifyAccess(accessRequest(null), {}), 'ACCESS_NOT_CONFIGURED', 503)

    assert.deepEqual(seen, [], 'the module must never log')
  })

  describe('signature verification', () => {
    test('rejects a token signed by a different key that claims an allowed kid', async (t) => {
      const { jwk } = await key('kid-primary')
      useCerts(t, [jwk])
      clearAccessJwksCache()

      // Signed with an attacker key pair, but the header names the trusted kid.
      const forged = await signRs256('kid-attacker', appPayload(), { kid: 'kid-primary' })
      await expectFailure(
        verifyAccess(accessRequest(forged), baseEnv()),
        'ACCESS_SIGNATURE_INVALID',
        401,
      )

      // And a genuinely unknown kid is reported as such, not as a bad signature.
      const unknown = await signRs256('kid-rotated', appPayload())
      await expectFailure(
        verifyAccess(accessRequest(unknown), baseEnv()),
        'ACCESS_KEY_UNKNOWN',
        401,
      )
      t.after(clearAccessJwksCache)
    })

    test('rejects algorithm confusion (HS256 keyed with the public modulus)', async (t) => {
      const { jwk } = await key('kid-primary')
      useCerts(t, [jwk])
      clearAccessJwksCache()

      const forged = await signHs256('kid-primary', appPayload())
      await expectFailure(
        verifyAccess(accessRequest(forged), baseEnv()),
        'ACCESS_ALG_UNSUPPORTED',
        401,
      )
      t.after(clearAccessJwksCache)
    })

    test('rejects alg none, RS512 and any non-RS256 algorithm', async (t) => {
      const { jwk } = await key('kid-primary')
      useCerts(t, [jwk])
      clearAccessJwksCache()

      for (const alg of ['none', 'RS512', 'PS256', 'ES256', 'rs256']) {
        const token = await signRs256('kid-primary', appPayload(), { alg })
        await expectFailure(
          verifyAccess(accessRequest(token), baseEnv()),
          'ACCESS_ALG_UNSUPPORTED',
          401,
        )
      }
      t.after(clearAccessJwksCache)
    })

    test('rejects headers carrying embedded or remote key material and crit', async (t) => {
      const { jwk } = await key('kid-primary')
      useCerts(t, [jwk])
      clearAccessJwksCache()

      for (const overrides of [
        { jku: 'https://evil.example/jwks' },
        { x5u: 'https://evil.example/cert.pem' },
        { jwk: { kty: 'RSA', n: 'x', e: 'AQAB' } },
        { x5c: ['MIIC'] },
        { crit: ['kid'], kid: 'kid-primary' },
      ]) {
        const token = await signRs256('kid-primary', appPayload(), overrides)
        await expectFailure(
          verifyAccess(accessRequest(token), baseEnv()),
          'ACCESS_TOKEN_MALFORMED',
          401,
        )
      }
      t.after(clearAccessJwksCache)
    })

    test('detects payload tampering after the fact', async (t) => {
      const { jwk } = await key('kid-primary')
      useCerts(t, [jwk])
      clearAccessJwksCache()

      const token = await signRs256('kid-primary', appPayload())
      const [h, , s] = token.split('.')
      const forgedPayload = base64UrlJson(appPayload({ email: 'attacker@evil.example' }))
      await expectFailure(
        verifyAccess(accessRequest(`${h}.${forgedPayload}.${s}`), baseEnv()),
        'ACCESS_SIGNATURE_INVALID',
        401,
      )
      t.after(clearAccessJwksCache)
    })

    test('rejects a missing or malformed kid', async (t) => {
      const { jwk } = await key('kid-primary')
      useCerts(t, [jwk])
      clearAccessJwksCache()

      const noKid = base64UrlJson({ alg: 'RS256', typ: 'JWT' })
      await expectFailure(
        verifyAccess(accessRequest(`${noKid}.${base64UrlJson(appPayload())}.sig`), baseEnv()),
        'ACCESS_KEY_UNKNOWN',
        401,
      )

      const injectedKid = await signRs256('kid-primary', appPayload(), { kid: 'kid with spaces' })
      await expectFailure(
        verifyAccess(accessRequest(injectedKid), baseEnv()),
        'ACCESS_KEY_UNKNOWN',
        401,
      )
      t.after(clearAccessJwksCache)
    })
  })

  describe('claim validation', () => {
    test('requires the configured audience, as array or bare string', async (t) => {
      const { jwk } = await key('kid-primary')
      useCerts(t, [jwk])
      clearAccessJwksCache()

      const wrong = await signRs256('kid-primary', appPayload({ aud: [OTHER_AUD] }))
      await expectFailure(verifyAccess(accessRequest(wrong), baseEnv()), 'ACCESS_AUDIENCE_INVALID', 401)

      const multi = await signRs256('kid-primary', appPayload({ aud: [OTHER_AUD, AUD] }))
      assert.equal((await verifyAccess(accessRequest(multi), baseEnv())).audience, AUD)

      const asString = await signRs256('kid-primary', appPayload({ aud: AUD }))
      assert.equal((await verifyAccess(accessRequest(asString), baseEnv())).audience, AUD)

      const bare = await signRs256('kid-primary', appPayload({ aud: OTHER_AUD }))
      await expectFailure(verifyAccess(accessRequest(bare), baseEnv()), 'ACCESS_AUDIENCE_INVALID', 401)

      for (const aud of [[], null, {}, 123, '']) {
        const token = await signRs256('kid-primary', appPayload({ aud }))
        await expectFailure(
          verifyAccess(accessRequest(token), baseEnv()),
          'ACCESS_AUDIENCE_INVALID',
          401,
        )
      }
      t.after(clearAccessJwksCache)
    })

    test('requires iss to equal the team origin exactly', async (t) => {
      const { jwk } = await key('kid-primary')
      useCerts(t, [jwk])
      clearAccessJwksCache()

      for (const iss of [
        `${TEAM}/`,
        'https://team.cloudflareaccess.com.evil.example',
        OTHER_TEAM,
        'http://team.cloudflareaccess.com',
        'HTTPS://TEAM.cloudflareaccess.com',
        42,
        null,
        undefined,
      ]) {
        const token = await signRs256('kid-primary', appPayload({ iss }))
        await expectFailure(
          verifyAccess(accessRequest(token), baseEnv()),
          'ACCESS_ISSUER_INVALID',
          401,
        )
      }
      t.after(clearAccessJwksCache)
    })

    test('enforces exp with a bounded clock skew', async (t) => {
      const { jwk } = await key('kid-primary')
      useCerts(t, [jwk])
      clearAccessJwksCache()

      const now = nowSeconds()
      const stale = await signRs256('kid-primary', appPayload({ exp: now - CLOCK_SKEW_SECONDS - 5 }))
      await expectFailure(verifyAccess(accessRequest(stale), baseEnv()), 'ACCESS_TOKEN_EXPIRED', 401)

      const withinSkew = await signRs256('kid-primary', appPayload({ exp: now - CLOCK_SKEW_SECONDS + 10 }))
      assert.equal((await verifyAccess(accessRequest(withinSkew), baseEnv())).email, 'alice@example.com')

      for (const exp of ['soon', null, undefined, Number.NaN, {}]) {
        const token = await signRs256('kid-primary', appPayload({ exp }))
        await expectFailure(verifyAccess(accessRequest(token), baseEnv()), 'ACCESS_TOKEN_EXPIRED', 401)
      }
      t.after(clearAccessJwksCache)
    })

    test('enforces nbf and iat with the same bounded skew', async (t) => {
      const { jwk } = await key('kid-primary')
      useCerts(t, [jwk])
      clearAccessJwksCache()

      const now = nowSeconds()
      const notYet = await signRs256('kid-primary', appPayload({ nbf: now + CLOCK_SKEW_SECONDS + 30 }))
      await expectFailure(
        verifyAccess(accessRequest(notYet), baseEnv()),
        'ACCESS_TOKEN_NOT_YET_VALID',
        401,
      )

      const earlyIssued = await signRs256('kid-primary', appPayload({ iat: now + CLOCK_SKEW_SECONDS + 30 }))
      await expectFailure(
        verifyAccess(accessRequest(earlyIssued), baseEnv()),
        'ACCESS_TOKEN_NOT_YET_VALID',
        401,
      )

      const skewed = await signRs256('kid-primary', appPayload({
        nbf: now + CLOCK_SKEW_SECONDS - 5,
        iat: now + CLOCK_SKEW_SECONDS - 5,
      }))
      assert.ok(await verifyAccess(accessRequest(skewed), baseEnv()))

      const badNbf = await signRs256('kid-primary', appPayload({ nbf: 'later' }))
      await expectFailure(
        verifyAccess(accessRequest(badNbf), baseEnv()),
        'ACCESS_TOKEN_NOT_YET_VALID',
        401,
      )
      t.after(clearAccessJwksCache)
    })

    test('rejects org (session) tokens masquerading as application tokens', async (t) => {
      const { jwk } = await key('kid-primary')
      useCerts(t, [jwk])
      clearAccessJwksCache()

      const org = await signRs256('kid-primary', appPayload({ type: 'org' }))
      await expectFailure(
        verifyAccess(accessRequest(org), baseEnv()),
        'ACCESS_TOKEN_TYPE_INVALID',
        401,
      )
      t.after(clearAccessJwksCache)
    })
  })

  describe('identity allow-list', () => {
    test('accepts only allow-listed emails when ACCESS_EMAILS is set', async (t) => {
      const { jwk } = await key('kid-primary')
      useCerts(t, [jwk])
      clearAccessJwksCache()

      const env = baseEnv({ ACCESS_EMAILS: `bob@example.com, Alice@Example.com ,,carol@example.com` })

      const allowed = await signRs256('kid-primary', appPayload({ email: ' ALICE@EXAMPLE.COM ' }))
      assert.equal((await verifyAccess(accessRequest(allowed), env)).email, 'alice@example.com')

      const denied = await signRs256('kid-primary', appPayload({ email: 'mallory@evil.example' }))
      await expectFailure(
        verifyAccess(accessRequest(denied), env),
        'ACCESS_IDENTITY_NOT_ALLOWED',
        401,
      )
      t.after(clearAccessJwksCache)
    })

    test('a service token cannot satisfy an email allow-list', async (t) => {
      const { jwk } = await key('kid-primary')
      useCerts(t, [jwk])
      clearAccessJwksCache()

      const servicePayload = {
        type: 'app',
        aud: [AUD],
        exp: nowSeconds() + 3600,
        iat: nowSeconds(),
        iss: TEAM,
        common_name: 'e367826f93b8d71185e03fe518aff3b4.access',
        sub: '',
      }
      const token = await signRs256('kid-primary', servicePayload)

      // No allow-list: the Access policy decides, and the caller can react to
      // identity.serviceToken.
      const identity = await verifyAccess(accessRequest(token), baseEnv())
      assert.equal(identity.serviceToken, true)
      assert.equal(identity.email, null)
      assert.equal(identity.subject, null)
      assert.equal(identity.commonName, 'e367826f93b8d71185e03fe518aff3b4.access')

      await expectFailure(
        verifyAccess(accessRequest(token), baseEnv({ ACCESS_EMAILS: 'alice@example.com' })),
        'ACCESS_IDENTITY_NOT_ALLOWED',
        401,
      )
      t.after(clearAccessJwksCache)
    })
  })

  describe('token hygiene', () => {
    test('rejects a missing assertion header', async (t) => {
      const { jwk } = await key('kid-primary')
      const { calls } = useCerts(t, [jwk])
      clearAccessJwksCache()

      await expectFailure(
        verifyAccess(accessRequest(null), baseEnv()),
        'ACCESS_ASSERTION_MISSING',
        401,
      )
      await expectFailure(
        verifyAccess(accessRequest('   '), baseEnv()),
        'ACCESS_ASSERTION_MISSING',
        401,
      )
      assert.equal(calls.length, 0)
      t.after(clearAccessJwksCache)
    })

    test('rejects malformed tokens without leaking details', async (t) => {
      const { jwk } = await key('kid-primary')
      useCerts(t, [jwk])
      clearAccessJwksCache()

      const valid = await signRs256('kid-primary', appPayload())
      const malformed = [
        'abc',
        'a.b',
        'a.b.c.d',
        '!!!.' + valid.split('.')[1] + '.' + valid.split('.')[2],
        `${valid}.extra`,
        base64UrlJson({ alg: 'RS256', kid: 'kid-primary' }) + '..',
        base64Url(encoder.encode('not json')) + '.' + base64UrlJson(appPayload()) + '.sig',
        'eyJhbGciOiJSUzI1NiJ9.###.AAAA',
        `${'a'.repeat(MAX_TOKEN_LENGTH + 1)}.b.c`,
      ]

      for (const token of malformed) {
        const error = await expectFailure(
          verifyAccess(accessRequest(token), baseEnv()),
          undefined,
          401,
        )
        assert.ok(
          !error.message.includes(token) || token.length < 8,
          'error messages must not echo the assertion',
        )
      }
      t.after(clearAccessJwksCache)
    })

    test('rejects a duplicated assertion header', async (t) => {
      const { jwk } = await key('kid-primary')
      useCerts(t, [jwk])
      clearAccessJwksCache()

      const token = await signRs256('kid-primary', appPayload())
      const headers = new Headers()
      headers.append('Cf-Access-Jwt-Assertion', token)
      headers.append('Cf-Access-Jwt-Assertion', token)
      await expectFailure(
        verifyAccess(new Request('https://worker.example/list', { headers }), baseEnv()),
        'ACCESS_TOKEN_MALFORMED',
        401,
      )
      t.after(clearAccessJwksCache)
    })
  })

  describe('configuration fails closed', () => {
    test('missing or unusable configuration is a 503, never a pass-through', async (t) => {
      const { calls } = useCerts(t, [(await key('kid-primary')).jwk])
      clearAccessJwksCache()

      const token = await signRs256('kid-primary', appPayload())
      const cases = [
        [{}, 'ACCESS_NOT_CONFIGURED'],
        [{ ACCESS_AUD: AUD }, 'ACCESS_TEAM_DOMAIN_MISSING'],
        [{ ACCESS_TEAM_DOMAIN: TEAM }, 'ACCESS_AUD_MISSING'],
        [{ ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' }, 'ACCESS_NOT_CONFIGURED'],
        [{ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: 'short' }, 'ACCESS_AUD_INVALID'],
        [{ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ACCESS_EMAILS: 42 }, 'ACCESS_EMAILS_INVALID'],
        [
          {
            ACCESS_TEAM_DOMAIN: TEAM,
            ACCESS_AUD: AUD,
            ACCESS_EMAILS: Array.from({ length: 600 }, (_, i) => `user${i}@example.com`).join(','),
          },
          'ACCESS_EMAILS_INVALID',
        ],
      ]

      for (const [env, code] of cases) {
        await expectFailure(verifyAccess(accessRequest(token), env), code, 503)
        assert.throws(() => checkAccessConfig(env), (error) => error instanceof AccessAuthError && error.status === 503)
      }
      assert.equal(calls.length, 0, 'a misconfigured Worker must not fetch keys')
      t.after(clearAccessJwksCache)
    })

    test('a malicious team URL is rejected before any request is made', async (t) => {
      const { calls } = useCerts(t, [(await key('kid-primary')).jwk])
      clearAccessJwksCache()

      const token = await signRs256('kid-primary', appPayload())
      const hostileDomains = [
        'https://team.cloudflareaccess.com.evil.example',
        'https://evil.example/team.cloudflareaccess.com',
        'https://team.cloudflareaccess.com@evil.example',
        'http://team.cloudflareaccess.com',
        '//team.cloudflareaccess.com',
        'https://team.cloudflareaccess.com:8443',
        'https://team.cloudflareaccess.com/cdn-cgi/access/certs',
        'https://team.cloudflareaccess.com/../evil',
        'https://team.cloudflareaccess.com?x=1',
        'https://team.cloudflareaccess.com#x',
        'https://team.cloudflareaccess.com.',
        'https://cloudflareaccess.com',
        'https://TEAM.cloudflareaccess.com.evil.example',
        'https://127.0.0.1',
        'https://[::1]',
        'ftp://team.cloudflareaccess.com',
        'team.cloudflareaccess.com',
        'https://team.cloudflareaccess.com\\@evil.example',
        'https://xn--80ak6aa92e.cloudflareaccess.com.evil.example',
      ]

      for (const ACCESS_TEAM_DOMAIN of hostileDomains) {
        const error = await expectFailure(
          verifyAccess(accessRequest(token), baseEnv({ ACCESS_TEAM_DOMAIN })),
          undefined,
          503,
        )
        assert.match(error.code, /ACCESS_(TEAM_DOMAIN|NOT_CONFIGURED)/)
      }
      assert.equal(calls.length, 0, 'no key fetch may happen for a non-Access host')

      // Surrounding whitespace from a wrangler var is trimmed, not interpreted:
      // the value still normalises to the exact same allow-listed origin.
      assert.equal(
        checkAccessConfig({ ACCESS_TEAM_DOMAIN: `${TEAM}\n`, ACCESS_AUD: AUD }).teamDomain,
        TEAM,
      )
      assert.equal(
        checkAccessConfig({ ACCESS_TEAM_DOMAIN: ` ${TEAM}/ `, ACCESS_AUD: AUD }).teamDomain,
        TEAM,
      )
      t.after(clearAccessJwksCache)
    })

    test('a hostile JWKS response fails closed', async (t) => {
      const { jwk } = await key('kid-primary')
      const { state } = useCerts(t, [jwk])
      clearAccessJwksCache()
      const token = await signRs256('kid-primary', appPayload())

      const hostileBodies = {
        bad_json: () => new Response('<html>nope</html>'),
        root_array: () => new Response('[]'),
        no_keys_field: () => Response.json({ public_certs: [] }),
        keys_not_array: () => Response.json({ keys: { kid: 'x' } }),
        keys_empty: () => Response.json({ keys: [] }),
        too_many_keys: () => Response.json({ keys: Array.from({ length: 9 }, () => jwk) }),
        bad_kty: () => Response.json({ keys: [{ ...jwk, kty: 'oct' }] }),
        bad_alg: () => Response.json({ keys: [{ ...jwk, alg: 'RS512' }] }),
        enc_use: () => Response.json({ keys: [{ ...jwk, use: 'enc' }] }),
        no_kid: () => Response.json({ keys: [{ kty: 'RSA', alg: 'RS256', use: 'sig', n: jwk.n, e: jwk.e }] }),
        weak_exponent: () => Response.json({ keys: [{ ...jwk, e: base64Url(new Uint8Array([3])) }] }),
        missing_modulus: () => Response.json({ keys: [{ ...jwk, n: undefined }] }),
        private_material: () => Response.json({ keys: [{ ...jwk, d: 'AAAA' }] }),
        invalid_utf8: () => new Response(new Uint8Array([0xff, 0xfe, 0xfd])),
        oversize_stream: () => new Response('x'.repeat(JWKS_MAX_BYTES + 1024)),
        oversize_declared: () => new Response('{}', { headers: { 'content-length': String(JWKS_MAX_BYTES + 1) } }),
        status_404: () => new Response('missing', { status: 404 }),
        status_500: () => new Response('boom', { status: 500 }),
        status_204: () => new Response(null, { status: 204 }),
        redirect: () => new Response(null, { status: 302, headers: { location: 'https://evil.example/jwks' } }),
      }

      for (const [reason, responder] of Object.entries(hostileBodies)) {
        state.response = responder
        clearAccessJwksCache()
        const error = await expectFailure(
          verifyAccess(accessRequest(token), baseEnv()),
          undefined,
          503,
        )
        assert.ok(
          error.code.startsWith('ACCESS_KEYS_'),
          `${reason}: expected an ACCESS_KEYS_* code, got ${error.code}`,
        )
      }

      // A weak (1024-bit) key set is refused outright.
      state.response = null
      state.keys = [(await key('weak-kid')).jwk]
      clearAccessJwksCache()
      const weak = await expectFailure(
        verifyAccess(accessRequest(token), baseEnv()),
        'ACCESS_KEYS_INVALID',
        503,
      )
      assert.equal(weak.reason, 'weak_modulus')
      t.after(clearAccessJwksCache)
    })

    test('the JWKS request is pinned, redirect-refusing and time bounded', async (t) => {
      const calls = installFetch(t, async (url, init) => {
        assert.equal(url, JWKS_URL)
        assert.equal(init.redirect, 'manual')
        assert.ok(init.signal, 'fetch must carry an abort signal')
        // Never resolves; only an abort can end this.
        return new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      })
      clearAccessJwksCache()

      const started = Date.now()
      const error = await expectFailure(
        verifyAccess(accessRequest(await signRs256('kid-primary', appPayload())), baseEnv()),
        'ACCESS_KEYS_UNAVAILABLE',
        503,
      )
      const elapsed = Date.now() - started
      assert.ok(elapsed >= 1000 && elapsed < 5000, `expected a bounded abort, took ${elapsed}ms`)
      assert.equal(error.reason, 'fetch_failed')
      assert.equal(calls.length, 1)
      t.after(clearAccessJwksCache)
    })
  })

  describe('JWKS caching and key rotation', () => {
    test('caches keys per team origin and fetches once per TTL window', async (t) => {
      const primary = (await key('kid-primary')).jwk
      const { calls } = useCerts(t, [primary])
      clearAccessJwksCache()

      const token = await signRs256('kid-primary', appPayload())
      await verifyAccess(accessRequest(token), baseEnv())
      await verifyAccess(accessRequest(token), baseEnv())
      await verifyAccess(accessRequest(token), baseEnv())
      assert.equal(calls.length, 1, 'cached keys must be reused')

      // A different team must never reuse another team's cached keys.
      const otherCalls = []
      const original = globalThis.fetch
      globalThis.fetch = async (input) => {
        const url = String(input)
        otherCalls.push(url)
        assert.equal(url, `${OTHER_TEAM}${JWKS_PATH}`)
        return jwksResponse([primary])
      }
      const otherToken = await signRs256('kid-primary', appPayload({ iss: OTHER_TEAM }))
      assert.ok(await verifyAccess(accessRequest(otherToken), baseEnv({ ACCESS_TEAM_DOMAIN: OTHER_TEAM })))
      assert.deepEqual(otherCalls, [`${OTHER_TEAM}${JWKS_PATH}`])
      globalThis.fetch = original
      t.after(clearAccessJwksCache)
    })

    test('de-duplicates concurrent refreshes', async (t) => {
      const { calls } = useCerts(t, [(await key('kid-primary')).jwk])
      clearAccessJwksCache()

      const token = await signRs256('kid-primary', appPayload())
      const results = await Promise.all(
        Array.from({ length: 5 }, () => verifyAccess(accessRequest(token), baseEnv())),
      )
      assert.equal(results.length, 5)
      assert.equal(calls.length, 1, 'concurrent requests share one JWKS fetch')
      t.after(clearAccessJwksCache)
    })

    test('an unknown kid triggers exactly one rotation refresh and then verifies', async (t) => {
      const primary = (await key('kid-primary')).jwk
      const rotated = (await key('kid-rotated')).jwk
      const { state, calls } = useCerts(t, [primary])
      clearAccessJwksCache()

      await verifyAccess(accessRequest(await signRs256('kid-primary', appPayload())), baseEnv())
      assert.equal(calls.length, 1)

      // Cloudflare rotated: the new kid is served only after a refresh.
      state.keys = [primary, rotated]
      const identity = await verifyAccess(
        accessRequest(await signRs256('kid-rotated', appPayload())),
        baseEnv(),
      )
      assert.equal(identity.keyId, 'kid-rotated')
      assert.equal(calls.length, 2, 'exactly one forced refresh')

      // Rate limited: more unknown kids do not turn into a fetch amplifier.
      state.keys = [primary, rotated, { ...rotated, kid: 'kid-next' }]
      await expectFailure(
        verifyAccess(accessRequest(await signRs256('kid-next', appPayload())), baseEnv()),
        'ACCESS_KEY_UNKNOWN',
        401,
      )
      assert.equal(calls.length, 2, 'forced refreshes are rate limited')

      // Still usable for the kids we do hold.
      assert.ok(await verifyAccess(accessRequest(await signRs256('kid-primary', appPayload())), baseEnv()))
      t.after(clearAccessJwksCache)
    })

    test('keeps serving cached keys while a refresh fails, then fails closed', async (t) => {
      const primary = (await key('kid-primary')).jwk
      const { state } = useCerts(t, [primary])
      t.after(clearAccessJwksCache)

      const realNow = Date.now()
      t.mock.timers.enable({ apis: ['Date'], now: realNow })
      clearAccessJwksCache()

      // Long-lived token: this test advances the clock by more than a day.
      const token = await signRs256('kid-primary', appPayload({ exp: nowSeconds() + 7 * 86400 }))
      assert.ok(await verifyAccess(accessRequest(token), baseEnv()))

      // Endpoint breaks after the key was cached: requests still authenticate.
      state.fail = true
      t.mock.timers.tick(JWKS_TTL_MS + 60_000)
      assert.ok(
        await verifyAccess(accessRequest(token), baseEnv()),
        'cached keys should survive a failed refresh',
      )

      // Once the stale window closes the module fails closed (503), never 200.
      t.mock.timers.tick(JWKS_STALE_MS)
      await expectFailure(
        verifyAccess(accessRequest(token), baseEnv()),
        'ACCESS_KEYS_UNAVAILABLE',
        503,
      )
    })

    test('clearAccessJwksCache forces the next verification to refetch', async (t) => {
      const { calls } = useCerts(t, [(await key('kid-primary')).jwk])
      clearAccessJwksCache()

      const token = await signRs256('kid-primary', appPayload())
      await verifyAccess(accessRequest(token), baseEnv())
      assert.equal(calls.length, 1)
      clearAccessJwksCache()
      await verifyAccess(accessRequest(token), baseEnv())
      assert.equal(calls.length, 2)
      t.after(clearAccessJwksCache)
    })

    test('the forced-refresh interval is a bounded constant', () => {
      assert.ok(FORCED_REFRESH_MIN_INTERVAL_MS > 0 && FORCED_REFRESH_MIN_INTERVAL_MS <= 60_000)
      assert.ok(CLOCK_SKEW_SECONDS > 0 && CLOCK_SKEW_SECONDS <= 30)
    })
  })
})
