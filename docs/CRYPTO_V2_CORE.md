# V2 crypto core — Phase 1

This documents the implemented primitives, not a completed vault upgrade.
Lifecycle UI, storage integration, padding, deployment and final format report
are later phases. The old application remains in place until it is connected
to this core and its legacy paths are removed.

## Owner clarifications

- Android testing is deferred to future work by the owner (18 October 2026).
- Passphrase changes and Secret Key rotation require the Recovery Key. Both
  wraps authenticate one generation and one KDF configuration, so both must be
  rebuilt. Rewrapping temporarily decrypts VMK with RK; it never exports an
  existing non-extractable session key or re-encrypts media.
- Keep hash-wasm despite its lack of Argon2 associated-data input. Its actual
  published vectors and independent native-reference comparisons replace the
  requirement to run the literal full RFC vector through hash-wasm. The native
  reference separately passes that full vector. No custom Argon2 modification.

## Implementation boundaries

`src/crypto/v2/` provides keyring parsing, wraps, text key encoding, subkeys and
strict object encryption. It uses Web Crypto plus exact-pinned
`hash-wasm@4.12.0` (published 19 November 2024, verified through npm metadata).
Default Argon2id is 65536 KiB / 3 passes / 1 lane. Bounds are enforced *before*
WASM: memory 32768–131072 KiB, passes 2–6, lanes 1–4, salt exactly 16 bytes.
The upper bounds prevent a substituted keyring from requesting arbitrary
memory/time. New passphrases have at least 12 normalized Unicode code points;
all passphrase inputs are NFKC UTF-8, limited to 4096 bytes.

Browser Argon2 runs in a one-shot dedicated worker. Only the passphrase byte
buffer and public KDF settings enter it. On completion, error, timeout (30 s)
or cancellation its worker is terminated, releasing its WASM heap. It receives
neither SK nor VMK. The media worker pool receives only the selected
non-extractable AES purpose key by structured clone. Root VMK stays in session
RAM as a non-extractable HKDF key. `deriveKey` creates non-extractable AES keys
internally, avoiding raw subkey buffers in JavaScript.

Raw SK/RK import consumes and zeroes its byte buffer. The one-time text exports
are intentional credentials for the save UI, not logs or persisted state.
JavaScript strings and browser-managed CryptoKey memory cannot be explicitly
zeroed; callers must release references and clear UI state on completion/lock.

## Canonical encodings

Integers are unsigned big-endian. `LP(x)` is `uint32(byteLength(x)) || x`.
`vault_id` is exactly 32 lowercase hex characters representing 16 raw bytes.
Generation is a positive uint32, encoded as an eight-byte integer in AAD.
Public JSON uses canonical padded RFC 4648 Base64 for salt, nonce and ciphertext.
Unknown fields, duplicate wrap types and noncanonical Base64 are rejected.

Keyring AAD is the concatenation of LP fields:

1. ASCII `VPK2`.
2. Raw 16-byte vault ID.
3. Generation as uint64.
4. Nested LP fields in order: ASCII algorithm, uint32 memory, uint32 passes,
   uint32 lanes, raw 16-byte salt.
5. ASCII wrap type (`pass+sk` or `recovery`).

The pass KEK is HMAC-SHA256(SK, ASCII `VPK2/kek/pass+sk` || raw vault ID ||
32-byte Argon2 output). Recovery KEK is HKDF-SHA256(RK, salt=raw vault ID,
info=ASCII `VPK2/kek/recovery`, length=32). Wraps use fresh 12-byte nonces,
AES-256-GCM, 128-bit tags and exactly 32 plaintext VMK bytes; `ct` is 48 bytes.

Purpose keys use HKDF-SHA256(VMK, salt=raw vault ID,
info=ASCII `VPK2/key/` followed by purpose). Purposes are file/chunk/manifest/
bundle/cache. Every object AAD consists of LP fields: ASCII `VPC3`, raw vault
ID, ASCII kind, raw 8-byte media ID (or empty), uint64 index (or empty).
File/cache require a media ID; chunk requires ID and uint32-range index;
bundle requires an index; manifest has neither. Extra or missing fields fail.
Packed encryption is `[nonce:12][ciphertext][tag:16]`; chunks prepend a
four-byte big-endian chunk index. There is no format sniffing or decrypt
fallback in these primitives. Padding inside plaintext comes in Phase 6.

Key text uses `SK2-` or `RK2-`, 52 Crockford Base32 symbols grouped into 13
groups of four (four trailing zero bits), followed by `-` and Crockford's
standard modulo-37 check symbol. Case and Crockford aliases are accepted;
nonzero padding bits, wrong type, length or checksum fail. The checksum detects
typing errors; it is not an authentication tag.

Every public unlock failure is exactly `Cannot unlock`, without a detailed
cause. Each path authenticates its own wrap plus all shared fields. Damage to
the *other*, unused wrap's valid-length ciphertext cannot be detected without
that wrap's credential; availability and recovery therefore still need backups.

## Verification to date

The Node suite includes published WASM vectors, the native RFC reference test,
WASM/native cross-checks at default and floor settings, Unicode normalization,
all shared keyring-field tampering, each wrap's fields on its unlock path,
downgrade/resource limits, wrong secrets, purpose/vault/ID/index substitution,
nonce changes, non-extractability, rewrapping and recovery.
The native reference tests require Node 24.7+ with `crypto.argon2Sync`.

Brave macOS browser harness: all five purposes round-tripped through real
module workers with non-extractable cloned keys; normal/recovery unlock passed;
wrong-passphrase error was generic. Default-settings creation took 512 ms in
one local run, with 23 UI timer heartbeats during creation. This is not an
Android benchmark or a guarantee for other hardware. No browser errors/warnings
were captured in that run. No independent security review is claimed.

References: [hash-wasm source](https://github.com/Daninet/hash-wasm/blob/master/lib/argon2.ts),
[upstream vectors](https://github.com/Daninet/hash-wasm/blob/master/test/argon2.test.ts),
[RFC 9106](https://www.rfc-editor.org/rfc/rfc9106.html#section-5.3),
[native reference API](https://nodejs.org/api/crypto.html#cryptoargon2syncalgorithm-parameters),
[Crockford encoding](https://www.crockford.com/base32.html).
