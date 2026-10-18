# Isolated browser checks

Start Vite with `npm run dev -- --host 127.0.0.1 --port 5186 --strictPort`.
Use an unused port/origin for UI checks: an existing service worker on an old
origin can intercept media requests outside the document's storage double.

For large-file tests, run `python3 tests/browser/makeLargeVideoFixture.py`
(requires an existing `ffmpeg` installation). This creates an ignored synthetic
160 MiB H.264 MP4 with a standard padding/free box. It exercises twenty 8 MiB
upload chunks; it does not establish compatibility with every MP4 codec.
Delete `public/test-fixtures.local/` **before building or deploying**, since Vite
copies public assets even when Git ignores them.

- `/tests/browser/uploadIntegrationHarness.html?autorun` tests a generated
  recorded WebM plus a mixed selection crossing the ten-file processing window.
- Add `&large` to substitute the generated 160 MiB MP4. The result checks CAS,
  all entries, chunk receipts, monotonic aggregate progress and rollback refusal.
- `/tests/browser/uiHarness.html` runs the actual React app with a storage
  double held only in that document's RAM. No calls go to Cloudflare or HF.
  Create a disposable test passphrase, open Upload, and use the visible fixture
  buttons (the regular picker also works if browser tooling permits it).
  Pause responses, lock, unlock and resume to check interruption recovery.
  Reloading deliberately discards the fake remote vault; this harness tests
  lock/unlock recovery, not recovery after a full document restart.

The UI harness's fake auth-mode response does not test Cloudflare Access.
Worker authentication and HF protocol behavior have separate Node tests.
Browser checks must be recorded with their actual platform and limitations in
`docs/BUGS.md`; passing these doubles is not a live HF upload or Android result.
