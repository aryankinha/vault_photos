import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyOwnerToken } from '../security/token.js'
import worker from '../worker/index.js'

const token = 'a'.repeat(43)
const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map((b) => b.toString(16).padStart(2, '0')).join('')
const env = { AUTH_MODE: 'token', AUTH_TOKEN_SHA256: digest, HF_TOKEN: 'test', HF_REPO: 'test/vault', ALLOWED_ORIGIN: 'https://vaultphotos.vercel.app' }

test('owner token validates exactly and fails closed for absent/malformed configuration or tokens', async () => {
  for (const [code, expected] of [[token, true], ['b'.repeat(43), false], ['', false], ['short', false], [token + 'a', false]]) {
    assert.equal(await verifyOwnerToken(new Request('https://worker.example', { headers: { Authorization: `Bearer ${code}` } }), env), expected)
  }
  assert.equal(await verifyOwnerToken(new Request('https://worker.example'), {}), false)
})

test('production token mode rejects reads and writes before touching HF', async () => {
  for (const method of ['GET', 'POST']) {
    const response = await worker.fetch(new Request('https://worker.example/vault-head', {
      method, headers: { Origin: env.ALLOWED_ORIGIN },
    }), env, {})
    assert.equal(response.status, 401)
    assert.equal((await response.json()).code, 'AUTH_REQUIRED')
  }
})

test('token preflight allows Authorization and auth-mode reveals no credential', async () => {
  const response = await worker.fetch(new Request('https://worker.example/vault-head', {
    method: 'OPTIONS', headers: { Origin: env.ALLOWED_ORIGIN },
  }), env, {})
  assert.equal(response.status, 204)
  assert.match(response.headers.get('Access-Control-Allow-Headers'), /Authorization/)
  const mode = await worker.fetch(new Request('https://worker.example/auth-mode'), env, {})
  assert.deepEqual(await mode.json(), { mode: 'token' })
})

test('valid owner token reaches routing; forged origins still cannot write', async () => {
  const headers = { Authorization: `Bearer ${token}`, Origin: env.ALLOWED_ORIGIN }
  assert.equal((await worker.fetch(new Request('https://worker.example/not-a-route', { headers }), env, {})).status, 404)
  assert.equal((await worker.fetch(new Request('https://worker.example/not-a-route', {
    method: 'POST', headers: { ...headers, Origin: 'https://hostile.example' },
  }), env, {})).status, 403)
})
