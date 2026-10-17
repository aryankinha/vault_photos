// Local-only test fixture generator. These bytes contain no user media/key.
import { mkdir, writeFile, unlink, rmdir } from 'node:fs/promises'
import { webcrypto } from 'node:crypto'

const directory = new URL('../../public/__test_stream__/get-chunk/0123456789abcdef/', import.meta.url)
const parents = [new URL('../../public/__test_stream__/get-chunk/', import.meta.url), new URL('../../public/__test_stream__/', import.meta.url)]
if (globalThis.process?.argv?.includes('--clean')) {
  for (const index of [0, 1]) await unlink(new URL(String(index), directory)).catch((error) => {
    if (error.code !== 'ENOENT') throw error
  })
  for (const path of [directory, ...parents]) await rmdir(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error
  })
} else {
  const key = await webcrypto.subtle.importKey('raw', new Uint8Array(32).fill(42), 'AES-GCM', false, ['encrypt'])
  await mkdir(directory, { recursive: true })
  for (const index of [0, 1]) {
    const aad = new Uint8Array(4)
    new DataView(aad.buffer).setUint32(0, index)
    const nonce = webcrypto.getRandomValues(new Uint8Array(12))
    const plain = index === 0 ? Uint8Array.from({ length: 8 }, (_, value) => value) : Uint8Array.of(8)
    const encrypted = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, plain)
    // The final one-byte tail intentionally uses the legacy no-index-prefix format.
    const prefix = index === 0 ? 4 : 0
    const packed = new Uint8Array(prefix + 12 + encrypted.byteLength)
    if (prefix) packed.set(aad)
    packed.set(nonce, prefix)
    packed.set(new Uint8Array(encrypted), prefix + 12)
    await writeFile(new URL(String(index), directory), packed, { flag: 'wx' })
  }
}
