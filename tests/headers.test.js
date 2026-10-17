import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('hosting denies framing with HTTP headers (meta CSP cannot do this)', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url)))
  const headers = new Map(config.headers.find((rule) => rule.source === '/(.*)').headers.map(
    ({ key, value }) => [key.toLowerCase(), value],
  ))
  assert.equal(headers.get('content-security-policy'), "frame-ancestors 'none'")
  assert.equal(headers.get('x-frame-options'), 'DENY')
  assert.equal(headers.get('x-content-type-options'), 'nosniff')
  assert.equal(headers.get('referrer-policy'), 'no-referrer')
})

test('install icons include padded PNGs at the advertised sizes', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/manifest.json', import.meta.url)))
  for (const size of [192, 512]) {
    const icon = manifest.icons.find((item) => item.sizes === `${size}x${size}`)
    assert.ok(icon)
    const png = await readFile(new URL(`../public${icon.src}`, import.meta.url))
    assert.equal(png.subarray(1, 4).toString(), 'PNG')
    assert.equal(png.readUInt32BE(16), size)
    assert.equal(png.readUInt32BE(20), size)
  }
})
