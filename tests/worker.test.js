import test from 'node:test'
import assert from 'node:assert/strict'

const { default: worker } = await import('../worker/index.js')

const env = {
  HF_TOKEN: 'test-token',
  HF_REPO: 'test-user/test-repo',
}

test('commit-batch splits pointer operations and publishes metadata last', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const commits = []

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    if (url.includes('/tree/main/')) {
      return Response.json([{ path: '.gitattributes', type: 'file' }])
    }
    if (url.includes('/resolve/main/.gitattributes')) {
      return new Response('files/** filter=lfs diff=lfs merge=lfs -text\n')
    }
    if (url.includes('/commit/main')) {
      commits.push(String(init.body))
      return Response.json({ commitOid: `commit-${commits.length}` })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }

  const files = Array.from({ length: 81 }, (_, index) => ({
    id: index.toString(16).padStart(16, '0'),
    sha256: index.toString(16).padStart(64, '0'),
    size: 1024 + index,
  }))
  const request = new Request('https://worker.example/commit-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files,
      manifestBytesBase64: 'AQ==',
      bundlePages: [{ pageIndex: 0, bytesBase64: 'Ag==' }],
    }),
  })

  const response = await worker.fetch(request, env)
  assert.equal(response.status, 200)
  assert.equal(commits.length, 3)
  assert.equal(countNdjsonKey(commits[0], 'lfsFile'), 40)
  assert.equal(countNdjsonKey(commits[1], 'lfsFile'), 40)
  assert.equal(countNdjsonKey(commits[2], 'lfsFile'), 1)
  assert.equal(countNdjsonKey(commits[0], 'file'), 0)
  assert.equal(countNdjsonKey(commits[1], 'file'), 0)
  assert.equal(countNdjsonKey(commits[2], 'file'), 2)
})

test('upload-file streams browser-hashed ciphertext to LFS without a git commit', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const ciphertext = crypto.getRandomValues(new Uint8Array(8192))
  const digest = await crypto.subtle.digest('SHA-256', ciphertext)
  const sha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  let uploaded = null
  let verified = null
  let commitCalls = 0

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    if (url.includes('/objects/batch')) {
      return Response.json({
        objects: [{
          oid: sha256,
          size: ciphertext.byteLength,
          actions: {
            upload: { href: 'https://storage.example/upload', header: {} },
            verify: { href: 'https://storage.example/verify', header: {} },
          },
        }],
      })
    }
    if (url === 'https://storage.example/upload') {
      uploaded = new Uint8Array(await new Response(init.body).arrayBuffer())
      return new Response(null, { status: 200 })
    }
    if (url === 'https://storage.example/verify') {
      verified = JSON.parse(String(init.body))
      return new Response(null, { status: 200 })
    }
    if (url.includes('/commit/main')) {
      commitCalls += 1
      return Response.json({ ok: true })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }

  const request = new Request(
    'https://worker.example/upload-file?id=0123456789abcdef&commit=false',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Vault-Size': String(ciphertext.byteLength),
        'X-Vault-SHA256': sha256,
      },
      body: ciphertext,
    },
  )

  const response = await worker.fetch(request, env)
  const receipt = await response.json()
  assert.equal(response.status, 200)
  assert.deepEqual(uploaded, ciphertext)
  assert.deepEqual(verified, { oid: sha256, size: ciphertext.byteLength })
  assert.equal(receipt.sha256, sha256)
  assert.equal(receipt.size, ciphertext.byteLength)
  assert.equal(commitCalls, 0)
})

test('commit-batch retries one transient upstream failure without duplicating metadata', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let attempts = 0
  const bodies = []

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    if (!url.includes('/commit/main')) throw new Error(`Unexpected fetch: ${url}`)
    attempts += 1
    bodies.push(String(init.body))
    if (attempts === 1) return new Response('temporary', { status: 503 })
    return Response.json({ commitOid: 'recovered' })
  }

  const request = new Request('https://worker.example/commit-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [],
      manifestBytesBase64: 'AQ==',
      bundlePages: [],
    }),
  })
  const response = await worker.fetch(request, env)

  assert.equal(response.status, 200)
  assert.equal(attempts, 2)
  assert.equal(bodies[0], bodies[1])
  assert.equal(countNdjsonKey(bodies[1], 'file'), 1)
})

function countNdjsonKey(value, key) {
  return value
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((line) => line.key === key)
    .length
}
