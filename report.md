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
12. [Known limitations & V2 scope](#12-known-limitations--v2-scope)
13. [Deployment](#13-deployment)

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
| `idb` | ^8.0 | IndexedDB wrapper | Session cache for decrypted manifest/bundle bytes only. |

### Native browser APIs (no library)

- **Web Crypto API** — `crypto.subtle` for AES-256-GCM encrypt/decrypt and
  SHA-256; `crypto.getRandomValues` for nonces, salt, and UUIDs.
- **Canvas API** — thumbnail generation (image downscale + JPEG encode; video
  frame capture).
- **HTMLVideoElement** — video duration + first-frame seek.
- **IndexedDB** (via `idb`) — session cache.
- **`fetch`** — all network calls.

### Build/lint

`eslint`, `@eslint/js`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`,
`globals`, `@types/react`, `@types/react-dom`.

> **No crypto library is used for the cipher itself.** AES-256-GCM comes from
> the browser's native Web Crypto, which is hardware-accelerated and audited.
> Argon2 (key derivation only) is the one WASM dependency.

---

## 3. Security Model

### Where secrets live

| Secret | Location | Lifetime |
|---|---|---|
| Passphrase | Browser RAM (form field → function arg) | Until key derivation completes, then discarded |
| AES key (derived) | Module-level variable in `crypto/keyDerivation.js` | Until lock or page refresh |
| HF token | Cloudflare Worker env (`HF_TOKEN`) | Permanent (server secret) |
| Salt (16 bytes) | HF repo `salt.bin` (plaintext — **not** secret) | Permanent |
| Decrypted manifest/bundle | IndexedDB (session cache) | Until lock or tab close |

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
5. **HF stores only ciphertext.** `manifest.enc`, `thumbs.bundle`,
   `files/<id>.enc`, and `salt.bin`. The salt is not secret — Argon2 is
   designed to be secure with a known salt.
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
| Stolen device with locked vault | ✅ Key is gone; IndexedDB has no key |
| **Forgotten passphrase** | ❌ **Total, unrecoverable data loss.** No reset path. |
| **XSS in the app** | ❌ Would leak the in-RAM key while unlocked |

---

## 4. Project Structure

```
vaultphotos/
├── public/
│   ├── manifest.json              PWA manifest
│   ├── favicon.svg                app icon (also used by PWA)
│   └── icons.svg
├── src/
│   ├── main.jsx                   React root
│   ├── App.jsx                    router + <RequireUnlock> guard
│   ├── index.css                  Tailwind entry
│   │
│   ├── schema/                    (no internal imports)
│   │   ├── manifestSchema.js      Manifest + MediaEntry shape, version const
│   │   └── bundleSchema.js        Binary bundle layout: parse / serialize / append
│   │
│   ├── crypto/                    (no internal imports)
│   │   ├── keyDerivation.js       argon2id → AES-GCM CryptoKey; RAM-only key store
│   │   ├── encrypt.js             AES-256-GCM encrypt → packed [nonce|ct+tag]
│   │   └── decrypt.js             split nonce, AES-GCM decrypt (throws on tamper)
│   │
│   ├── utils/                     (no internal imports)
│   │   ├── uuid.js                16-hex-char id via crypto.getRandomValues
│   │   ├── exif.js                date_taken / type / duration via exifr + <video>
│   │   ├── thumbnail.js           canvas → JPEG (≤400px, q=0.7), video first frame
│   │   └── dateGroup.js           group entries by month for the gallery
│   │
│   ├── storage/                   imports crypto, schema, workerClient
│   │   ├── workerClient.js        all fetch() to the worker (raw binary)
│   │   ├── manifest.js            load/save/addEntry round-trips
│   │   └── bundle.js              load/appendThumb/loadThumbMap round-trips
│   │
│   ├── services/                  imports storage, utils, schema, session
│   │   ├── galleryService.js      load manifest+bundle (cache or net), sort, return
│   │   ├── uploadService.js       the full upload pipeline (read→encrypt→upload)
│   │   └── viewerService.js       fetch+decrypt one file → object URL
│   │
│   ├── session/                   (no internal imports)
│   │   └── cache.js               IndexedDB (idb) — decrypted bytes only, never key
│   │
│   ├── hooks/                     import services only
│   │   ├── useGallery.js          { entries, thumbs, loading, error, reload }
│   │   ├── useUpload.js           { upload, status, error, reset, STATUS }
│   │   └── useViewer.js           { objectUrl, loading, error }
│   │
│   ├── pages/                     import hooks only
│   │   ├── Unlock.jsx             passphrase; auto-detects first-run → Create mode
│   │   ├── Gallery.jsx            date-grouped thumbnail grid
│   │   ├── Viewer.jsx             full-res image / video player
│   │   └── Upload.jsx             file picker + per-file progress
│   │
│   └── components/
│       ├── Topbar.jsx             Lock + Upload buttons
│       ├── PhotoGrid.jsx          builds + revokes object URLs safely
│       ├── PhotoCard.jsx          thumbnail tile (image or video w/ play icon)
│       ├── DateGroup.jsx          month header section
│       └── UploadProgress.jsx     reading→encrypting→uploading→saving step list, with real-time progress
│
├── worker/
│   └── index.js                   Cloudflare Worker (11 routes, HF git/LFS, direct-to-S3)
│
├── wrangler.toml                  CF Worker config (HF_TOKEN/HF_REPO as secrets)
├── vercel.json                    SPA rewrite + asset caching
├── .env.example                   VITE_WORKER_URL only
├── vite.config.js
├── eslint.config.js
├── index.html                     PWA meta tags
├── package.json
└── README.md
```

---

## 5. Dependency Rules (layering)

Strict one-directional layering. No circular imports, nothing imports upward
toward pages.

```
pages    → hooks only
hooks    → services only
services → storage, utils, schema, session
storage  → crypto, schema, workerClient
crypto   → (nothing internal)
schema   → (nothing internal)
session  → (nothing internal)
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
}
```

Validation lives in `manifestSchema.js` → `validateMediaEntry`. The id regex is
`/^[0-9a-f]{16}$/i`; ISO strings are checked by round-tripping through
`new Date(...).toISOString()`.

### 6.2 Thumbnail bundle (`thumbs.bundle`, decrypted = binary)

```
[4 bytes]   uint32 (big-endian) — number of entries N
[per entry, repeated N times:]
   [16 bytes]  file id as UTF-8 hex   (16 ASCII chars)
   [4 bytes]   uint32 (big-endian)    — thumbnail byte length L
   [L bytes]   raw JPEG bytes
```

`bundleSchema.js` exposes `parseBundle`, `serializeBundleEntries`, and
`appendBundleEntry` (which computes the new entry's `thumb_offset` as
`currentBundleByteLength + ENTRY_HEADER_BYTES`).

### 6.3 Encrypted file layout (every `.enc` / `.bundle`)

```
[12 bytes]  AES-GCM nonce (random per encryption)
[rest]      ciphertext + 16-byte GCM auth tag (appended by Web Crypto)
```

`encryptPacked` concatenates these; `decryptPacked` splits at byte 12 and lets
Web Crypto verify the tag (throws on tamper).

### 6.4 HF repo file layout

```
HF Dataset Repo
├── .gitattributes       auto-created on first upload: files/** → LFS
├── salt.bin             16-byte Argon2 salt (plaintext, not secret)
├── manifest.enc         encrypted JSON index
├── thumbs.bundle        encrypted concatenated thumbnails
└── files/
    ├── a3f9c1d2e4b5f607.enc   encrypted full media (LFS-backed)
    └── ...
```

---

## 7. Layer-by-layer walkthrough

### 7.1 `crypto/keyDerivation.js` — the key store

```js
const ARGON2_OPTIONS = { time: 3, mem: 65536, parallelism: 4, hashLen: 32, type: argon2.ArgonType.Argon2id }
let activeKey = null                                   // ← the ONLY place the key lives

export async function unlockWithPassphrase(passphrase, salt) {
  activeKey = await argon2.hash({ pass: passphrase, salt: new Uint8Array(salt), ...ARGON2_OPTIONS })
  return crypto.subtle.importKey('raw', result.hash, 'AES-GCM', false, ['encrypt', 'decrypt'])
}
export function getActiveKey()     { if (!activeKey) throw new Error('Vault is locked'); return activeKey }
export function clearActiveKey()   { activeKey = null }   // Lock button calls this
```

Parameters: **t=3, m=64 MiB, p=4, hashLen=32** → a 256-bit AES-GCM key. The key
is `extractable: false` so it can't be read back out as raw bytes via the API.

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

### 7.3 `utils/thumbnail.js`

- **Image:** `createImageBitmap(file)` → canvas scaled so the longest side ≤ 400
  px → `canvas.toBlob('image/jpeg', 0.7)`.
- **Video:** hidden `<video>` → `loadedmetadata` → seek to `duration/2` →
  `onseeked` → same canvas pipeline.
- Target: under ~20 KB JPEG.

### 7.4 `utils/exif.js`

`exifr.parse(file, ['DateTimeOriginal','CreateDate','ModifyDate'])` → first
finite Date → `toISOString()`. For videos, `<video>.duration` via
`loadedmetadata`. Falls back to `new Date().toISOString()` on any failure.

### 7.5 `storage/workerClient.js`

The **only** module that calls `fetch`. All binary is
`application/octet-stream` (raw), not base64 — this avoids 33% inflation and
keeps large video uploads under the CF Worker body cap. Each function returns
`ArrayBuffer` (GET) or accepts `ArrayBuffer|Uint8Array` (POST).

```js
const WORKER_URL = import.meta.env.VITE_WORKER_URL
export const getSalt        = () => getBytes('/get-salt')
export const uploadSalt     = (b) => postBytes('/upload-salt', b)
export const getManifest    = () => getBytes('/get-manifest')
export const uploadManifest = (b) => postBytes('/upload-manifest', b)
export const getBundle      = () => getBytes('/get-bundle')
export const uploadBundle   = (b) => postBytes('/upload-bundle', b)
export const getFile        = (id) => getBytes(`/get-file/${id}`)
export const uploadFile     = (id, b) => postBytes(`/upload-file?id=${encodeURIComponent(id)}`, b)
export const preauthUpload  = (id, size, sha256) => postJson('/preauth-upload', { id, size, sha256 })
export const commitUpload   = (id, sha256, size, verifyUrl, verifyHeaders) => postJson('/commit-upload', { id, sha256, size, verifyUrl, verifyHeaders })
export const listIds        = () => fetch(`${WORKER_URL}/list`).then(r => r.json())
```

### 7.6 `storage/manifest.js` & `bundle.js`

Round-trip helpers. Both treat HTTP 404 as "empty vault" and return an empty
manifest / empty bundle rather than throwing — this is what makes first-run
work cleanly.

`appendThumb(id, bytes)` fetches the raw bundle buffer, calls
`appendBundleEntry` (which computes `thumb_offset`/`thumb_length`), re-encrypts,
and uploads.

### 7.7 `session/cache.js`

IndexedDB via `idb`, one store `kv` with keys `manifest` and `bundle`. Stores
**decrypted raw bytes only** — never the key. `clearCache()` is called on lock
and after every upload (write-invalidation).

### 7.8 `services/`

- **`galleryService.loadGallery()`** — tries the session cache first; on miss or
  parse failure, fetches via `storage`, writes through to cache. Sorts `files`
  by `date_taken` descending. Returns `{ entries, thumbs: Map<id,Blob>, updatedAt }`.
- **`uploadService.uploadMedia(file, onProgress)`** — the full pipeline (see
  [§10.4](#104-upload-a-photo-or-video)). Operates on two size-based paths:
  - Below 50 MB: Bytes are proxied through the worker (`uploadFile`).
  - 50 MB and above: Uses direct-to-S3 upload (`uploadDirect`) where the browser computes the SHA-256 hash of the encrypted file, requests S3 upload authorization via `/preauth-upload`, directly uploads to S3 using `XMLHttpRequest` (allowing real-time byte-level progress reporting), and finalizes by calling `/commit-upload` to commit the LFS pointer.
- **`viewerService.loadFullMedia(id, mime)`** — `getFile` → `decryptPacked` →
  `Blob` → `URL.createObjectURL`. Caller owns the URL's lifetime.

### 7.9 `hooks/`

Thin React wrappers. `useViewer` revokes its object URL on unmount or id change.
The mount-load effects keep all `setState` inside promise continuations to
satisfy React 19's `set-state-in-effect` rule.

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

`worker/index.js` — a single default-export module with a `fetch` handler. Eleven
routes, fully stateless, CORS-open (`*`), handles OPTIONS preflight.

### Routes

| Route | Method | Body/Return | What it does |
|---|---|---|---|
| `/get-salt` | GET | → raw bytes | resolve `salt.bin` (404 if missing = first run) |
| `/upload-salt` | POST | raw bytes | git-commit `salt.bin` |
| `/get-manifest` | GET | → raw bytes | resolve `manifest.enc` |
| `/upload-manifest` | POST | raw bytes | git-commit `manifest.enc` |
| `/get-bundle` | GET | → raw bytes | resolve `thumbs.bundle` |
| `/upload-bundle` | POST | raw bytes | git-commit `thumbs.bundle` |
| `/get-file/:id` | GET | → raw bytes | resolve `files/<id>.enc` |
| `/upload-file?id=...` | POST | raw bytes | **LFS-aware** upload (see below) |
| `/preauth-upload` | POST | → JSON | Direct-to-S3 step 1: negotiate LFS credentials (preupload + LFS batch) using metadata, return S3 upload URL & headers (or check if alreadyExists) |
| `/commit-upload` | POST | → JSON | Direct-to-S3 step 2: finalize LFS upload (optional LFS verify + commit LFS pointer) |
| `/list` | GET | → JSON `[id,...]` | list `files/` tree, strip prefix/suffix |

### Direct-to-S3 Handshake (`preauthUpload` & `commitUpload`)

For large files, loading the entire payload in the worker exceeds memory/body limits. The worker breaks the LFS flow into a metadata-only handshake:
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

`ensureGitAttributes(env)` lists the repo root; if `.gitattributes` is missing it
commits `files/** filter=lfs diff=lfs merge=lfs -text\n`. This is what makes HF
route `files/**` uploads through LFS. Idempotent (guarded by a tree-listing
check; the in-isolate flag is just a perf optimization).

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
  │── POST /upload-salt ───▶│                            │
  │   body: raw 16 bytes     │── ensureGitAttributes ───▶│ (commits .gitattributes)
  │                          │── git-commit salt.bin ───▶│
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
useGallery()
  │
  │── galleryService.loadGallery()
  │     │
  │     │── loadManifestWithCache()
  │     │     ├── cache.getManifestCache()  ── hit?  parse JSON → return
  │     │     └── miss → loadManifest()
  │     │                  ├── worker.getManifest()  → ciphertext
  │     │                  ├── decryptPacked()
  │     │                  ├── parseManifest()
  │     │                  └── cache.setManifestCache(decrypted bytes)
  │     │
  │     └── loadThumbMapWithCache()
  │           ├── cache.getBundleCache()  ── hit?  parseBundle → Map
  │           └── miss → loadBundle()
  │                      ├── worker.getBundle()  → ciphertext
  │                      ├── decryptPacked()
  │                      ├── parseBundle()
  │                      └── cache.setBundleCache(serialized bytes)
  │
  │── sort files by date_taken desc
  │── return { entries, thumbs: Map<id,Blob>, updatedAt }
  │
  └── PhotoGrid builds object URLs for thumbs (revokes previous set via ref)
```

### 10.4 Upload a photo or video

The central pipeline in `uploadService.uploadMedia`:

```
User picks file(s)
        │
        ▼
[reading]
  readMediaMetadata(file)
    ├── image: exifr → DateTimeOriginal → date_taken
    └── video: <video>.duration, date_taken = now
  generateThumbnail(file, type)
    ├── image: createImageBitmap → canvas (≤400px) → JPEG q0.7
    └── video: seek to duration/2 → canvas → JPEG q0.7
        │
        ▼
[encrypting]
  fileBytes = file.arrayBuffer()
  encrypted = encryptPacked(fileBytes, getActiveKey())   // nonce‖ct‖tag
        │
        ▼
[uploading]
  id = generateMediaId()                                  // 16 hex chars
  Is encrypted size < 50 MB?
    ├── YES (Worker Proxy Path):
    │     worker.uploadFile(id, encrypted)
    │       │                      ┌──────────────────────────────┐
    │       │                      │ Worker hfUploadFile:         │
    │       │                      │  preupload → if LFS:         │
    │       │                      │    sha256 → batch → S3 PUT   │
    │       │                      │    → commit 'lfsFile'        │
    │       │                      │  else: git-commit base64     │
    │       │                      └──────────────────────────────┘
    └── NO (Direct-to-S3 Path):
          1. sha256 = SHA-256(encrypted)
          2. preauth = worker.preauthUpload(id, size, sha256)
          3. If !preauth.alreadyExists:
          │    PUT encrypted to S3 (XHR with progress percent)
          4. worker.commitUpload(id, sha256, size, verifyUrl, verifyHeaders)
        │
  appendThumb(id, thumbBytes)
        ├── worker.getBundle() → decrypt → parseBundle
        ├── appendBundleEntry() → computes thumb_offset/length
        ├── encryptPacked(newBundle)
        └── worker.uploadBundle()
        │
  entry = { id, name, type, date_taken, size, duration, thumb_offset, thumb_length }
  addEntry(entry)
        ├── loadManifest() → push entry → updated_at = now
        └── saveManifest()
        │
  clearCache()        // invalidate session cache; next gallery reloads
        │
        ▼
[done]
  return entry
```

### 10.5 View full-resolution media

```
Browser                    Worker                      HuggingFace
  │                          │                            │
  │  navigate('/view/:id')                                │
  │  useViewer(entry)                                     │
  │── GET /get-file/:id ──▶│── resolve files/<id>.enc ─▶│ (302 → S3 for LFS)
  │◀── 200 (ciphertext) ───│◀──────────────────────────│
  │                          │                            │
  │  decryptPacked(bytes, key) → Blob → objectURL         │
  │  <img src=objectURL>  or  <video src=objectURL controls>
  │                          │                            │
  │  [on unmount / id change] URL.revokeObjectURL(objectURL)│
```

### 10.6 Lock

```
Topbar "Lock" click
  ├── clearActiveKey()        // activeKey = null in keyDerivation.js
  ├── clearCache()            // wipe IndexedDB manifest+bundle
  └── navigate('/unlock', {replace:true})
```

After this, any navigation to a protected route hits `RequireUnlock` → redirect
to `/unlock`, because `hasActiveKey()` is false.

---

## 11. Build Order

The project was constructed strictly in this order — each phase independently
testable before the next began. No UI was written before the crypto/storage
layers were complete.

| Phase | Deliverable | Status |
|---|---|---|
| 1 | `schema/manifestSchema.js` + `bundleSchema.js` | ✅ (pre-existing) |
| 2 | `crypto/keyDerivation.js` + `encrypt.js` + `decrypt.js` | ✅ (pre-existing) |
| 3 | `utils/uuid.js` + `exif.js` + `thumbnail.js` | ✅ (pre-existing) |
| 4 | `worker/index.js` (9 routes, CORS, LFS) + `wrangler.toml` | ✅ |
| 5 | `storage/{workerClient,manifest,bundle}.js` | ✅ |
| 6 | `services/{gallery,upload,viewer}Service.js` | ✅ |
| 7 | `session/cache.js` (IndexedDB) | ✅ |
| 8 | `hooks/{useGallery,useUpload,useViewer}.js` | ✅ |
| 9 | pages + components + `App.jsx` router/guards | ✅ |
| 10 | PWA manifest, `index.html` meta, `vercel.json`, README | ✅ |

Final verification: **`npm run lint` → 0 errors**, **`npm run build` → clean**
(385 kB JS / 132 kB gzip, 21 kB CSS / 4.7 kB gzip), `node --check worker/index.js`
→ OK.

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

## 12. Known limitations & V2 scope

### V1 limitations (by design)

- **Single passphrase, single device.** No multi-device key sync; each device
  must enter the passphrase to derive the same key (deterministic given salt).
- **Upload size limit resolved.** Uploads no longer face the Cloudflare Worker 100 MB request body limit. Files >= 50 MB use the direct-to-S3 upload path where the browser uploads the encrypted payload directly to S3 storage, enabling very large photo and video vault storage.
- **No deletion UI.** Entries can be added but V1 has no delete flow.
- **Wrong passphrase is detected only by failed decryption** (no stored verifier
  hash by design — that would weaken the model).

### Explicitly deferred to V2

GPS display, albums, search, sharing, multi-device key sync, tags, favorites,
size-padding (to hide file sizes), delete, SIMD argon2 build, batch upload progress aggregation.

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

Import into Vercel, set `VITE_WORKER_URL` as an env var, redeploy. `vercel.json`
includes the SPA rewrite so `/view/:id` resolves on direct hit/refresh.

### Prerequisites

1. HF account + write token (`/settings/tokens`).
2. An HF **Dataset** repo (public is safe — content is encrypted).
3. Deployed worker with `HF_TOKEN` + `HF_REPO`.

---

*End of report.*
