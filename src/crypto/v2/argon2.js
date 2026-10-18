import { utf8 } from './binary.js'

export const DEFAULT_KDF = Object.freeze({ alg: 'argon2id', m: 65536, t: 3, p: 1 })
const pending = new Set()

export function validateKdfParameters(kdf) {
  if (kdf?.alg !== 'argon2id' ||
      !Number.isInteger(kdf.m) || kdf.m < 32768 || kdf.m > 131072 ||
      !Number.isInteger(kdf.t) || kdf.t < 2 || kdf.t > 6 ||
      !Number.isInteger(kdf.p) || kdf.p < 1 || kdf.p > 4) throw new Error('Invalid KDF parameters')
}

/** Parameters are validated by keyring parsing before entering WASM. */
export async function deriveArgonOutput(passphrase, salt, kdf) {
  validateKdfParameters(kdf)
  if (!(salt instanceof Uint8Array) || salt.length !== 16) throw new Error('Invalid salt')
  if (typeof passphrase !== 'string') throw new Error('Invalid passphrase')
  const password = utf8(passphrase.normalize('NFKC'))
  try {
    if (!password.length || password.length > 4096) throw new Error('Invalid passphrase')
    const options = {
      password, salt, memorySize: kdf.m, iterations: kdf.t,
      parallelism: kdf.p, hashLength: 32, outputType: 'binary',
    }
    if (typeof Worker === 'undefined') {
      const { argon2id } = await import('hash-wasm')
      return await argon2id(options)
    }
    // One-shot worker: keep WASM/password memory off the UI thread and destroy
    // its whole heap when done or locked. SK and VMK never enter this worker.
    return await new Promise((resolve, reject) => {
      const worker = new Worker(new URL('../../workers/kdfWorker.js', import.meta.url), { type: 'module' })
      let settled = false
      const finish = (error, output) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        pending.delete(cancel)
        worker.terminate()
        if (error) reject(error)
        else resolve(output)
      }
      const cancel = () => finish(new DOMException('Key derivation cancelled', 'AbortError'))
      const timeout = setTimeout(() => finish(new Error('Key derivation timed out')), 30_000)
      pending.add(cancel)
      worker.onerror = () => finish(new Error('Key derivation failed'))
      worker.onmessage = (event) => {
        const output = event.data?.output
        if (!(output instanceof Uint8Array) || output.length !== 32) finish(new Error('Key derivation failed'))
        else finish(null, output)
      }
      try { worker.postMessage(options, [password.buffer]) }
      catch (error) { finish(error) }
    })
  } finally { if (password.byteLength) password.fill(0) }
}

export function terminateKeyDerivations() {
  for (const cancel of [...pending]) cancel()
}
