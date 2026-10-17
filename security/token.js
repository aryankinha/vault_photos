// A random 256-bit owner code, separate from the vault's encryption passphrase.
// Only its SHA-256 digest is configured on the Worker.
export async function verifyOwnerToken(request, env) {
  const expected = env.AUTH_TOKEN_SHA256 || ''
  if (!/^[0-9a-f]{64}$/.test(expected)) return false
  const authorization = request.headers.get('Authorization') || ''
  if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) return false
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(authorization.slice(7)),
  ))
  let difference = 0
  for (let index = 0; index < 32; index += 1) {
    difference |= digest[index] ^ Number.parseInt(expected.slice(index * 2, index * 2 + 2), 16)
  }
  return difference === 0
}
