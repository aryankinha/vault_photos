import { cryptoPool } from '../../src/workers/cryptoWorkerPool.js'

const resultElement = document.querySelector('#result')

run().catch((error) => {
  resultElement.dataset.status = 'failed'
  resultElement.textContent = JSON.stringify({
    passed: false,
    error: error instanceof Error ? error.message : 'Unknown test failure',
  }, null, 2)
  cryptoPool.terminate()
})

async function run() {
  const source = new Uint8Array(50 * 1024 * 1024)
  for (let index = 0; index < source.length; index += 1) {
    source[index] = index % 251
  }

  const expectedDigest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', source),
  )
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )

  let animationFrames = 0
  let timerTicks = 0
  let measuring = true
  const countFrame = () => {
    if (!measuring) return
    animationFrames += 1
    requestAnimationFrame(countFrame)
  }
  requestAnimationFrame(countFrame)
  const timer = setInterval(() => { timerTicks += 1 }, 16)

  const startedAt = performance.now()
  const encrypted = await cryptoPool.encrypt(source.buffer, key)
  const sourceWasTransferred = source.byteLength === 0
  const encryptedBytes = encrypted.byteLength
  const plaintext = await cryptoPool.decrypt(encrypted, key)
  const encryptedWasTransferred = encrypted.byteLength === 0
  const elapsedMs = Math.round(performance.now() - startedAt)

  measuring = false
  clearInterval(timer)
  const actualDigest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', plaintext),
  )
  const identical = expectedDigest.every((byte, index) => byte === actualDigest[index])
  const passed = (
    identical &&
    sourceWasTransferred &&
    encryptedWasTransferred &&
    plaintext.byteLength === 50 * 1024 * 1024 &&
    timerTicks > 0
  )

  const result = {
    passed,
    identical,
    sourceWasTransferred,
    encryptedWasTransferred,
    plaintextBytes: plaintext.byteLength,
    encryptedBytes,
    elapsedMs,
    animationFrames,
    timerTicks,
  }
  resultElement.dataset.status = passed ? 'passed' : 'failed'
  resultElement.textContent = JSON.stringify(result, null, 2)
  cryptoPool.terminate()
}
