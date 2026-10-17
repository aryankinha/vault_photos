# VaultPhotos

> Before deploying the hardening changes, read [Deployment safety](DEPLOYMENT-SAFETY.md).
> The client and Worker now use revision-pinned reads and conflict-checked
> publication. Configure `ALLOWED_ORIGIN` for your frontend and protect the
> Worker with owner-code or Cloudflare Access authentication; an origin allowlist is not authentication.

Privacy-first encrypted photo and video storage. Photos and videos are
encrypted **on the client** before being uploaded to a Hugging Face Dataset
repo. Nobody can view the files without the passphrase — even if the entire HF
repo is public. Google-Photos-style UX (date-grouped thumbnail gallery, tap to
view), end-to-end encrypted, no server ever sees plaintext.

## How it works

```
browser (holds passphrase + key, does all crypto)
   │  raw encrypted bytes
   ▼
Cloudflare Worker (holds HF token, proxies all HF traffic, stateless)
   │  git commit / LFS
   ▼
Hugging Face Dataset repo (stores only encrypted blobs)
```

- **Key derivation:** Argon2id (t=3, m=64MB, p=4) from passphrase + 16-byte salt
  → 256-bit AES key. The key lives only in a module-level JS variable in RAM.
  Refreshing the page clears it and asks for the passphrase again.
- **Encryption:** AES-256-GCM via Web Crypto. Non-chunked objects keep the V1
  `[12-byte nonce][ciphertext+16-byte tag]` format. New videos and files at
  least 50 MiB use independently authenticated 8 MiB chunks with the chunk
  index as AAD. Existing 32 MiB V3 chunks remain compatible.
- **Responsiveness:** A pool of up to four module workers performs transferable
  file/chunk crypto away from the UI thread. Local preparation overlaps a
  bounded network pipeline and two video chunks can transfer concurrently.
- **Video playback:** the service worker answers native HTTP Range requests
  from a same-origin virtual media URL. It fetches and authenticates only the
  encrypted chunks needed for playback or seeking; the full video is never
  assembled in window memory.
- **Recovery controls:** interrupted transactions remain under the original
  media ID and are shown as paused after unlock. Resume is explicit; Discard or
  Cancel removes the queue. Background Sync processes at most three encrypted
  objects per event and never publishes the manifest by itself.
- **Storage layout in HF:**
  - `salt.bin` — Argon2 salt (16 bytes)
  - `manifest.enc` — encrypted gzip JSON index (old plain JSON still loads)
  - `thumbs.bundle` — legacy encrypted thumbnail bundle
  - `thumbs_page_N.bundle` — V3 encrypted pages of up to 50 thumbnails
  - `files/<id>.enc` — encrypted full-resolution media (LFS-backed)
  - `files/<id>_chunk_<n>.enc` — encrypted chunks for large files
- **The worker never sees decrypted content.** It only proxies bytes and holds
  the HF token. The app never talks to HF directly.
- **Local caches:** low-resolution JPEG previews persist in IndexedDB by design;
  repeat-view full files persist in OPFS only as encrypted HF bytes.

## Tech stack

React + Vite · Tailwind CSS v4 · Web Crypto API · argon2-browser · exifr · idb ·
Cloudflare Worker · Hugging Face Dataset · Vercel.

## Prerequisites

1. A **Hugging Face account** with a **write access token**
   (`https://huggingface.co/settings/tokens`).
2. A **HF Dataset repo** (private is fine, public is safe too — content is
   encrypted). Create one at `https://huggingface.co/new-dataset`. Note its
   `username/reponame` id.
3. The **Cloudflare Worker** must be deployed with `HF_TOKEN` and `HF_REPO`.

## Current production authentication

This deployment uses a private owner access code checked by the Worker, without
Cloudflare Zero Trust. The app first asks for that access code, then asks for the
existing vault encryption passphrase. The Worker stores only `AUTH_TOKEN_SHA256`;
never put the code or HF token in frontend environment variables. Read
[Deployment safety](DEPLOYMENT-SAFETY.md) for setup and recovery details.

## Setup

Install dependencies:

```bash
npm install
```

Copy `.env.example` to `.env` and set your deployed worker URL:

```bash
cp .env.example .env
# edit .env → VITE_WORKER_URL=https://<your-worker>.<subdomain>.workers.dev
```

## Deploy the Cloudflare Worker

The worker is the only component that knows the HF token. From the repo root:

```bash
# 1. Deploy the worker code
npx wrangler deploy

# 2. Set the HF token as a secret (will prompt for the value)
npx wrangler secret put HF_TOKEN

# 3. Set the target repo. Either as a secret (recommended) or in wrangler.toml [vars].
npx wrangler secret put HF_REPO
#   value: your-username/vaultphotos
```

Vault creation atomically commits the salt, encrypted empty manifest, and empty
thumbnail page. The first media upload also initializes `.gitattributes` so
`files/**` is stored via LFS. Large finalizations are split into bounded pointer
commits, with the encrypted manifest and thumbnail page published only in the
last commit.

Smoke-test the worker (should return 404 on a fresh repo, meaning "no salt yet"):

```bash
curl -i https://<your-worker>.<subdomain>.workers.dev/get-salt
```

## Run the app locally

### Option A — local worker (recommended while developing)

The deployed worker fails closed unless Cloudflare Access is configured, so run
the worker on your machine while iterating:

```bash
cp .dev.vars.example .dev.vars   # fill in HF_TOKEN and HF_REPO
npm run worker:dev               # wrangler dev → http://127.0.0.1:8787
npm run dev                      # Vite → http://localhost:5173
```

`.env.local` (gitignored) points the app at the local worker.
`ENVIRONMENT=development` in `.dev.vars` disables Access verification **only**
for literal loopback request URLs — public deployments never get this bypass.
Uploads go to the same HF Dataset repo named by `HF_REPO`; point it at a
disposable repo if you want a sandbox.

### Option B — deployed worker

```bash
cp .env.example .env   # VITE_WORKER_URL=https://<your-worker>.<subdomain>.workers.dev
npm run dev
```

The deployed worker requires Cloudflare Access configuration
(`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ALLOWED_ORIGIN`) — see
[Deployment safety](DEPLOYMENT-SAFETY.md). Without it, every request returns
`503 ACCESS_NOT_CONFIGURED`.

In both cases, the first run shows a **Create vault** screen (passphrase
twice → atomically initializes the encrypted vault). Subsequent runs show **Unlock**. If you
enter the wrong passphrase, decryption of the manifest fails and you get a clear
error — there is no way to detect a wrong passphrase except by trying to decrypt.

## Deploy the app

Push to GitHub and import into Vercel, or:

```bash
npm run build
# deploy the dist/ folder (Vercel CLI, Netlify drop, etc.)
```

On Vercel, set the `VITE_WORKER_URL` environment variable to your worker URL and
redeploy. The build inserts that origin into the Content Security Policy;
changing it therefore requires a rebuild. `vercel.json` includes the SPA rewrite so client-side routes
(`/gallery`, `/view/:id`, ...) resolve on refresh.

Vercel enables its feedback toolbar on preview deployments by default. The
privacy CSP intentionally blocks that third-party script. To remove the
`vercel.live` console warning without allowing extra script origins, set
**Project Settings → General → Vercel Toolbar → Preview/Production: Off**, or
set `VERCEL_PREVIEW_FEEDBACK_ENABLED=0` for the preview branch.

## Security notes

- The passphrase is never stored or transmitted. Losing it means **total,
  unrecoverable data loss** — there is no reset path. Store it somewhere safe.
- HF sees only encrypted blobs. The worker sees only encrypted blobs. Only a
  browser that has performed Argon2id key derivation with the correct passphrase
  can decrypt.
- The key is never persisted. Decrypted manifest/bundle session data is cleared
  on lock and before each fresh document renders. Persistent preview JPEGs are
  an explicit trusted-device tradeoff; full-resolution OPFS files are ciphertext.
- AES-256-GCM authenticates every file; any tampered blob fails to decrypt.
- The service worker receives the non-extractable key only through structured
  clone for an active video viewer. It keeps the key and at most three decrypted
  chunks in RAM, then clears both on viewer cleanup or vault lock.
- A public Worker URL hides the HF token but is not user authentication. It can
  still be targeted for write/availability abuse, so apply deployment-level
  access controls when your hosting model allows it.

## Scope

Focused on the encrypted upload → gallery → view flow, including progressive
pages, large-file chunks, recovery, and local ciphertext caching. GPS display,
albums, search, sharing, multi-device key sync, tags, favorites, and size
padding remain out of scope.

## Scripts

- `npm run dev` — Vite dev server
- `npm run worker:dev` — run the Cloudflare Worker locally (wrangler dev)
- `npm run build` — production build to `dist/`
- `npm run lint` — ESLint
- `npm test` — schema, crypto, Worker transaction, streaming-upload, abort, and
  backward-compatibility tests
- `npm audit` — dependency advisory check
- `npm run preview` — preview the production build locally

The repeatable real-browser worker check lives at
`/tests/browser/cryptoWorkerHarness.html` while `npm run dev` is running.
The local `/tests/browser/uploadIntegrationHarness.html` also exposes
`runUploadIntegration()` for an in-memory end-to-end upload check with real
browser crypto and IndexedDB. It does not upload to Hugging Face.
