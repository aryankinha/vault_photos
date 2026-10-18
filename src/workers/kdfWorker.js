import { argon2id } from 'hash-wasm'

self.onmessage = async (event) => {
  const options = event.data
  let output
  try {
    output = await argon2id(options)
    self.postMessage({ output }, [output.buffer])
  } catch {
    self.postMessage({ error: true })
  } finally {
    options.password?.fill(0)
    if (output?.byteLength) output.fill(0)
    self.close()
  }
}
