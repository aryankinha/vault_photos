# VaultPhotos — Technical Report

> Privacy-first encrypted photo and video storage. Files are encrypted **on the
> client** before they ever leave the browser. The server (Hugging Face) only
> ever stores opaque encrypted blobs. Google-Photos-style UX, end-to-end
> encrypted, zero-knowledge.

This document is the single source of truth for the project: what it is, how
every layer works, the important code, every dependency, and the full runtime
workflows with sequence diagrams.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Tech Stack & Dependencies](#2-tech-stack--dependencies)
3. [Security Model](#3-security-model)
4. [Project Structure](#4-project-structure)
5. [Dependency Rules (layering)](#5-dependency-rules-layering)
6. [Data Schemas](#6-data-schemas)
7. [Layer-by-layer walkthrough](#7-layer-by-layer-walkthrough)
8. [The Cloudflare Worker](#8-the-cloudflare-worker)
9. [Hugging Face wire format](#9-hugging-face-wire-format)
10. [Workflows & Sequence Diagrams](#10-workflows--sequence-diagrams)
11. [Build Order (how it was constructed)](#11-build-order)
12. [V3 Improvements Summary](#12-v3-improvements-summary)
13. [Deployment](#13-deployment)
14. [V3 Architecture & High-Performance Upgrades](#14-v3-architecture--high-performance-upgrades)

---

## 1. Overview

VaultPhotos is a web app that stores your photos and videos on a Hugging Face
(HF) Dataset repository, but in a way where **HF, the proxy worker, and the
network can never read your content**. The user's passphrase is the only secret.
Everything else is derived or encrypted.

```
┌────────────┐     encrypted bytes     ┌──────────────┐    git/LFS    ┌─────────────┐
│  Browser   │ ─────────────────────▶  │  Cloudflare  │ ────────────▶ │ HuggingFace │
│ (does all  │ ◀─────────────────────  │   Worker     │ ◀──────────── │   Dataset   │
│  crypto)   │     encrypted bytes     │ (HF token)   │   repo (blob) │  (encrypted)│
└────────────┘                         └──────────────┘               └─────────────┘
   holds key                              stateless                      public-safe
   in RAM                                 no plaintext
```

- **UX goal:** feels like Google Photos — a thumbnail gallery grouped by month,
  tap a thumbnail to view the full-resolution image or play the video.
- **Security goal:** even if the HF repo is made fully public and the worker's
  source + logs are leaked, the content is still unreadable without the
  passphrase.

---

## 2. Tech Stack & Dependencies

### Runtime / framework

| Dependency | Version | Purpose |
|---|---|---|
| `react` / `react-dom` | ^19.2 | UI framework (React 19) |
| `react-router-dom` | ^7.18 | Client-side routing (`/unlock`, `/gallery`, `/view/:id`, `/upload`) |
| `vite` | ^8.0 | Build tool + dev server |
| `@vitejs/plugin-react` | ^6.0 | React Fast Refresh / JSX |
| `tailwindcss` | ^4.3 | Styling (v4, CSS-first config via `@import "tailwindcss"`) |
| `@tailwindcss/vite` | ^4.3 | Tailwind v4 Vite plugin |
| `lucide-react` | ^1.21 | Icon set (Lock, Upload, Play, Check, …) |

### Domain libraries

| Dependency | Version | Purpose | Notes |
|---|---|---|---|
| `argon2-browser` | ^1.18 | Argon2id key derivation (WASM) | Imported from `argon2-browser/dist/argon2-bundled.min.js` — the default entry does `require('../dist/argon2.wasm')` which Vite cannot bundle; the bundled build inlines the WASM as base64. |
| `exifr` | ^7.1 | EXIF parsing for `date_taken` | Only `DateTimeOriginal` / `CreateDate` / `ModifyDate` are read. |
| `idb` | ^8.0 | IndexedDB wrapper | Persistent thumbnail cache, encrypted upload recovery queue, and short-lived session metadata. |

### Native browser APIs (no library)

- **Web Crypto API + Web Workers** — AES-256-GCM work runs in a four-worker
  pool with transferable `ArrayBuffer`s; chunk indexes are authenticated as AAD.
- **Canvas / OffscreenCanvas** — image downscale + JPEG encode, with a DOM
  canvas fallback for unsupported image paths and all video frame capture.
- **HTMLVideoElement** — video duration + first-frame seek.
- **CompressionStream / DecompressionStream** — gzip manifest encoding with
  automatic uncompressed V1/V2 fallback.
- **IndexedDB + OPFS** — persistent low-resolution thumbnails, encrypted full
  file cache, upload recovery, and decrypted session metadata.
- **MediaSource** — progressive playback when uploaded video bytes are valid
  MSE segments, with full-Blob fallback otherwise.
- **IntersectionObserver** — progressive bundle loading and bounded thumbnail
  object-URL lifetimes.
- **Screen Wake Lock + Background Sync** — long-upload resilience where the
  browser supports these optional APIs.
- **`fetch`** — all network calls.

### Build/lint

`eslint`, `@eslint/js`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`,
`globals`, `@types/react`, `@types/react-dom`.

> **No crypto library is used for the cipher itself.** AES-256-GCM comes from
> the browser's native Web Crypto, which is hardware-accelerated and audited.
> Argon2 (key derivation only) is the one WASM dependency.
> V3 adds no runtime package dependencies; its new capabilities use browser APIs.

---

## 3. Security Model

### Where secrets live

| Secret | Location | Lifetime |
|---|---|---|
| Passphrase | Browser RAM (form field → function arg) | Until key derivation completes, then discarded |
| AES key (derived) | Module-level variable in `crypto/keyDerivation.js` | Until lock or page refresh |
| HF token | Cloudflare Worker env (`HF_TOKEN`) | Permanent (server secret) |
| Salt (16 bytes) | HF repo `salt.bin` (plaintext — **not** secret) | Permanent |
| Decrypted manifest/bundle | IndexedDB/OPFS session cache | Cleared on lock and before each fresh document renders |
| Decrypted thumbnails | IndexedDB `thumbCache` | Persistent until explicitly cleared |
| Encrypted full-file cache | OPFS `files/<id>.enc` | Persistent; useless without the in-RAM key |

### Properties

1. **Passphrase is never stored or transmitted.** It exists only as a JS string
   for the duration of `argon2.hash(...)`, then goes out of scope.
2. **Key is RAM-only.** Refreshing the page clears the module-level variable and
   forces a re-unlock. There is no `localStorage`/`sessionStorage`/cookie
   persistence of the key.
3. **Client-side crypto.** All AES-256-GCM encrypt/decrypt happens in the
   browser. The worker forwards opaque bytes.
4. **Worker is zero-knowledge.** It holds the HF token and proxies bytes; it
   never decrypts, never stores, has no database.
5. **HF stores only ciphertext.** This includes `manifest.enc`, legacy
   `thumbs.bundle`, paged `thumbs_page_N.bundle`, non-chunked files, and chunk
   files. `salt.bin` is plaintext by design and is not a secret.
6. **Authenticated encryption.** AES-GCM appends a 16-byte authentication tag.
   Any tampered blob throws on decrypt.
7. **Wrong-passphrase detection is implicit.** There is no stored hash to check
   against. Instead, the Unlock flow derives the key and attempts to decrypt the
   manifest; failure = wrong passphrase. (An attacker with the repo cannot even
   brute-force offline without re-running Argon2id per guess.)

### Threat model (what's protected vs. not)

| Threat | Protected? |
|---|---|
| HF repo leak / public repo | ✅ Content is ciphertext |
| Worker source + logs leak | ✅ No key, no plaintext ever on worker |
| Network MITM (HTTPS bypass) | ✅ Only ciphertext on the wire |
| Stolen device with locked vault | Full files protected; persistent low-resolution thumbnails remain visible to local origin-storage inspection by design |
| **Forgotten passphrase** | ❌ **Total, unrecoverable data loss.** No reset path. |
| **XSS in the app** | ❌ Would leak the in-RAM key while unlocked |
| Unauthenticated public Worker URL | Content stays encrypted, but an attacker could cause write/availability damage; deployment-level access control is recommended where practical |

---

## 4. Project Structure

```
vaultphotos/
├── public/
│   ├── manifest.json              PWA manifest
│   ├── favicon.svg                app icon (also used by PWA)
│   ├── icons.svg
│   └── sw.js                      encrypted upload recovery via Background Sync
├── src/
│   ├── main.jsx                   session cleanup, SW registration, React root
│   ├── App.jsx                    router + <RequireUnlock> guard + UploadProvider
│   ├── index.css                  Tailwind entry
│   │
│   ├── context/                   batch progress, wake lock, recovery, optimistic state
│   │   ├── uploadContextValue.js  raw context object
│   │   ├── UploadContext.jsx      UploadProvider component
│   │   └── useUploadContext.js    useUploadContext hook
│   │
│   ├── schema/
│   │   ├── manifestSchema.js      V1 fields + optional V3 page/chunk metadata
│   │   └── bundleSchema.js        legacy/page binary parse, serialize, append
│   │
│   ├── crypto/
│   │   ├── keyDerivation.js       argon2id → non-extractable RAM-only CryptoKey
│   │   ├── encrypt.js             AES-GCM packed format + pool facade
│   │   ├── decrypt.js             authenticated decrypt + pool facade
│   │   └── chunkEncrypt.js        32 MiB indexed-AAD async generators
│   │
│   ├── workers/
│   │   ├── cryptoWorker.js        crypto, EXIF, OffscreenCanvas task runtime
│   │   └── cryptoWorkerPool.js    FIFO pool (max four), transfer + lock cleanup
│   │
│   ├── utils/
│   │   ├── uuid.js                16-hex-char id via crypto.getRandomValues
│   │   ├── exif.js                64 KiB EXIF fast path + full-file fallback
│   │   ├── thumbnail.js           canvas → JPEG (≤400px, q=0.7), video first frame
│   │   ├── dateGroup.js           group entries by month for the gallery
│   │   ├── eta.js                 rolling-window ETA Tracker
│   │   ├── errors.js              production-safe user error messages
│   │   └── wakeLock.js            Screen Wake Lock helper
│   │
│   ├── storage/
│   │   ├── workerClient.js        all fetch()/XHR to the worker (raw binary)
│   │   ├── manifest.js            encrypted manifest network operations
│   │   ├── manifestCodec.js       gzip/plain compatibility codec
│   │   ├── bundle.js              legacy + paged bundle operations
│   │   └── opfsCache.js           encrypted media + decrypted session bundle cache
│   │
│   ├── services/
│   │   ├── galleryService.js      cached first paint + page hydration
│   │   ├── uploadService.js       bounded upload + atomic commit + recovery
│   │   ├── viewerService.js       encrypted OPFS read-through + Blob URL
│   │   └── videoStreamService.js  MSE stream with full-assembly fallback
│   │
│   ├── session/
│   │   └── cache.js               IDB session/thumb/uploadQueue stores
│   │
│   ├── hooks/
│   │   ├── useGallery.js          progressive pages + merge state
│   │   ├── usePrefetch.js         bounded hover/long-press promise cache
│   │   ├── useUpload.js           { upload, status, error, reset, STATUS } (legacy)
│   │   └── useViewer.js           prefetch/MSE/full-load orchestration
│   │
│   ├── pages/
│   │   ├── Unlock.jsx             passphrase; auto-detects first-run → Create mode
│   │   ├── Gallery.jsx            progressive grid, filters, recovery actions
│   │   ├── Viewer.jsx             media player, skeletons, touch gestures
│   │   └── Upload.jsx             file picker + background batch triggers
│   │
│   └── components/
│       ├── Topbar.jsx             Lock + dynamic Upload/Gallery navigation buttons
│       ├── PhotoGrid.jsx          shared observer bounds object URL lifetimes
│       ├── PhotoCard.jsx          media tile + optimistic status/retry overlay
│       ├── DateGroup.jsx          month header section
│       ├── PersistentUploadBar.jsx fixed bottom progress bar (ETA + count)
│       └── UploadProgress.jsx     legacy upload list component
│
├── tests/
│   ├── core.test.js               schema/crypto/legacy compatibility suite
│   └── browser/                   50 MiB worker responsiveness harness
├── worker/
│   └── index.js                   17 route patterns, LFS, atomic commits
│
├── wrangler.toml                  CF Worker config (HF_TOKEN/HF_REPO as secrets)
├── vercel.json                    SPA rewrite + asset caching
├── .env.example                   VITE_WORKER_URL only
├── vite.config.js
├── eslint.config.js
├── index.html                     PWA meta + build-substituted CSP
├── package.json
└── README.md
```

---

## 5. Dependency Rules (layering)

The domain graph remains acyclic. UI composition imports hooks/context and the
lower-level unlock/cache APIs it needs; lower layers never import UI modules.

```
pages/components → hooks, context, and lower unlock/cache APIs
hooks/context    → services, session, workers
services         → storage, crypto, utils, schema, session
storage          → crypto, schema, workerClient
crypto/chunks    → worker pool (off-thread facade)
workers          → external libraries only
schema   → (nothing internal)
session  → OPFS storage helper
utils    → (nothing internal)
workerClient → (nothing internal)
```

---

## 6. Data Schemas

### 6.1 Manifest (`manifest.enc`, decrypted = JSON)

```js
Manifest {
  version    : 1,                    // MANIFEST_VERSION constant
  created_at : ISOString,
  updated_at : ISOString,
  bundle_pages?: number,             // V3; absent means legacy thumbs.bundle
  files      : MediaEntry[]
}

MediaEntry {
  id           : string,             // 16 hex chars, matches files/<id>.enc
  name         : string,             // original filename
  type         : "image" | "video",
  date_taken   : ISOString,          // from EXIF, fallback to upload time
  size         : number,             // original file size in bytes
  duration     : number | null,      // seconds (video only; null for images)
  thumb_offset : number,             // byte offset into thumbs.bundle
  thumb_length : number,             // byte length of this thumb in thumbs.bundle
  page_index?  : number,              // V3 page; absent = legacy/page 0
  chunked?     : boolean,             // V3 large-file storage
  chunk_size?  : number,              // plaintext bytes per chunk (32 MiB)
  chunk_count? : number,              // number of encrypted chunk objects
}
```

Validation lives in `manifestSchema.js` → `validateMediaEntry`. The id regex is
`/^[0-9a-f]{16}$/i`; ISO strings are checked by round-tripping through
`new Date(...).toISOString()`.

### 6.2 Thumbnail bundle (`thumbs.bundle` or `thumbs_page_N.bundle`)

```
[4 bytes]   uint32 (big-endian) — number of entries N
[per entry, repeated N times:]
   [16 bytes]  file id as UTF-8 hex   (16 ASCII chars)
   [4 bytes]   uint32 (big-endian)    — thumbnail byte length L
   [L bytes]   raw JPEG bytes
```

Legacy bundles and V3 pages use the same binary layout. V3 caps pages at 50
entries and records `page_index`; old entries keep using `thumbs.bundle`.
`appendBundleEntry` computes `thumb_offset` as the current page byte length plus
the 20-byte entry header.

### 6.3 Encrypted file layout (every `.enc` / `.bundle`)

```
[12 bytes]  AES-GCM nonce (random per encryption)
[rest]      ciphertext + 16-byte GCM auth tag (appended by Web Crypto)
```

`encryptPacked` concatenates these; `decryptPacked` splits at byte 12 and lets
Web Crypto verify the tag (throws on tamper).

Chunked files use an additive V3 layout without changing the legacy format:

```
[4 bytes]   uint32 big-endian chunk index (also authenticated as AES-GCM AAD)
[12 bytes]  fresh random nonce
[rest]      ciphertext + 16-byte GCM tag
```

The reader also accepts the earlier V3 chunk layout `[nonce][ciphertext+tag]`,
where the expected index was AAD but was not stored as a prefix.

### 6.4 HF repo file layout

```
HF Dataset Repo
├── .gitattributes       auto-created on first upload: files/** → LFS
├── salt.bin             16-byte Argon2 salt (plaintext, not secret)
├── manifest.enc         encrypted gzip JSON (plain JSON remains readable)
├── thumbs.bundle        legacy encrypted thumbnail bundle
├── thumbs_page_0.bundle V3 encrypted page (up to 50 thumbnails)
├── thumbs_page_N.bundle additional V3 pages
└── files/
    ├── a3f9c1d2e4b5f607.enc   encrypted full media (LFS-backed)
    ├── b7d2e4f6a8c0b1d3_chunk_0.enc
    ├── b7d2e4f6a8c0b1d3_chunk_N.enc
    └── ...
```

---

## 7. Layer-by-layer walkthrough

### 7.1 `crypto/keyDerivation.js` — the key store

```js
const ARGON2_OPTIONS = { time: 3, mem: 65536, parallelism: 4, hashLen: 32, type: argon2.ArgonType.Argon2id }
let activeKey = null                                   // ← the ONLY place the key lives

export async function unlockWithPassphrase(passphrase, salt) {
  activeKey = await deriveKeyFromPassphrase(passphrase, salt)
  return activeKey
}
export function getActiveKey()     { if (!activeKey) throw new Error('Vault is locked'); return activeKey }
export function clearActiveKey()   { activeKey = null }   // Lock button calls this
```

Parameters: **t=3, m=64 MiB, p=4, hashLen=32** → a 256-bit AES-GCM key. The key
is `extractable: false`; the temporary Argon2 output is zeroed immediately after
`importKey`, and workers receive only a structured-cloned `CryptoKey`.

### 7.2 `crypto/encrypt.js` / `decrypt.js`

```js
// encrypt.js
const nonce = crypto.getRandomValues(new Uint8Array(12))
const ciphertext = await crypto.subtle.encrypt({ name:'AES-GCM', iv:nonce, tagLength:128 }, key, buffer)
// pack: nonce || ciphertext   (ciphertext already includes the 16-byte tag)

// decrypt.js
const nonce = bytes.slice(0, 12); const ciphertext = bytes.slice(12)
return crypto.subtle.decrypt({ name:'AES-GCM', iv:nonce, tagLength:128 }, key, ciphertext)
//                              ↑ throws OperationError if the tag doesn't verify
```

Large packed files and all 32 MiB chunks are dispatched through
`cryptoWorkerPool.js`. The pool is FIFO, uses at most four Vite module workers,
transfers buffers without copying, and is terminated on lock. Manifest and
bundle crypto stays on the main path because those objects are small.

### 7.3 `utils/thumbnail.js`

- **Image:** `createImageBitmap(file)` → canvas scaled so the longest side ≤ 400
  px → `canvas.toBlob('image/jpeg', 0.7)`.
- **Video:** hidden `<video>` → `loadedmetadata` → seek to `duration/2` →
  `onseeked` → same canvas pipeline.
- Target: under ~20 KB JPEG.

### 7.4 `utils/exif.js`

The image fast path parses only `file.slice(0, 65536)`. If the header has no
usable date or parsing fails, it retries the full file for unusual formats.
Videos use `<video>.duration`; missing dates fall back to upload time.

### 7.5 `storage/workerClient.js`

The **only** module that calls `fetch`. All binary is
`application/octet-stream` (raw), not base64 — this avoids 33% inflation and
keeps large video uploads under the CF Worker body cap. Each function returns
`ArrayBuffer` (GET) or accepts `ArrayBuffer|Uint8Array` (POST).

```js
const WORKER_URL = import.meta.env.VITE_WORKER_URL
export const getSalt        = () => getBytes('/get-salt')
export const uploadSalt     = (b) => xhrPost('/upload-salt', b)
export const getManifest    = () => getBytes('/get-manifest')
export const uploadManifest = (b) => xhrPost('/upload-manifest', b)
export const getBundle      = () => getBytes('/get-bundle')
export const uploadBundle   = (b) => xhrPost('/upload-bundle', b)
export const getFile        = (id) => getBytes(`/get-file/${id}`)
export const uploadFile     = (id, b, onProgress, commit = true) => xhrPost(`/upload-file?id=${encodeURIComponent(id)}${commit ? '' : '&commit=false'}`, b, onProgress)
export const getBundlePage  = (i) => getBytes(`/get-bundle-page/${i}`)
export const getChunk       = (id, i) => getBytes(`/get-chunk/${id}/${i}`)
export const preauthUpload  = (id, size, sha256) => postJson('/preauth-upload', { id, size, sha256 })
export const commitUpload   = (id, sha256, size, verifyUrl, verifyHeaders) => postJson('/commit-upload', { id, sha256, size, verifyUrl, verifyHeaders })
export const commitBatch    = (payload) => postJson('/commit-batch', payload)
export const listIds        = () => fetch(`${WORKER_URL}/list`).then(r => r.json())
```

### 7.6 `storage/manifest.js` & `bundle.js`

`manifest.js` compresses serialized JSON with gzip before encryption;
`manifestCodec.js` detects gzip magic bytes and parses old uncompressed JSON
without migration. First-run initialization is an atomic Worker operation,
not a sequence of independent empty-file uploads.

`bundle.js` retains every legacy export and adds page load/save/append helpers.
Upload finalization rewrites only the active page, then publishes it alongside
the manifest and LFS pointers in one commit.

### 7.7 `session/cache.js`

IndexedDB via `idb`, featuring three stores:
1. `kv` — short-lived decrypted manifest metadata and the Worker URL used by the Service Worker.
2. `uploadQueue` — already-encrypted small-file bytes plus metadata. Background Sync uploads only the LFS object; final manifest/bundle publication waits for the unlocked app and remains atomic/idempotent.
3. `thumbCache` — persistent decrypted JPEG previews. This is an explicit personal-device UX tradeoff and can be cleared separately.

OPFS stores persistent full files only as their original encrypted HF bytes in
`files/<id>.enc`; they are authenticated and decrypted on every read. The
decrypted session bundle cache is separate and is cleared on lock/startup.

### 7.8 `services/`

- **`galleryService`** — emits cached thumbnails immediately, hydrates only
  missing page 0 thumbnails, then exposes demand loading for later pages.
- **`uploadService`** — prepares files independently, uses bounded upload
  concurrency, stores LFS objects with `commit=false`, and publishes successful
  files/chunks + bundle pages + manifest in one `/commit-batch` transaction.
  Files at least 50 MiB are read and encrypted 32 MiB at a time.
- **`viewerService`** — reads encrypted non-chunked files from OPFS when
  available, otherwise fetches from the Worker and writes ciphertext through to
  OPFS. Chunked media is authenticated in order; videos first attempt MSE.
- **`videoStreamService`** — appends decrypted chunks to a `SourceBuffer` only
  when the MIME is reported as supported; any append/decode failure triggers the
  complete Blob fallback.

### 7.9 `hooks/`

`useGallery` owns progressive page state and de-duplicates in-flight page loads.
`usePrefetch` coalesces hover/150 ms long-press intent in a bounded eight-item
Promise cache (chunked video is intentionally excluded). `useViewer` consumes
that Promise, handles MSE fallback, and revokes every owned object URL.

### 7.10 `App.jsx` — routing & guard

```jsx
<BrowserRouter>
  <Routes>
    <Route path="/unlock"   element={<Unlock/>} />
    <Route path="/gallery"  element={<RequireUnlock><Gallery/></RequireUnlock>} />
    <Route path="/view/:id" element={<RequireUnlock><Viewer/></RequireUnlock>} />
    <Route path="/upload"   element={<RequireUnlock><Upload/></RequireUnlock>} />
    <Route path="*"         element={<Navigate to="/gallery" replace/>} />
  </Routes>
</BrowserRouter>
```

`RequireUnlock` calls `hasActiveKey()`; if false, redirects to `/unlock`. Because
the key is RAM-only, a page refresh always lands the user back on Unlock.

---

## 8. The Cloudflare Worker

`worker/index.js` — a single default-export module with a `fetch` handler. It
matches 17 route patterns, is stateless, CORS-open (`*`), and handles OPTIONS.

### Routes

| Route | Method | Body/Return | What it does |
|---|---|---|---|
| `/get-salt` | GET | → raw bytes | resolve `salt.bin` (404 if missing = first run, cache-busted) |
| `/upload-salt` | POST | raw bytes | git-commit `salt.bin` |
| `/initialize-vault` | POST | base64 JSON | atomically create salt (if absent), encrypted manifest, and encrypted page 0; refuses an existing manifest |
| `/get-manifest` | GET | → raw bytes | resolve `manifest.enc` (cache-busted) |
| `/upload-manifest` | POST | raw bytes | git-commit `manifest.enc` |
| `/get-bundle` | GET | → raw bytes | resolve `thumbs.bundle` (cache-busted) |
| `/upload-bundle` | POST | raw bytes | git-commit `thumbs.bundle` |
| `/get-bundle-page/:pageIndex` | GET | → raw bytes | resolve cache-busted `thumbs_page_N.bundle` |
| `/upload-bundle-page/:pageIndex` | POST | raw bytes | compatibility page update route |
| `/get-file/:id` | GET | → raw bytes | resolve `files/<id>.enc` |
| `/upload-file?id=...` | POST | raw bytes | **LFS-aware** upload (takes optional `&commit=false` to defer git commits) |
| `/get-chunk/:id/:index` | GET | → raw bytes | resolve `files/<id>_chunk_N.enc` |
| `/upload-chunk?id=...&index=...` | POST | raw bytes | upload an encrypted LFS chunk; supports `commit=false` |
| `/preauth-upload` | POST | → JSON | Direct-to-S3 step 1: negotiate LFS credentials (preupload + LFS batch) using metadata, return S3 upload URL & headers (or check if alreadyExists) |
| `/commit-upload` | POST | → JSON | Direct-to-S3 step 2: finalize LFS upload (optional LFS verify + commit LFS pointer) |
| `/commit-batch` | POST | → JSON | one Git commit for file/chunk LFS pointers, changed bundle/page data, and manifest |
| `/list` | GET | → JSON `[id,...]` | list `files/` tree, strip prefix/suffix (cache-busted) |

### Direct-to-S3 Handshake (`preauthUpload` & `commitUpload`)

These routes are retained for API compatibility, but the V3 app does not call
them: direct browser-to-S3 traffic would broaden the CSP and bypass the rule
that all app network requests go to the Worker. Their legacy flow is:
1. **`preauthUpload`**:
   - Browser sends metadata: `{ id, size, sha256 }`.
   - Worker runs `preupload` and LFS `batch` checks with Hugging Face.
   - If S3 already contains the file with the matching SHA-256, it returns `{ alreadyExists: true }`.
   - Otherwise, returns the S3 `uploadUrl` and `uploadHeaders` (plus `verifyUrl`/`verifyHeaders`).
2. **`commitUpload`**:
   - Browser PUTs the encrypted bytes directly to S3.
   - Browser calls `commitUpload` on the worker with `{ id, sha256, size, verifyUrl, verifyHeaders }`.
   - Worker executes LFS `verify` (if applicable) and commits the LFS pointer to git.

### LFS-aware upload (`hfUploadFile`)

This is the most important function in the worker. It mirrors the official
`@huggingface/hub` `commit` implementation:

```
1. preupload  → POST /api/datasets/{repo}/preupload/main  { files:[{path,size,sample(512B base64)}] }
2. if uploadMode !== 'lfs'  → git-commit as base64 file (small files / manifest / bundle / salt)
3. if uploadMode === 'lfs':
   a. oid = SHA-256(bytes)
   b. batch    → POST {repo}.git/info/lfs/objects/batch   (application/vnd.git-lfs+json)
                 { operation:'upload', transfers:['basic'], hash_algo:'sha_256',
                   ref:{name:'main'}, objects:[{oid,size}] }
   c. PUT raw bytes → batch.actions.upload.href   (S3)
   d. (optional) POST batch.actions.verify.href
   e. git-commit with key 'lfsFile' { path, algo:'sha256', size, oid }
```

### `.gitattributes` auto-init

`ensureGitAttributes(env)` lists the repo root and, when a `.gitattributes`
already exists, reads its contents. It appends
`files/** filter=lfs diff=lfs merge=lfs -text\n` only when the exact path rule
is absent, preserving HF's default rules. The in-isolate Promise coalesces
concurrent first uploads.

### Streaming

`hfResolve` returns `new Response(res.body, ...)` — the upstream body streams
through without buffering, so large video downloads don't blow the worker's
memory. HF auto-302s LFS pointers to S3, so this works for both git and LFS
files transparently.

---

## 9. Hugging Face wire format

Verified against the `@huggingface/hub` source (commit.ts) — the spec's OpenAPI
does not document the commit/LFS endpoints, so this was confirmed from the
official client.

### Git commit (small files)

```
POST /api/datasets/{repo}/commit/main
Content-Type: application/x-ndjson

{"key":"header","value":{"summary":"Update manifest"}}
{"key":"file","value":{"path":"manifest.enc","content":"<base64>","encoding":"base64"}}
```

Each line is a separate JSON object. `key` ∈ `header` | `file` | `lfsFile` |
`deletedFile`.

### LFS commit

Same endpoint, different line:
```json
{"key":"lfsFile","value":{"path":"files/abc.enc","algo":"sha256","size":12345,"oid":"<sha256 hex>"}}
```

### Resolve (download)

```
GET /datasets/{repo}/resolve/main/{path}
→ 302 → S3 URL (for LFS)  or  200 raw bytes (for git blobs)
```

### Tree (list)

```
GET /api/datasets/{repo}/tree/main/{folder}
→ [{ "path":"files/abc.enc", "type":"file", "size":..., ... }, ...]
```

---

## 10. Workflows & Sequence Diagrams

### 10.1 First run — create the vault

User opens the app on a fresh HF repo (no `salt.bin` yet).

```
Browser                    Worker                      HuggingFace
  │                          │                            │
  │── GET /get-salt ───────▶│                            │
  │                          │── resolve salt.bin ──────▶│
  │                          │◀──── 404 (not found) ─────│
  │◀── 404 ─────────────────│                            │
  │                          │                            │
  │  [UI flips to "Create vault" mode]                    │
  │  [user enters passphrase twice, ≥8 chars]             │
  │  salt = crypto.getRandomValues(16 bytes)              │
  │  key   = argon2id(passphrase, salt)                   │
  │                          │                            │
  │  empty page0 + gzip manifest → encrypt both          │
  │── POST /initialize-vault ▶                           │
  │                          │── verify no manifest ────▶│
  │                          │── one atomic commit ─────▶│
  │                          │   salt + manifest + page0 │
  │◀── 200 ─────────────────│                            │
  │                          │                            │
  │  clearCache(); navigate('/gallery')                   │
  │  (gallery loads empty manifest → empty state)         │
```

### 10.2 Returning user — unlock

```
Browser                    Worker                      HuggingFace
  │                          │                            │
  │── GET /get-salt ───────▶│── resolve salt.bin ──────▶│
  │◀── 200 (16 bytes) ──────│◀──── salt.bin ────────────│
  │                          │                            │
  │  key = argon2id(passphrase, salt)   [stored in RAM]   │
  │                          │                            │
  │── GET /get-manifest ───▶│── resolve manifest.enc ──▶│
  │◀── 200 (ciphertext) ────│◀──── manifest.enc ────────│
  │                          │                            │
  │  decryptPacked(manifest, key)                         │
  │   ├── succeeds → navigate('/gallery')                 │
  │   └── throws   → "Wrong passphrase" error             │
```

> The manifest decrypt is the **wrong-passphrase oracle**. There is no stored
> hash; correctness is proven only by successful authenticated decryption.

### 10.3 Load the gallery

```
manifest cache/network → decrypt → gzip/plain parse → sort by date_taken
        │
        ├── read each id from persistent thumbCache
        │      └── emit cached grid immediately
        │
        ├── paged vault: fetch/decrypt only missing page 0
        │      └── sentinel loads page 1, page 2, ... on demand
        │
        └── legacy vault: fetch/decrypt thumbs.bundle unchanged

PhotoGrid shared IntersectionObserver
        ├── near viewport: Blob → object URL
        └── beyond ~3 screens: revoke URL → placeholder
```

### 10.4 Upload a photo or video

The batch pipeline prepares each file independently, continues after per-file
failures, and uses at most three concurrent network uploads:

```
read 64 KiB EXIF → thumbnail → cache thumbnail
        │
        ├── < 50 MiB: worker-pool encrypt whole file
        │              └── queue encrypted bytes for recovery
        │
        └── ≥ 50 MiB: read/encrypt one 32 MiB indexed chunk at a time
        │
        ▼
add optimistic gallery card before network confirmation
        │
        ▼
POST encrypted file/chunks to Worker with commit=false
        └── Worker uploads LFS object and returns {sha256,size}
        │
        ▼
load latest manifest + active legacy/page bundle
append successful entries → gzip/encrypt manifest + encrypt changed page
        │
        ▼
POST /commit-batch
        └── one HF Git commit: LFS pointers + bundle/page + manifest
        │
        ▼
dequeue recovery rows → invalidate decrypted session cache → gallery reload
```

### 10.5 View full-resolution media

```
hover/long press ── optional bounded prefetch Promise
        │
open entry → encrypted OPFS files/<id>.enc?
        ├── hit: authenticate/decrypt with RAM key
        └── miss: Worker GET → authenticate/decrypt → cache ciphertext in OPFS
        │
        ▼
Blob → object URL → image/video
        └── effect cleanup revokes owned URL
```

### 10.6 Lock

```
Topbar "Lock" click
  ├── upload generation++     // late async callbacks become inert
  ├── cryptoPool.terminate()
  ├── release wake lock + clear optimistic/prefetch URLs
  ├── clearActiveKey()
  ├── clearCache()            // decrypted metadata/bundle only
  └── navigate('/unlock', {replace:true})
```

After this, any navigation to a protected route hits `RequireUnlock` → redirect
to `/unlock`, because `hasActiveKey()` is false.

### 10.7 Chunked upload

```
File ≥ 50 MiB
   │
   ├── slice 0..32 MiB → transfer to crypto worker
   │      └── [index=0][nonce][ciphertext+tag] → upload LFS object, no commit
   ├── slice 32..64 MiB → transfer → index=1 → upload, no commit
   └── ... one plaintext chunk resident at a time
          │
          ▼
collect {id,index,sha256,size} receipts
          └── /commit-batch publishes all chunk pointers + manifest + thumb page
```

### 10.8 Chunked video streaming

```
Viewer → MediaSource.isTypeSupported(mime)?
   ├── no  → fetch/decrypt all chunks → Blob URL
   └── yes → create SourceBuffer
              ├── GET chunk 0 → worker decrypt/AAD verify → append → canplay
              ├── GET chunk 1 → worker decrypt/AAD verify → append
              └── ... → endOfStream

Any SourceBuffer/segment failure → cleanup MSE URL → full Blob fallback
```

MSE requires valid browser media segments; arbitrary file slices are not always
appendable. The fallback is therefore a correctness path, not merely a legacy
browser path.

### 10.9 Optimistic UI

```
local thumbnail + encryption ready
   └── addOptimisticEntry → card appears with encrypted/uploading overlay
          ├── progress event → update ring / waiting-for-connection state
          ├── per-file failure → error overlay + Retry
          └── atomic commit succeeds → state done
                 ├── gallery reloads the committed manifest
                 └── optimistic copy expires; real entry wins by id
```

---

## 11. Build Order

The project was constructed strictly in this order — each phase independently
testable before the next began. No UI was written before the crypto/storage
layers were complete.

| Phase | Deliverable | Status |
|---|---|---|
| V1 1-10 | schema → crypto → utils → Worker → storage → services → cache → hooks → UI → PWA | Complete |
| V3-1 | Crypto Web Worker pool and transferable buffers | Complete; 50 MiB browser round trip verified |
| V3-2 | 64 KiB EXIF fast path with full-file fallback | Complete |
| V3-3 | Gzip manifest codec + plain JSON compatibility | Complete; automated test |
| V3-4 | Persistent IndexedDB thumbnail cache | Complete |
| V3-5 | 50-entry progressive bundle pages | Complete |
| V3-6 | Optimistic cards, progress, per-file retry | Complete |
| V3-7 | 32 MiB indexed-AAD large-file chunks | Complete; format + legacy tests |
| V3-8 | Hover / 150 ms long-press prefetch | Complete |
| V3-9 | Encrypted OPFS full-file cache | Complete |
| V3-10 | MSE video streaming with full-assembly fallback | Complete |
| V3-11 | CSP, key/error/nonce audit, atomic initialization | Complete |
| V3-12 | Lazy URLs, skeletons, recovery states, touch gestures | Complete |
| V3-13 | Compatibility tests, cleanup, report and final checks | Complete |

Final verification: **5/5 Node tests**, **`npm run lint` → 0 errors / 0
warnings**, **`npm run build` → clean**, and **`node --check
worker/index.js` → no output**. Production assets: main JS **145.49 kB gzip**,
CSS **5.89 kB gzip**, crypto worker **77.23 kB** emitted separately. The main
bundle is only **4.95 kB gzip** above the measured V2 baseline (140.54 kB).

### Notable issues hit & fixed during build

1. **argon2-browser WASM.** The package's default entry does
   `require('../dist/argon2.wasm')`, which Vite 8 cannot bundle
   (`UNLOADABLE_DEPENDENCY`). **Fix:** import
   `argon2-browser/dist/argon2-bundled.min.js` instead — it inlines the WASM as
   base64. No plugin, no `public/` copying.
2. **React 19 `set-state-in-effect`.** Initial hook implementations called
   `setLoading(true)` synchronously in the effect body. **Fix:** moved all
   `setState` into promise continuations; the mount effect kicks off async work
   without synchronous state writes.
3. **`.env` not gitignored.** **Fix:** added `.env` / `.env.*` / `!.env.example`
   to `.gitignore`.
4. **Fast-refresh lint rule.** `DateGroup.jsx` mixed a component export with the
   `groupByMonth` helper. **Fix:** moved `groupByMonth` to `utils/dateGroup.js`.

---

## 12. V3 Improvements Summary

V3 keeps every V1/V2 wire format and route while changing how work is
scheduled, cached, and committed:

| Area | V3 result |
|---|---|
| Responsiveness | Whole-file and chunk crypto use a transferable four-worker pool; a real 50 MiB round trip preserved animation/timer progress. |
| Large files | Files at least 50 MiB use authenticated 32 MiB chunks, avoiding whole-video reads and detecting reorder/tamper. |
| Gallery scale | Gzip manifests, persistent preview cache, 50-entry bundle pages, and viewport-scoped object URLs reduce startup bandwidth and memory. |
| Upload UX | Optimistic cards appear before network confirmation; files report independent progress/error/retry states. |
| Reliability | Bounded uploads stage LFS objects without Git commits, then publish pointers + changed page + manifest atomically. Recovery is idempotent. |
| Repeat viewing | OPFS persists only encrypted non-chunked HF bytes and authenticates/decrypts them with the RAM key on read. |
| Video | Chunked video attempts MSE playback after the first appendable segment and falls back to complete Blob assembly on unsupported media. |
| Security | Atomic first-run initialization, non-extractable keys, temporary-key zeroing, strict CSP, generic production errors, and lock-time worker cleanup. |
| UX polish | Gallery/viewer skeletons, explicit recovery actions, empty state, swipe/pinch/double-tap image gestures, and offline waiting state. |

Detailed design notes and compatibility behavior are in Section 14.

---

## 13. Deployment

### Worker (Cloudflare)

```bash
npx wrangler deploy
npx wrangler secret put HF_TOKEN     # HF write token
npx wrangler secret put HF_REPO      # e.g. yourname/vaultphotos
```

Smoke test (fresh repo → 404):
```bash
curl -i https://<worker>.<subdomain>.workers.dev/get-salt
```

### App (Vercel)

```bash
cp .env.example .env          # set VITE_WORKER_URL locally
npm run build                 # → dist/
```

Import into Vercel, set `VITE_WORKER_URL` as an env var, redeploy. `vercel.json` includes the SPA rewrite so `/view/:id` resolves on direct hit/refresh.

### Prerequisites

1. HF account + write token (`/settings/tokens`).
2. An HF **Dataset** repo (public is safe — content is encrypted).
3. Deployed worker with `HF_TOKEN` + `HF_REPO`.

---

## 14. V3 Architecture & High-Performance Upgrades

VaultPhotos V3 adds a suite of optimization, security, and UI features to handle massive media libraries and large files (up to hundreds of megabytes) efficiently without causing main-thread blockages, memory spikes, or UI freezes.

### 14.1 Off-Thread Crypto Worker Pool
* **Architecture:** Spawns a parallel pool of Web Workers (using `cryptoWorker.js` and `cryptoWorkerPool.js`) that scale dynamically with the device's CPU cores (up to a concurrency limit of 4) to perform file encryption/decryption tasks off the main thread.
* **Zero-Copy Transfers:** Employs Transferable Objects (`postMessage(..., [buffer])`) to pass raw byte arrays back and forth without data cloning overhead, maintaining high frame rates during bulk uploads.
* **Chunk support:** Large-file chunk encrypt/decrypt uses the same pool, including index AAD and legacy V3 chunk compatibility.
* **Lifecycle Management:** Exposes a `cryptoPool` singleton and terminates active and queued tasks when locking. The non-extractable `CryptoKey` is structured-cloned, never exported as JWK/raw material.

### 14.2 Header-Only Metadata Read
* **Optimization:** Image EXIF extraction first parses `file.slice(0, 65536)` and retries the complete file only if that header has no usable date. Video duration still uses metadata loading through `HTMLVideoElement`.

### 14.3 Gzipped Manifest Serialization
* **Bandwidth Savings:** Compresses manifest JSON with native `CompressionStream('gzip')` before encryption and reverses it with `DecompressionStream` after authenticated decryption.
* **Compatibility:** `manifestCodec.js` checks for gzip magic bytes `1f 8b`; old V1/V2 plaintext JSON bypasses decompression and validates through the same schema parser.

### 14.4 Progressive Bundle Pagination & Schema
* **Incremental Load:** New vaults use encrypted `thumbs_page_N.bundle` files capped at 50 entries. The gallery renders cached/page-0 entries first and positions its sentinel directly after hydrated entries, then requests later pages as the user scrolls.
* **Legacy branch:** A manifest without `bundle_pages` continues to read and append `thumbs.bundle`; no existing page or offset is rewritten as a migration side effect.

### 14.5 Session-Persistent Thumbnail Cache
* **Performance:** The `thumbCache` IndexedDB store persists decrypted low-resolution JPEG previews across browser sessions, so a fully cached gallery needs no bundle request.
* **Explicit tradeoff:** Thumbnails are intentionally plaintext on the trusted personal device. Full-resolution media is never persisted as plaintext; preview cache removal is a separate API.
* **Session binary cache:** Decrypted legacy bundle bytes may use OPFS for faster binary I/O, but that session file is cleared on lock and before a fresh document renders.

### 14.6 Real-time Optimistic UI & Robust Failures
* **UX Enhancements:** Uploading media appears instantly in the gallery with active status cards.
* **Fine-Grained States:** Shows encrypting, uploading, waiting-for-connection, done, and error states. Each file can fail independently, and retry discards the failed queue row before creating a fresh id.
* **Commit handoff:** Successful optimistic entries remain briefly while the gallery reloads; the committed manifest entry wins by id without a visual disappearance.

### 14.7 Chunked Streaming Encryption for Large Files
* **Concept:** Files >= 50MB automatically switch to the chunked upload pipeline. Instead of a single massive memory buffer, files are processed in sequential chunks of 32MB.
* **Reordering Attack Prevention:** Every chunk is encrypted individually using AES-GCM. The 4-byte chunk index (Big-Endian) is passed as Additional Authenticated Data (AAD) during the `crypto.subtle.encrypt` operation. If an attacker tampers with or swaps the sequence of chunks in the Hugging Face repository, decryption fails with an `OperationError` since the AAD signature verification fails.
* **Chunked Assembly:** Worker-backed async generators keep at most one plaintext upload chunk resident. The viewer authenticates chunks in order and either streams appendable video data or assembles a final Blob.

### 14.8 Prefetch on Hover / Long Press (Phase 8)

**Problem:** Tapping a photo caused a visible 200ms–2s delay while the full file downloaded and decrypted, even on fast connections.

**Architecture:**
* **Module-level Promise cache** — one map stores `id → Promise<objectURL>`, so resolved and in-flight work share the same ownership model.
* **Promise coalescing** — repeated intent for the same card returns the existing Promise, including a click that arrives before hover prefetch completes.
* **Bounded memory** — at most eight prefetched items are retained; eviction and lock cleanup revoke eventual object URLs. Chunked videos are excluded so hover cannot start assembling a multi-gigabyte Blob.
* **Desktop** — `onMouseEnter` fires `prefetch(entry)` immediately on cursor hover.
* **Mobile** — `onTouchStart` starts a 150 ms timer; touch end, movement, or cancellation clears it.
* **Viewer consumption** — `consumePrefetched(id)` removes and transfers ownership of the ready or in-flight Promise to `useViewer`, avoiding a duplicate request.
* **Security** — `purgePrefetchCache()` is called from `Topbar.handleLock()` alongside `clearActiveKey()` and `clearCache()`, revoking all object URLs so no decrypted bytes outlive the vault session.

**Key files:** `src/hooks/usePrefetch.js` (new), `src/components/PhotoCard.jsx`, `src/hooks/useViewer.js`, `src/pages/Viewer.jsx`, `src/components/Topbar.jsx`.

### 14.9 OPFS Local Cache for Full Media Files (Phase 9)

**Problem:** Viewing any photo or video always required downloading the encrypted file from Hugging Face and decrypting it, even on repeat views.

**Architecture:** `src/storage/opfsCache.js` stores the exact encrypted HF bytes
under `files/<id>.enc`. Plaintext exists only in memory after a read authenticates
with the active key:

```
User opens photo
      │
      ▼
getCachedFile(id, key) ──hit──▶ decryptPacked → Blob → objectURL
      │
     miss
      │
      ▼
worker.getFile(id) → decryptPacked() → objectURL (normal cold path)
      │
      └──▶ setCachedFile(id, original encrypted bytes)
```

* **Locked persistence is safe** — lock removes the RAM key but deliberately
  keeps ciphertext for fast re-unlock. A corrupt/tampered cache file fails GCM,
  is deleted, and is fetched again from the Worker.
* **Chunked files excluded** — combining all chunks before writing would recreate
  the memory spike chunking avoids. Chunked video uses MSE/fallback instead.
* **Legacy cleanup** — an earlier experimental plaintext `media/` directory is
  removed once if it exists.
* **Feature fallback** — every OPFS operation is guarded; unsupported/quota/error
  cases use the network path without breaking the viewer.

**API:** `isOPFSSupported`, `getCachedFile`, `setCachedFile`,
`deleteCachedFile`, `clearOPFSCache`, and `getOPFSCacheStats`.

**Key files:** `src/storage/opfsCache.js`, `src/services/viewerService.js`, `src/session/cache.js`.

### 14.10 Chunked Video Streaming via MediaSource Extensions (Phase 10)

**Problem:** Even with chunked encryption (Phase 7), the viewer assembled all chunks before creating a single Blob URL. A 2 GB video with 64 chunks still required all 64 chunks before playback started.

**Architecture:** For `entry.chunked && entry.type === 'video'`, the viewer tries
the browser's **MediaSource Extensions (MSE)** API. Playback can begin after the
first valid segment is appended; ordinary MP4 byte slices may be rejected and
therefore always have a full-assembly fallback.

**`src/services/videoStreamService.js`** (new):
* **Codec probing** — `resolveSourceBufferType()` checks generic and common codec-qualified MP4/WebM strings with `MediaSource.isTypeSupported()`. A positive result is treated as a capability hint, not a guarantee about this file's segmentation.
* **`createVideoStream(entry, mimeType, callbacks)`** — creates a `MediaSource`, gets its object URL synchronously, then starts an async coroutine in the `sourceopen` event that:
  1. Calls `mediaSource.addSourceBuffer(sourceBufferType)`
  2. Iterates `decryptFileChunks()` (the Phase 7 async generator)
  3. Attaches completion/error listeners before each `appendBuffer()` and serializes updates
  4. Calls `onProgress(done / total)` after each chunk
  5. Calls `mediaSource.endOfStream()` when all chunks are appended
* **`isMseSupported(mimeType)`** — synchronous feature-detection gate before any MSE work begins.
* **Graceful fallback** — unsupported MIME, synchronous append failure, SourceBuffer error, or invalid media segments all clean up MSE and invoke the full-assembly `loadFullMedia` path.
* **Cleanup** — `cleanup()` aborts any pending `SourceBuffer` operation, calls `mediaSource.endOfStream()`, and revokes the object URL. Called by `useViewer`'s effect cleanup on unmount or navigation.

**Buffering UI in `Viewer.jsx`:**
* A sky progress bar is positioned at the bottom of the `<video>` element, growing left→right as `streamProgress` advances.
* A `Loader2 + "Buffering N%"` indicator appears in the header while `streaming && streamProgress < 1`.
* Both disappear the moment `streamProgress` reaches 1 (all chunks buffered).

**Key files:** `src/services/videoStreamService.js` (new), `src/hooks/useViewer.js`, `src/pages/Viewer.jsx`.

### 14.11 Security, UX, and Regression Audit

The final pass added a build-substituted CSP, generic production-facing errors,
atomic first-run initialization, key clearing on every failed unlock, nonce/AAD
review, lock-generation guards for late async callbacks, skeleton/error recovery
states, and viewport-bounded thumbnail URLs.

**Verification results:**

| Check | Result |
|---|---|
| `npm test` | 5/5: schemas, bundle offsets, AES-GCM tamper rejection, current/legacy chunks, gzip/plain manifests |
| Browser worker harness | 50 MiB round trip identical in 684 ms; input/output transfers detached; 77 animation frames and 41 timer ticks during crypto; no browser errors |
| `npm run lint` | 0 errors, 0 warnings |
| `npm run build` | clean; main 145.49 kB gzip, CSS 5.89 kB gzip, worker emitted separately at 77.23 kB |
| `node --check worker/index.js` | clean, no output |

Main-bundle delta from the measured V2 baseline is **4.95 kB gzip**, below the
60 kB budget. The worker includes `exifr`, so its separate uncompressed chunk is
larger; it is not counted in the main-bundle budget.

**Backward compatibility regression checklist:**

| Scenario | Status |
|---|---|
| Old vault — single `thumbs.bundle` | ✅ Detected via absent `bundle_pages` field; falls to V1/V2 single-bundle path |
| Old manifest — uncompressed JSON | ✅ gzip magic detection selects the plain `TextDecoder` path |
| Old entries — no `chunked` field | ✅ `entry.chunked` is `undefined` → treated as `false` throughout |
| Old entries — no `page_index` field | ✅ Treated as `page 0` (default) |
| Existing encrypted files (V1/V2 layout) | ✅ `decryptPacked` AES-GCM parameters unchanged |
| `salt.bin`, Argon2id parameters | ✅ 16-byte salt and t=3, m=65536, p=4, hashLen=32 unchanged |
| Lock/unlock cycle | ✅ key, workers, decrypted session cache, and prefetched object URLs are cleared |
| All V2 API routes | ✅ existing route paths remain available; V3 routes are additive |

---

*End of report.*
