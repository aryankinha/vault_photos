# Security v2 work log

## Baseline and order

Work is on `security-v2`, starting from `86a7deb`. Initial verification:
176 tests passed, lint passed, production build passed. The owner's existing
uncommitted `report.md` is preserved; it will be regenerated in the documentation
phase, rather than presented as a verified description of the new format.

Phase 0 is in progress. See [BUGS.md](BUGS.md) for symptoms, confirmed defects,
individual fixes, and the uncompleted physical-device checks. No v2 vault has
been created or deployed. The old HF dataset has not been changed by this work.

Owner clarification: changes to the passphrase or Secret Key require the Recovery
Key so both wraps can authenticate the new shared generation and KDF settings.

## Verified platform facts (18 October 2026)

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/):
  Free has 100,000 requests/day, 10 ms CPU/request and 50 external
  subrequests/request. The current startup limit is **1 second**, rather than
  the brief's 400 ms. We should still aim below 400 ms. Local emulation does not
  establish that a route meets the deployed CPU budget.
- [Static Assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/):
  asset requests are free/unlimited; `run_worker_first` requests invoke the
  Worker and count toward its request allowance. Route only the API through
  the script where possible; serving every asset through it changes this.
- [Access on Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
  documents protection of `workers.dev` hostnames. This establishes platform
  support, not that this account can finish enrollment without a card.
- [Independent MFA](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/independent-mfa/)
  is documented. The page does not state a Free-plan entitlement. Do not claim
  it is enabled or included without checking the account. The owner's previous
  enrollment requested a card, so the approved random-token fallback remains
  the deployment path unless genuinely free Access becomes available.

## Remaining acceptance gates

The upgrade is not complete. Phase 1–7 implementation, a fresh public HF dataset,
same-origin deployment, real Worker CPU measurements, Android browser tests and
Argon2 benchmark, backup/restore, destructive purge verification on a disposable
repo, and final free security scans all remain. Do not replace these results
with a local unit-test result or claim an independent security review.
