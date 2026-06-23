# VaultPhotos

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
- **Encryption:** AES-256-GCM via Web Crypto. Every file is stored as
  `[12-byte nonce][ciphertext+16-byte tag]`. Tampering is detected on decrypt.
- **Storage layout in HF:**
  - `salt.bin` — Argon2 salt (16 bytes)
  - `manifest.enc` — encrypted JSON index of all files
  - `thumbs.bundle` — one encrypted blob with all thumbnails concatenated
  - `files/<id>.enc` — encrypted full-resolution media (LFS-backed)
- **The worker never sees decrypted content.** It only proxies bytes and holds
  the HF token. The app never talks to HF directly.

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

The first upload auto-initializes `.gitattributes` in the repo so that
`files/**` is stored via LFS — this is required for large videos.

Smoke-test the worker (should return 404 on a fresh repo, meaning "no salt yet"):

```bash
curl -i https://<your-worker>.<subdomain>.workers.dev/get-salt
```

## Run the app locally

```bash
npm run dev
```

Open the printed URL. The first run shows a **Create vault** screen (passphrase
twice → generates and uploads the salt). Subsequent runs show **Unlock**. If you
enter the wrong passphrase, decryption of the manifest fails and you get a clear
error — there is no way to detect a wrong passphrase except by trying to decrypt.

## Deploy the app

Push to GitHub and import into Vercel, or:

```bash
npm run build
# deploy the dist/ folder (Vercel CLI, Netlify drop, etc.)
```

On Vercel, set the `VITE_WORKER_URL` environment variable to your worker URL and
redeploy. `vercel.json` already includes the SPA rewrite so client-side routes
(`/gallery`, `/view/:id`, ...) resolve on refresh.

## Security notes

- The passphrase is never stored or transmitted. Losing it means **total,
  unrecoverable data loss** — there is no reset path. Store it somewhere safe.
- HF sees only encrypted blobs. The worker sees only encrypted blobs. Only a
  browser that has performed Argon2id key derivation with the correct passphrase
  can decrypt.
- The session cache (IndexedDB) stores only decrypted manifest/bundle bytes, and
  only while the vault is unlocked. The key is never persisted. Locking or
  closing the tab wipes it.
- AES-256-GCM authenticates every file; any tampered blob fails to decrypt.

## V1 scope

Focused on the core encrypt → upload → gallery → view flow working reliably.
Not in V1: GPS display, albums, search, sharing, multi-device key sync, tags,
favorites, size-padding. All V2.

## Scripts

- `npm run dev` — Vite dev server
- `npm run build` — production build to `dist/`
- `npm run lint` — ESLint
- `npm run preview` — preview the production build locally
