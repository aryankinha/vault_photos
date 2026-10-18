# Bug triage — security-v2

Baseline: 18 October 2026, commit `86a7deb`, before implementation changes.
`npm test`: **176 passed, 0 failed, 0 skipped**. `npm run lint` and
`npm run build`: passed. The existing uncommitted system report is preserved.

Severity: **A** data loss/security/crash (before Phase 1); **B** broken feature;
**C** cosmetic. A reported symptom is not a confirmed root cause.

| ID | Severity | Action / expected result | Actual result / evidence | Device / browser | Status |
| --- | --- | --- | --- | --- | --- |
| U01 | B | Upload a 160 MB MP4; publish and play it. | Owner reports video upload does not work. Exact failure stage and codec are unknown; MP4 is a container, not a codec. | Owner's device/browser not specified | Investigating; do not claim reproduced with the owner's file. |
| U02 | B | Select multiple files; keep progress and queue accurate. | Preparation callbacks reset aggregate progress to zero while other files upload. Chunk completion also removed in-flight bytes before counting confirmed bytes, and each new chunk reset its card to zero. | Reproduced in Brave macOS isolated mixed-upload harness | Fixed: preserve batch counters, atomically exchange in-flight/confirmed bytes, retain progress during retries, and report cumulative per-video progress. A 12-item mixed batch crossing the processing window passes monotonic progress checks, including a synthetic 160 MiB H.264 MP4 (20 chunks). |
| U03 | B | Generate a video preview or return a bounded error; cancellation releases media decoder. | Thumbnail preparation waits only for `seeked`, has no timeout or abort handling, and leaves the video decoder attached. A zero-time seek or missing event can leave a batch pending forever. | Browser media API; deterministic event-double regression | Fixed: frame-zero handling, 15-second preview timeout, cancellation in metadata/preview, decoder cleanup. Five new regressions pass. Brave macOS isolated photo + recorded WebM upload passed with no captured warnings/errors. Not yet attributed to U01. |
| U04 | A | Add files during an active batch; every accepted file remains queued. | `startBatch` silently drops an entire selection if the retry queue is full, and can exceed its stated 50-action bound when a selection starts below the limit. UI still says upload started. | Shared React upload context | Fixed: accept the whole selection or show a queue-full error asking for reselection. Regression tests cover full, partial-capacity and exact-capacity queues. |
| P01 | B | Publish encrypted metadata to HF. | HF rejected binary metadata outside LFS with 502 at the proxy. | Brave/macOS, live deployment | Fixed before this branch: all encrypted metadata stages through LFS; live photo upload verified. |
| P02 | B | Recover an HF head conflict automatically. | HF returns 412, previously surfaced as 502 instead of `VAULT_STALE`. | Worker/HF | Fixed before this branch: 412 maps to 409 with rebase. |
| P03 | B | Navigate with interrupted connectivity. | Service worker rejected its navigation promise (`Failed to fetch`). | Owner console report | Fixed before this branch: cached shell or explicit 503 fallback. |
| P04 | C | Load production without a toolbar CSP violation. | Vercel feedback script was blocked by strict CSP. | Brave/macOS | Vercel toolbar disabled before this branch; no feedback script on new deployment. |

## Manual coverage (honest status)

The previous deployment session verified a real photo publication and image
decode in Brave on macOS. Browser harnesses cover isolated photo/video upload,
range streaming, crypto workers, viewer hydration, and rollback. These are not
a substitute for the full UI walkthrough or a real 160 MB MP4 on Android.

At this triage session the live Brave tab is at the connection gate, so the
earlier unlocked session is no longer available. Do not overwrite the old
vault or guess credentials to complete checks. Create/delete/recovery tests
must use isolated storage or a fresh test vault.

| Platform | Create/unlock | Small / large / video upload | Gallery / viewer | Delete / lock / interrupted recovery |
| --- | --- | --- | --- | --- |
| Brave macOS (default Shields) | Pending full walkthrough | Earlier live photo passed; isolated harness rerun pending | Earlier live image decode passed | Pending |
| Chrome macOS | Pending | Pending | Pending | Pending |
| Brave Android | Physical device unavailable to agent | Pending | Pending | Pending |
| Chrome Android | Physical device unavailable to agent | Pending | Pending | Pending |

No Android performance result or complete cross-browser sign-off is claimed.

## Confirmed design clarification

The owner chose **require Recovery Key when changing the passphrase or rotating
the Secret Key**. The specified keyring authenticates both wraps with one
generation and KDF configuration. Both wraps must therefore be rebuilt on
these changes; recovery-key possession is required to rebuild its wrap.
