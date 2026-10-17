# Deployment and recovery safety

This implementation changes the client/Worker transaction protocol. Deploy the
Worker before the rebuilt client, and test against a disposable private Dataset
before trusting it with originals. Keep an independent backup of the repository
and `salt.bin`. Do not delete originals based only on an upload progress bar.

## Access control

Configure the Worker's allowed frontend origin explicitly. An origin allowlist
blocks cross-site browser requests; **it does not authenticate curl or other
non-browser clients**. Protect the Worker using Cloudflare Access (or an
equivalent identity-aware gateway), including its `workers.dev` and preview
addresses, before exposing write endpoints. Never put an HF token, Access
service-token secret, or a shared write credential in `VITE_*` variables.

For cookie-authenticated cross-origin Access deployments, the frontend and the
Worker must agree on credentialed CORS. Third-party-cookie policies can block
cross-site cookies even with correct headers. Preflight (`OPTIONS`) requests are
sent WITHOUT credentials by browser spec, so the identity gateway must not
challenge preflight requests — verify this in staging (the Worker itself answers
`OPTIONS` before its own JWT check). Prefer same-site frontend and Worker
domains. Access setup and rate-limit policy are deployment tasks; changing
source code alone does not install those controls on an existing deployment.

Production requests fail closed unless `ACCESS_TEAM_DOMAIN` (the exact
`https://<team>.cloudflareaccess.com` origin) and `ACCESS_AUD` (the Access
application audience) are configured. `ACCESS_EMAILS` optionally restricts
identities further. The Worker validates the signature and claims itself; merely
forging an Access header or sending an allowed Origin is not sufficient.
Use `VITE_ACCESS_CREDENTIALS=include` for the frontend and complete the Access
login before opening the vault. For local development only, `.dev.vars` may set
`ENVIRONMENT=development`; this exception works only for literal HTTP loopback
Worker URLs, not public deployments. `.dev.vars*` files are ignored by Git.

## Deletion is not secure erasure

Removing media from the current manifest and deleting its current file pointers
does not erase Git history, old encrypted thumbnail pages, backups, or all LFS/Xet
objects. Do not automatically garbage-collect by subtracting the current manifest
from an object listing: another tab may have uploads in flight, and older
revisions can still reference those objects. History rewriting and backend object
purging require an explicit, backed-up maintenance operation with uploads stopped.

## Compatibility and recovery

- Existing encryption formats remain readable. Do not strengthen KDF parameters
  in place: existing keys depend on the original parameters and salt.
- A cancelled/discarded transaction may leave encrypted backend objects; local
  queue removal does not mean the backend has reclaimed storage.
- A partially uploaded chunked file needs the original source file again unless
  all encrypted chunks were durably staged. Source identity must be checked, not
  guessed from filename and size.
- Local revision high-water marks detect rollback only on devices that have
  previously opened a newer revision. They cannot prove freshness on a new device.
- Browser storage can be evicted. Preview caching and persistent-storage grants
  are conveniences, not backups. Plaintext thumbnails and queue metadata are a
  documented trusted-device tradeoff.

## Verification

Run `npm test`, `npm run lint`, `npm run build`, and `npm audit` before release.
Local browser harnesses under `tests/browser/` exercise real Web Crypto and
IndexedDB; the upload integration harness uses an in-memory network double and
must not contact the deployed Worker. Backend integration tests use mocked HF
responses, not a real hosted repository. Real Access login, HF permission/rate
limits, Safari playback, service-worker eviction, and large-device-memory behavior
still need staging/device validation.
