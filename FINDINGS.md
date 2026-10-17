# VaultPhotos — Full Audit Findings (Oct 2026)

> **Implementation review:** This is the original audit, not a verified completion checklist.
> Some claims below were overstated: lock already terminates the crypto pool;
> uploads already cache their thumbnails, which can prevent the reported disappearance;
> the LFS verify specification alone does not establish whether Hugging Face checks uploaded hashes;
> and increasing the whole-image encryption threshold would worsen memory pressure.
> The folder-scale arithmetic also needs correction: 10,000 objects of 8 MiB
> represent about 78 GiB (roughly 39 two-GiB videos), not 2.5 TB.
> Do not apply the suggested fixes mechanically. See implementation notes and tests for actual status.

> Produced by 4 parallel audit passes (security/crypto, worker+HF integration, upload pipeline/reliability, gallery/streaming/platform), each reading the full codebase plus web research.
> Every claim was verified against the code (`file:line`) and external docs where noted. 15/15 tests pass at audit time.

---

## Severity legend

- 🔴 Critical — data loss, vault bricking, or silent corruption
- 🟠 High — major reliability/perf/UX defect users will hit
- 🟡 Medium — real defect, bounded impact or edge conditions
- 🔵 Low — polish, hardening, hygiene

---

## 1. CRYPTO & SECURITY

### S1 — 🟠 Unauthenticated worker, wildcard CORS (`worker/index.js:19–24, 83–108`)
The worker answers `Access-Control-Allow-Origin: *`, has zero auth on **every** route. Any website (drive-by, prefetched in a browser tab) or curl can:
1. **Read** the entire ciphertext corpus + salt (privacy intact, but materializes offline brute force and leaks metadata: file counts, chunk counts, activity timing).
2. **Overwrite `salt.bin`** (`/upload-salt` has no length check) → user's next unlock shows "Wrong passphrase" forever (vault bricked; data recoverable only if original salt is known).
3. **Overwrite `manifest.enc`** with junk → same brick.
4. **Flood the HF repo** with junk LFS objects (quota DoS, junk committed via `/commit-batch`).
5. **Race `/initialize-vault`** (TOCTOU: list-then-commit at `worker/index.js:143–157`) → squat the vault on first run.

**Real fixes (evaluated):**
- ✅ **Origin allowlist** — `env.ALLOWED_ORIGIN` checked against the `Origin` header on all routes + mirrored in the preflight. Stops browser drive-by writers. (Not anti-curl — client-supplied header.)
- ✅ **Cloudflare Access (email OTP allowlist) in front of the Worker** — the only mitigation that raises non-browser attacker cost while preserving zero-knowledge. Supported natively for workers.dev/custom domains.
- ❌ HF-stored issuer token echoed as header — retrieval through the same unauthenticated worker = obfuscation only.
- ⚠️ Shared-secret header vs a worker secret — real auth, but adds worker state.
- Regardless: validate `/upload-salt` = exactly 16 bytes; re-list after commit in `/initialize-vault`.

### S2 — 🟡 Passphrase is the total root of trust; only "≥ 8 chars" enforced (`src/pages/Unlock.jsx:58–60`)
Entire ciphertext corpus is publicly readable (#S1), so Argon2id(64MiB, t=3) ⇄ dictionary attack on an 8-char passphrase is the dominant realistic attack (cf. eprint 2024/1616, USENIX'24).
**Fix:** zxcvbn score ≥3 + min 12 chars or diceware prompt at create; local common-password blocklist.

### S3 — 🟡 No cross-object crypto binding (silent swap attacks)
- AAD is chunk **index only** — chunks of *different files at same index* are interchangeable (`src/crypto/chunkEncrypt.js:21–36`).
- Whole-file/manifest/bundle encryption has **no AAD at all** (`src/crypto/encrypt.js:9–18`).
- Manifest does not store the ciphertext `sha256` (client computes it at upload: `uploadService.js:382, 492`).

Any writer (see S1) can swap `files/<idA>.enc ↔ files/<idB>.enc` or shove any same-key blob into any slot — everything still "decrypts successfully" and renders wrong media silently.
**Fix (client-only, E2EE preserved):** AAD = `kind‖id‖index`; store per-entry ciphertext sha256 (already computed) and verify before render. Legacy objects decrypt via fallback. Long-term: per-file DEK wrapped under vault key (Cryptomator/Tresorit-style).

### S4 — 🟡 No replay/rollback detection
Attacker can restore an old legitimate `manifest.enc`; everything decrypts fine; recent photos silently vanish from the gallery.
**Fix:** monotonic `revision` in the manifest + client-side non-decreasing high-water mark in IDB ("vault rolled back" banner).

### S5 — 🟡 Key lifecycle gaps
- `cryptoWorkerPool.shutdownPool()` has **zero callers** — 4 workers hold the structured-cloned CryptoKey after Lock (`worker/index` — `UploadContext` has lockUploadSession but lock doesn't terminate the pool; see R3 note — `UploadContext.jsx:379–400` never calls `cryptoPool.terminate()`; the pool only dies on provider unmount).
- `clearThumbCache()` / `clearOPFSCache()` exist (dead code) — the promised "Clear cache" UI doesn't exist.
- No passphrase change / rotation flow at all; single key forever.
- KDF params not persisted (Argon2 params hard-coded at `keyDerivation.js:6–12`) — strengthening later breaks old vaults. **Fix:** persist `{alg,time,mem,parallelism,hashLen}` beside the salt for future migrations.

### S6 — 🟡 SW dies silently mid-session → video 404s
`sw.js install→skipWaiting / activate→clients.claim()` (`sw.js:20–26`): every deploy/update drops all `streamSessions`. New SW 404s the virtual URL; **page is never notified** (notifyStreamClient only fires on decrypt failure, not session-missing at `sw.js:69–76`). UI freezes on "Buffering N%"
**Fix:** don't `clients.claim()` while sessions exist; broadcast `vault-stream-expired` on activate; wire `<video onError>` → existing retry path; restrict registered `workerUrl` origin (`sw.js:136` accepts any http origin).

### S7 — 🟡 CSP: clickjacking unprotected
`index.html:7` — `frame-ancestors` absent (and would be ignored in `<meta>` anyway). Vault passphrase entry is frameable.
**Fix:** add `Content-Security-Policy: frame-ancestors 'none'` + `X-Frame-Options: DENY` + HSTS in `vercel.json` headers.

### S8 — ✅ Verified good (confirmed by audit)
- Argon2-browser `parallelism=4` **works** without SharedArrayBuffer — serial in one WASM memory, no throw, no silent param change, bit-identical cross-browser (verified against shipped 1.18.0 dist: no SAB/pthreads; README: "won't be computed in parallel"). Params = RFC 9106's second-recommended config.
- Random 12-byte nonces per object, NIST SP 800-38D compliant at this scale; legacy decrypt fallback has no oracle.
- Non-extractable keys, raw key zeroed after import, SW chunk cache zeroing, bootstrap session-cache wipe, OPFS ciphertext-only (`files/<id>.enc`), legacy plaintext `media/` dir removal, no secret logging, thumbnails strip EXIF/GPS by re-encode.

---

## 2. WORKER & HUGGING FACE INTEGRATION

### W1 — 🔴 Manifest write race = silent data loss
`finalizeUploads()` (`uploadService.js:541–599`) is load-mutate-commit with **no concurrency control**. Worker's `postHfCommit` sets no CAS. Two tabs finalizing (or two devices) → last-writer-wins → one manifest silently loses entries; its LFS bytes become permanent orphans; gallery shows gaps. Same hole in `/initialize-vault` TOCTOU and between SW-background uploads & foreground finalize.
**Primary fix (verified exists in HF API):** commit header supports **`parentCommit`** (40-hex SHA) = real optimistic concurrency:
- Worker: `GET /vault-head` (`/api/datasets/{repo}/commits/main?limit=1`) + pass `parentCommit` on manifest-publication commit.
- Client: base-oid in `finalizeUploads`; on conflict → re-read manifest, drop already-present ids, bounded rebase loop.
- Fix `hfError` so 4xx conflict is `retryable:false` + distinct `VAULT_STALE` code (today 409 is blanket-retryable at `worker/index.js:928`).
- Cheap secondary: **Web Locks API** per-tab serialization (`navigator.locks.request('vaultphotos-vault', ...)`) — covers tab+SW races in a few hours.

### W2 — 🟠 `/list` silently truncates at 1000 files
`hfListTree` (`worker/index.js:825–833`) ignores HF's tree pagination (`limit` default 1000, `cursor`/`Link: rel=next`). With 8MiB chunks, a handful of large videos alone can exceed 1000 objects in `files/`.
**Fix:** loop pages via cursor (≈20 lines) or return `{ids, nextCursor}`.

### W3 — 🟠 No delete flow at all (user can never permanently delete a photo)
No `deletedFile` anywhere; and note: pointer-delete alone does **not** reclaim HF storage ("Deleting only LFS pointers doesn't free up space").
**Fix spec:** `/delete-media` NDJSON `deletedFile` ops + **`DELETE|POST /api/datasets/{repo}/lfs-files/batch`** (`deletions:{sha:[≤1000]}, rewriteHistory:true`) from the OpenAPI-verified endpoint; re-fetch vault-head after history rewrite (parentCommit resync). Also enables orphan GC.

### W4 — 🟠 Orphaned LFS objects accumulate & count against quota
Enumerated paths: cancel mid-batch; finalize failure after bytes uploaded; chunked file with 1 failed chunk (N−1 chunks uploaded, `chunkController.abort()`, nothing committed); SW partial sync; preauth/commit-upload leftovers. Quota is enforced **at PUT time** (documented community reports), and there is no auto-GC for uncommitted objects.
**Fix:** capture `<sha,size>` receipts at PUT time (already in `parseUploadResponse` — just persist to queue rows), add reconciliation: `GET lfs-files` ⨯ manifest diff → orphan list → batch-delete route. (Some functions for stats exist as dead code: `getOPFSCacheStats`, etc.)

### W5 — 🟠 Scale: 2 GB video ⇒ 256 chunk files ⇒ ~7 sequential HF commits
`commitPlan` caps at 40 ops ⇒ ceil(256/40)=7 pointer batches, each a full HF git transaction (60s guidance, history grows), all sequential on the await path. Every upload also rewrites `manifest.enc` + latest bundle page → git history grows ~forever.
**Fixes:** raise `MAX_LFS_POINTERS_PER_COMMIT` toward HF's 50–100 guidance; multi-part transfer for huge files (`transfers:["basic","multipart"]` in LFS batch = native resumable per-part PUTs); periodic super-squash (`POST /api/datasets/{repo}/super-squash/{rev}` — destructive, needs UI) ; consider manifest sharding.
**HF hard limits (verified):** no repo-size cap; ~100k files/repo recommended; **10k entries per folder** (everything lives in `files/` today — 10k objects = ~2.5 TB of 2GB videos... actually ~39 two-GB videos ⇒ subdirs or shard soon); commit ceilings: 25k LFS files + 1 GB regular payload per commit.

### W6 — 🟡 Worker robustness
- Headerless fallback path (`readRawBody` → full `request.arrayBuffer()`) can kill the isolate at 128 MB; add 413 for descriptor-less large bodies.
- `request.json()` failure → 500 with misleading `STORAGE_FAILED`; wrap → 400 `INVALID_JSON`.
- `/commit-batch` accepts unbounded arrays → self-DoS (25k sequential commits); add hard cap (~2000 items).
- `ensureGitAttributes` memo keyed to nothing (`worker/index.js:839–866`); key by `env.HF_REPO` or delete (HF auto-edits `.gitattributes` on first LFS commit per OpenAPI).
- Retry duplication: `postHfCommit` retry re-POSTs identical NDJSON → duplicate commits when a response is lost (multi-batch partials stack); 429 retry (max 1.8s) vs HF 5-min rate windows is doomed — honor `RateLimit` headers.

### W7 — 🔵 Xet is live; worker rides the legacy bridge
`transfers:["basic"]` still works (Git LFS bridge), but forgoes multipart + Xet shard efficiency. Note: Xet chunk-dedup does **not** reduce logical quota (storage = logical sizes, HF-confirmed).

### W8 — 🔵 wrangler.toml
Add `[observability] enabled=true` (every failure currently funnels through one `console.error` — invisible in prod), consider `[limits] cpu_ms`, custom domain (prerequisite for dropping `*` CORS), `[placement] mode="smart"`.

---

## 3. UPLOAD PIPELINE & RECOVERY

### U1 — 🔴 Chunk receipts are only persisted after ALL chunks finish
`processFile` only queues non-chunked files (`uploadService.js:398–407`); `uploadOne` accumulates receipts in RAM; `queueChunkedUpload` runs only at the end (`uploadService.js:527–538`). Tab/browser death mid-video = **no queue row exists** → upload silently vanishes (no "interrupted" banner), all uploaded 8MiB LFS objects orphan, whole video restarts from scratch. On iOS this is the *only* recovery path (Background Sync doesn't exist on Safari/Firefox).
**Fix:** persist the row first (`Array(chunk_count).fill(null)` sparse chunks) → `markChunkUploaded(id, index, receipt)` after every receipt (new helper; two in-flight receipts race the row RMW — flush via per-id write queue or combined put) → resume only missing indexes; if source File is gone, banner offers "re-select file" (verify size/name match; skip metadata/thumbnail regen; keep same id); finalize guard asserts full receipt coverage. Tests: sparse-row resume.
- Bonus (v2): persist chunk ciphertext in OPFS per chunk so half-failed chunks need no source at all.

### U2 — 🔵 (verified OK) Resume idempotency mostly sound
`queuedReceipt` skip + LFS `alreadyExists` (no-reupload) + `existingIds` manifest filter → no double manifest entries vs double PUT. Residues: multi-batch commit retries re-commit already-landed pointer batches (history churn — see W6); rows missing thumbnails are **stuck forever** in the banner (`uploadService.js:211–218` — never dequeued, no per-row discard) → add per-row discard/rebuild.

### U3 — 🟠 UploadContext state machine
- **Lock deletes the entire upload queue** (`lockUploadSession` → `clearUploadQueue()` at `UploadContext.jsx:386`) — interrupted uploads lose everything on every lock. Keep ciphertext-only rows (encryptedBytes is ciphertext; safe) and thumbnails per the documented tradeoff.
- `retryOptimistic` while an upload runs **silently drops the click** (queued-row path returns because `uploadRunningRef` is true and nothing is re-queued — `UploadContext.jsx:231`).
- `pendingUploadCount` never refreshes while rows appear mid-session.
- `retryQueueRef` (files pushed while busy) is unbounded & invisible.
- Cancel does not clear optimistic-removal timers (lock does).
- Wake-lock re-acquire is sound; one stale-promise leak: `onVisibilityChange` may write a lock *after* cancel/lock set `wakeLockRef=null` → guard with `uploadRunningRef`.
- (Truth table traced test #4 deemed verified: post-lock late callbacks are inert — generation gates + `getActiveKey()` throws before crypto runs.)

### U4 — 🟠 Memory: batch retains every encrypted buffer until finalize
`processed[]` holds `item.encrypted` for the whole batch lifetime (`uploadService.js:95–99` + never nulled) → 500 × 40 MB = **~20 GB heap target**; iOS jetsams WebContent ~1.5 GB (WebKit bugs 268816/277848). Plus per-file transient: full-res `createImageBitmap` decode (190 MB for 48MP HEIC) on the **main thread**, IDB structured-clone copy, ×3 concurrency ≈ 900 MB transient peak.
**Fix:** `item.encrypted = null` after the XHR succeeds (finalize needs only receipts); use `createImageBitmap(file, {resizeWidth/Height: 400})` decode; scale `BATCH_CONCURRENCY` down on mobile (`hardwareConcurrency<=4`); keep a pointer to the IDB row for in-session retry instead of the RAM copy; stage large selections in windows of ~10.

### U5 — 🟡 Retryable server errors never auto-retry
`withNetworkRecovery` loops **only** while offline (`uploadService.js:754–784`). A transient HF `502` → `LFS_UPLOAD_FAILED (retryable)` → one-shot sticky error card, manual retry only.
**Fix taxonomy:** offline/concurrency-wait (today) | `retryable=true` & 429 → 3 attempts, 1s/4s/15s + jitter, honor `Retry-After` | 4xx validation → fail immediately | abort → never retry. Also treat 502/503/504 with non-JSON bodies as retryable (`workerClient.js` opaque-error path).

### U6 — 🟡 No end-to-end byte integrity at upload time
`X-Vault-SHA256` is trust-based; LFS POST verify = **existence check only** (Git LFS basic-transfer spec; neither HF nor git-lfs compares bytes); a corrupted/truncated PUT satisfies Content-Length and is never caught until a future decrypt accidentally fails GCM (years later; "authenticated-lost").
**Fix ladder (cheap→best):** worker re-hash for ≤8 MiB chunk bodies (buffer + `sha256Hex` compare, reject mismatch) | small-file read-back hash after upload | per-chunk sha recorded in manifest (already computed) + a "repair chunk" flow on GCM failure.

### U7 — 🟡 UX gaps worth building
(no delete — see W3) client-side duplicate hint (size+date+name vs manifest; random nonces make LFS oid-dedup useless for user-level dupes); desktop **drag & drop + clipboard paste** (Upload.jsx is picker-only); interrupted-banner split by row state (uploadable vs needs-source vs discardable); HEIC-in-Chrome rejection message ("convert to JPG"); faststart/moov-at-end videos re-fetch tail 8MiB chunks (can't re-encode in E2EE pipeline — mitigate via bigger LRU); `exifr` uses device-tz interpretation for timezone-less EXIF (date-only).

---

## 4. GALLERY / VIEWER / STREAMING / PLATFORM

### G1 — 🟠 SW kill on update silently kills playback (see S6) — wired retries missing
(behavior verified: same-origin SW 206 responses work on all engines incl. iOS ≥13; Safari's `bytes=0-1` 2-byte probe is satisfied by the current impl; Content-Length math verified correct; multi-range→416 is acceptable — prefer tolerant 200 fallback; WebKit only refuses 200-for-Range so always-206 is right.)

### G2 — 🟠 Photo disappears ~10 s after upload commits
`removeOptimisticEntry` schedules deletion at +10 s (`UploadContext.jsx:107–117`); reloaded manifest hydrates **only page 0** (`galleryService.js:119–153`) while the new thumb lives on the **last** page → the just-uploaded photo drops out of `visibleEntries` (its page isn't loaded) until the user scrolls enough. Users literally watch their photos vanish.
**Fix:** on manifest reload, eagerly `loadPage(page_index)` for freshly committed ids (or have the paged `done` update carry `pagesTouched`).

### G3 — 🟠 Prefetch pins up to 8 full-res decrypted images
`prefetchCache` holds URL promises; Blobs revoked only on 9th hover/lock (`usePrefetch.js:7, 51–59`). Chunked images (≥50 MB, incl. RAW/Panoramas) are **not excluded** (`usePrefetch.js:13` excludes only chunked videos) → hovering a grid of big photos assembles each (200 MB peak each) and *keeps* them: ~800 MB steady.
**Fix:** byte-budget cache (evict to ~256 MB by Σ size), skip `entry.size >= CHUNK_THRESHOLD` for any type, decref on mouse-leave, and dedupe with OPFS (one blob URL per id reused).

### G4 — 🟠 OPFS ciphertext cache grows forever
`files/<id>.enc` never evicted; `clearOPFSCache`/`getOPFSCacheStats`/`getThumbCacheStats` have **zero callers** (no usage UI); quota failures silently swallowed (`opfsCache.js:127–132`); `cachedAt` written but never used by any pruning; `getThumbCacheStats` loads every Blob into RAM just to sum sizes.
**Fix:** LRU by `lastModified` with a byte cap (`estimate().quota × ~0.1`), `navigator.storage.persist()` at unlock, `storage.estimate()` + usage UI wired to the existing dead stats, `QuotaExceededError` → Topbar warning. (iOS Safari origin quotas: ~60% disk for browser, 15% webviews; older Safari hard-caps IDB near 500 MB.)

### G5 — 🟠 Grid re-render storm at scale
`THUMB_BATCH_SIZE=8` → each batch emits `new Map(...)` (`galleryService.js:214–224`) → `setThumbs` → full `Gallery` re-render (mergedThumbs recompute + every LazyPhotoCard diffs `thumbs.get(id)`) → 5k photos = **625 full-grid recomputes + 625 full re-renders** during phase 2.
**Fix ladder:** per-card thumb subscription (`useSyncExternalStore` over a mutable Map + version) | virtualize (`TanStack Virtual` / `react-virtuoso` for month-grouped grids, `react-window` for fixed-size) | minimum: `content-visibility: auto` on `DateGroup`. Also throttle `streamProgress` updates (rAF/int-percent change only).

### G6 — 🟠 Viewer peak memory for chunked images + OPFS hot path
- Chunked *image* (any file ≥50 MB) → `loadFullMedia` pushes **all** decrypted chunks then `new Blob(chunks)` — 2× peak per view (~pre-existing + prefetch = 3×).
- OPFS path decrypts whole file then `new Blob([cached])` — another 2×; cold path (fetch+decrypt+OPFS write) ~3×.
**Fix:** raise image chunk threshold (keep images whole ≤300 MB, e.g.) or extend the SW chunk machinery to serve images (streaming Response, peak=O(chunk)); reuse one object URL per OPFS-cached id.

### G7 — 🟡 Phantom bundle pages → permanent shimmer
Page 404 (interrupted write, older manifest) → `loadGalleryPage` tolerates 404 → `useGallery.loadPage` marks the page loaded regardless (`useGallery.js:121`) → entries on that page are visible-with-no-thumbs forever; no retry affordance exists for pages other than the sentinel.
**Fix:** detect incomplete page coverage → treated as `pageError` + Retry (or lazily re-fetched once).

### G8 — 🟡 No offline shell (PWA promise unmet)
`sw.js` precaches nothing; offline load = browser error page. For a local-first E2EE vault, add shell precache (network-first HTML + runtime-cached assets) with stream-path early-return preserved (fetch handler must check `url.origin === self.location.origin` too — currently matches `/__vault_stream__/` on **any** origin, `sw.js:65–76`).

### G9 — 🔵 Verified-good items (no action)
Chunk-boundary/Range math; moov-at-end tail fetch correctness (`createRangeBody` spans boundary chunks); evicted-chunk zeroing; `useViewer` fallback/revocation traces; StrictMode double-load dedup; `verified Vercel serves /sw.js` (filesystem precedes rewrites); SW-206 + iOS Safari compatibility matrix; workerUrl-from-IDB not required for streaming (per-session message carries it).

### G10 — 🔵 manifest.json icons
Only SVG (`sizes:"any"` + maskable). Add 192/512 PNG (maskable SVG crops on Android launchers), or padded safe-zone SVG.

---

## 5. HYGIENE / DEAD CODE

- `preauthUpload`/`commitUpload` (client + worker routes `worker/index.js:213–333`) — unused; decide: revive as resumable direct-to-S3 or delete both halves.
- `listIds`, `uploadEncryptedFile`, `saveManifest`, `addEntry`, `appendThumb`, `saveBundlePage`, `appendThumbToPage`, `encryptChunked(buffer)` — unused exports (buildPagedBundle uses its own append); prune or document.
- `shutdownPool`, `clearThumbCache`, `clearOPFSCache`, `getThumbCacheStats`, `getOPFSCacheStats`, `markQueuedUploadUploaded` — implemented but never wired.
- `useUpload.js`, `UploadProgress.jsx` — legacy leftovers.
- Tests: nothing covers `uploadService` pipeline integration (chunk receipts, resume), `preupload`/`preauth` routes, or gallery service paging; add for U1/W1 fixes.

---

## 6. PRIORITY ROADMAP (suggested order)

| P | Item | Why first |
|---|------|-----------|
| 1 | **W1 parentCommit CAS + Web Locks serialization** | Without it every other fix is layered over silent data loss |
| 2 | **U1 chunk-receipt durability (sparse rows + resume-missing)** | Biggest user-facing loss today (esp. iOS, no Background Sync) |
| 3 | **S1 origin allowlist + salt length check (+ Cloudflare Access when feasible)** | Stop browser drive-by vault destruction |
| 4 | **U4 memory (null ciphertext after upload, resize decode, scaled concurrency)** | Guaranteed jetsam death on iOS today |
| 5 | **S6/G1 SW stream-expired handling + `<video onError>` retry** | Silent playback death after deploys |
| 6 | **G2 photo-vanish-after-upload fix** | Trust-eroding, cheap |
| 7 | **W2 `/list` pagination + W3 delete flow (+ lfs-files/batch GC)** | Enables the product basics users expect |
| 8 | **W5 scale: raise commit caps, multipart LFS, folder sharding plan** | Keeps the vault viable beyond ~40 large videos |
| 9 | **G3/G4/G5 gallery memory + virtualization + caching caps** | Scale UX |
| 10 | **S3 context-AAD + manifest sha256, S4 revision counter, U6 integrity** | Defense-in-depth once the above is stable |

---

*End of findings.*
