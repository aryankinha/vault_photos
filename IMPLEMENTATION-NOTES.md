# Implementation notes — hardening pass (Oct 2026)

Companion to `FINDINGS.md`. Every item below is implemented, lint-clean, and
covered by the test suite unless explicitly marked as a residual limitation.
`npm test` (168 tests), `npm run lint`, `npm run build`, and `npm audit` pass.

## What changed, by finding

### Critical

- **Manifest lost-update race (W1)** — `/commit-batch`, `/delete-media`, and
  `/initialize-vault` now REQUIRE a `parentCommit` (40-hex, read from
  `GET /vault-head`) forwarded to HF as optimistic concurrency control. A
  conflicted commit returns `409 { code: "VAULT_STALE" }` and is never
  auto-retried; the client re-reads head + manifest, drops already-committed
  ids, and rebases (bounded to 3 attempts) under a Web Lock. All metadata
  (manifest, changed bundle pages, legacy bundle) is published atomically in the
  final commit; oversized metadata is rejected (413) rather than staged early.
- **Chunk-receipt durability (U1)** — chunked rows are persisted BEFORE the
  first chunk upload with full per-chunk plaintext fingerprints; each landed
  receipt is committed in its own atomic IDB transaction. Resume uploads only
  missing chunks and refuses to finalize without full coverage; without the
  source the row is explicitly `needs-source` with a per-row recovery UI in the
  Gallery (direct resume for whole-file rows, reselect for chunked rows).
- **Unauthenticated worker (S1)** — writes are fail-closed on a configured
  `ALLOWED_ORIGIN` allowlist, unsafe legacy routes (`/upload-salt`,
  `/preauth-upload`, `/commit-upload`, `/upload-manifest`, `/upload-bundle`) are
  disabled (410), and production requests additionally require a **verified
  Cloudflare Access JWT** (`security/access.js`: RS256 via the team JWKS,
  strict issuer/audience/expiry/type checks, optional email allowlist, bounded
  key cache, fail-closed configuration). CORS alone is explicitly documented as
  not being authentication. See `DEPLOYMENT-SAFETY.md`.

### High

- **Upload memory (U4)** — windowed intake (10 files), reduced concurrency on
  small devices, plaintext released immediately after encryption, thumbnails
  decoded at bounded scale.
- **Prefetch pinning** — byte-budgeted (200 MB) LRU cache, max 2 concurrent
  fetches, large/chunked items skipped, abort on claim/eviction.
- **Service-worker update killing playback** — explicit-only `skipWaiting`,
  sessions re-registered on `controllerchange`, expired streams notify their
  owning client and the viewer retries bounded (3 attempts, visible failure).
- **Photo disappearing after upload** — the reported cause was page-0-only
  hydration; the gallery now loads pages in display order (newest first),
  reuses upload-persisted thumbnails, and only marks a page loaded when it
  actually loaded.
- **`/list` truncation** — tree pagination now follows cursor/`Link: rel=next`
  with an SSRF guard and entry caps.
- **Delete flow** — `DeleteMediaButton` in the viewer calls a CAS-protected
  `/delete-media` (single atomic commit; pointer deletion only, no history
  rewrite or GC).
- **Grid re-render cost** — memoized cards, `content-visibility` on the grid
  and date groups.
- **Chunk-count ceilings** — publication groups bound each atomic commit
  (≤250 items / ≤1800 pointers); oversized selections commit in multiple
  snapshot-consistent groups.

### Medium / Low

- Context-bound encryption (S3): NEW uploads are encrypted with AES-GCM AAD
  binding `kind + id + index` (`crypto_version: 2` + ciphertext digests in the
  manifest). Decryptors never fall back to legacy AAD on auth failure for v2
  entries. All pre-existing objects remain readable (version is explicit
  metadata, never sniffed); interrupted rows resume in the mode they were
  created in, so mixed-mode files cannot occur.
- Integrity: `sha256` / `chunk_sha256` are verified before decryption when
  present; the worker verifies uploaded ciphertext digests and sizes via
  `crypto.DigestStream` before returning a receipt.
- Passphrase policy (S2) on vault creation only (min 12 + common-password
  rejection); existing passphrases unaffected. KDF params are never changed in
  place.
- Rollback high-water mark per vault (salt+worker scoped), OPFS cache LRU with
  byte cap and encrypted-at-rest bundle writes, cache-management UI, EXIF-less
  photos use file modification time, ETA handles stalls/retries, framing
  headers on Vercel, PWA icons at real sizes, dependency advisories fixed.

## Verification

- `npm test`: 168/168 (worker CAS/limits/native streaming, SW ranges/expiry/
  ownership/context decrypt, upload durability/IDB transactions, crypto
  context/schema/policy, gallery paging, headers/icons, ETA, revision scope).
- Real-browser harnesses (`npm run dev`):
  - `tests/browser/cryptoWorkerHarness.html` — 50 MiB transferable-buffer pool.
  - `tests/browser/uploadIntegrationHarness.html` — end-to-end mocked-network
    upload of a photo AND a chunked video: 2 CAS commits, both entries stamped
    `crypto_version: 2` with aligned digests, zero recovery rows left.
  - `tests/browser/streamIntegrationHarness.html` — SW range serving incl. a
    probe range and a range crossing into a legacy tail chunk.
- `npm run build` and `npm run lint` pass; `npm audit` reports 0 advisories.

## Residual limitations (by design or out of reach)

- Deleting media removes current pointers + manifest entry only. Git history,
  old thumbnail pages, backups, and LFS/Xet objects may retain copies —
  automatic history rewriting/GC would risk destroying objects other writers
  still need. Treat deletion as "removed from vault", not secure erasure.
- Access JWT verification requires deployment configuration
  (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`); unset configuration fails closed.
  Preflight/credentialed-CORS behavior must be validated in staging.
- Background Sync recovery is Chromium-only; iOS relies on the in-app recovery
  panel.
- Rollback high-water marks protect returning devices only.
- Real device validation (iOS Safari playback, jetsam behavior on very large
  batches, Access login flow) is a staging/device task.
