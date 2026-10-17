/**
 * New-vault passphrase policy + entropy guidance (audit finding S2).
 *
 * Scope: applies ONLY when creating a new vault. Existing vaults keep unlocking
 * with whatever passphrase they were created with — the unlock path never runs
 * this policy, so no existing user is locked out by the stronger bar.
 *
 * Policy (local, no dependencies, no network):
 *   - minimum 12 characters for new passphrases,
 *   - a small embedded common-password blocklist with leetspeak/trailing-digit
 *     normalization (catches "P@ssw0rd1234" as "password"),
 *   - rejection of trivially guessable patterns (single repeated char,
 *     4+ character ascending/descending runs, keyboard rows),
 *   - a heuristic entropy estimate surfaced in the UI as guidance
 *     ("weak / fair / strong" + a concrete suggestion).
 */

export const MIN_NEW_PASSPHRASE_LENGTH = 12

/**
 * Local common-password blocklist. Deliberately small and offline — it blocks
 * the passwords an offline attacker is guaranteed to try first (the whole
 * corpus is publicly readable per finding S1), not a full dictionary.
 */
const COMMON_PASSPHRASES = new Set([
  'password', 'password1', 'password12', 'password123', 'passwordpassword',
  '123456', '1234567', '12345678', '123456789', '1234567890', '123456789012',
  'qwerty', 'qwerty123', 'qwertyuiop', 'qwertyuiopasdf',
  'asdfghjkl', 'zxcvbnm', '1q2w3e4r', '1q2w3e4r5t', 'zaq12wsx',
  'letmein', 'letmein123', 'letmein1234',
  'admin', 'admin123', 'admin1234', 'administrator',
  'welcome', 'welcome1', 'welcome123', 'welcome1234',
  'monkey', 'dragon', 'football', 'baseball', 'soccer', 'hockey',
  'iloveyou', 'iloveyou1', 'iloveyouiloveyou', 'princess', 'sunshine',
  'master', 'passw0rd', 'passwort', 'senha123', 'changeme', 'secret',
  'trustno1', 'trustno1trustno1', 'superman', 'batman', 'starwars',
  'whatever', 'freedom', 'hello', 'login', 'abc123', 'abcdef', 'abcdefgh',
  'aaaaaa', 'aaaaaaaa', '000000', '111111', '11111111', '00000000',
  'default', 'test1234', 'test12345', 'guest', 'root', 'toor',
])

const LEET_MAP = {
  '4': 'a', '@': 'a', '8': 'b', '(': 'c', '3': 'e', '1': 'i', '!': 'i',
  '0': 'o', '5': 's', $: 's', '7': 't', '+': 't', '2': 'z',
}

/**
 * Normalize a passphrase for blocklist comparison: strip trailing digit/symbol
 * padding first ("password1234" → "password", "p@ssw0rd1234" → "password"),
 * then un-leet interior substitutions and drop remaining separators.
 */
export function normalizeForBlocklist(passphrase) {
  let text = String(passphrase ?? '').toLowerCase().trim()
  text = text.replace(/[^a-z]+$/, '')
  let out = ''
  for (const char of text) out += LEET_MAP[char] ?? char
  out = out.replace(/[^a-z]/g, '')
  return out.replace(/[^a-z]*$/, '')
}

export function isCommonPassphrase(passphrase) {
  const normalized = normalizeForBlocklist(passphrase)
  if (!normalized) return false
  if (COMMON_PASSPHRASES.has(normalized)) return true
  return COMMON_PASSPHRASES.has(String(passphrase ?? '').toLowerCase().trim())
}

function hasLongRun(value) {
  // 4+ consecutive ascending or descending chars ("abcd", "9876").
  for (let index = 0; index + 3 < value.length; index += 1) {
    let asc = true
    let desc = true
    for (let offset = 1; offset < 4; offset += 1) {
      const prev = value.charCodeAt(index + offset - 1)
      const next = value.charCodeAt(index + offset)
      if (next !== prev + 1) asc = false
      if (next !== prev - 1) desc = false
    }
    if (asc || desc) return true
  }
  return false
}

const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890']

function hasKeyboardRow(value) {
  for (const row of KEYBOARD_ROWS) {
    const reversed = [...row].reverse().join('')
    for (let index = 0; index + 6 <= row.length; index += 1) {
      if (value.includes(row.slice(index, index + 6))) return true
      if (value.includes(reversed.slice(index, index + 6))) return true
    }
  }
  return false
}

/**
 * Validate a passphrase for NEW vault creation.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateNewPassphrase(passphrase, { minLength = MIN_NEW_PASSPHRASE_LENGTH } = {}) {
  const value = typeof passphrase === 'string' ? passphrase : ''
  const errors = []

  if (value.length < minLength) {
    errors.push(`Passphrase must be at least ${minLength} characters (a short passphrase is the weakest link in the whole vault).`)
  }
  if (isCommonPassphrase(value)) {
    errors.push('This passphrase appears in common-password lists — an attacker will try it first.')
  }
  const stripped = value.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (stripped.length > 0 && new Set(stripped).size <= 3) {
    errors.push('Passphrase repeats almost the same character — add variety.')
  }
  if (hasLongRun(stripped)) {
    errors.push('Passphrase contains a sequence like "abcd" or "9876" — avoid runs.')
  }

  return { ok: errors.length === 0, errors }
}

function charsetPool(value) {
  let pool = 0
  if (/[a-z]/.test(value)) pool += 26
  if (/[A-Z]/.test(value)) pool += 26
  if (/[0-9]/.test(value)) pool += 10
  if (/[^a-zA-Z0-9]/.test(value)) pool += 33
  return Math.max(pool, 2)
}

/**
 * Heuristic entropy estimate for UI guidance only — never used to accept or
 * reject an unlock. Passphrase-style secrets are estimated at diceware scale
 * (~log2(20000) bits/word) when they look like N+ lowercase words.
 *
 * @returns {{ entropyBits: number, level: 'weak'|'fair'|'strong', suggestions: string[] }}
 */
export function estimatePassphraseStrength(passphrase) {
  const value = typeof passphrase === 'string' ? passphrase : ''
  if (!value) {
    return { entropyBits: 0, level: 'weak', suggestions: ['Use at least 12 characters — four unrelated words is a good start.'] }
  }

  const suggestions = []
  const trimmed = value.trim()
  const lower = trimmed.toLowerCase()
  const words = lower.split(/\s+/).filter(Boolean)
  const wordsOnly = /^[a-z]+$/.test(lower.replace(/\s+/g, ''))

  let bits
  if (wordsOnly && words.length >= 4) {
    // Diceware-scale estimate: each unrelated word ≈ log2(20000) bits.
    bits = words.length * Math.log2(20000)
  } else {
    const pool = charsetPool(trimmed)
    bits = trimmed.length * Math.log2(pool)
    const stripped = lower.replace(/[^a-z0-9]/g, '')
    if (hasLongRun(stripped) || hasKeyboardRow(lower)) {
      bits = Math.min(bits, trimmed.length * 1.5)
      suggestions.push('Avoid sequences and keyboard runs — they collapse the search space.')
    }
    const unique = new Set(stripped).size
    if (stripped.length > 0 && unique <= stripped.length / 3) {
      bits = Math.min(bits, unique * Math.log2(pool) * 2)
      suggestions.push('Reuse of the same few characters makes guessing easy.')
    }
  }

  const entropyBits = Math.max(0, Math.round(bits))
  const level = entropyBits >= 50 ? 'strong' : entropyBits >= 35 ? 'fair' : 'weak'

  if (value.length < MIN_NEW_PASSPHRASE_LENGTH) {
    suggestions.push(`Use at least ${MIN_NEW_PASSPHRASE_LENGTH} characters.`)
  }
  if (wordsOnly && words.length < 4) {
    suggestions.push('Four or more unrelated words ("correct horse battery staple" style) is the gold standard.')
  }
  if (level === 'strong' && suggestions.length === 0) {
    suggestions.push('Looks strong — consider writing it somewhere safe, it cannot be recovered.')
  }

  return { entropyBits, level, suggestions }
}
