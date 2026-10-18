# VaultPhotos v2 — saving keys and recovery

Implementation checklist for the v2 release. These screens are currently tested
in the isolated lifecycle harness; they are not deployed to the existing vault.

1. **Enable 2FA on GitHub, Cloudflare and Hugging Face first.** Prefer a security
   key and register a second method. Account access can change the app code
   that handles your secrets. API login protects writes and quota; encryption
   protects the public repository's contents. They are separate protections.
2. Create a fresh vault in a fresh HF dataset. There is no migration from the
   old test vault. Do not delete the old dataset until the new vault is verified;
   the owner deletes the old dataset himself.
3. Choose a passphrase of at least 12 characters; four or more random words are
   recommended. Save `VaultPhotos-SecretKey-<vaultid8>.vpkey` somewhere safe.
   That file contains the Secret Key **and** random API access token, not RK.
4. Print/write the Recovery Key and keep it offline in a different place. It
   can decrypt the vault without the passphrase or Secret Key. Do not keep its
   only copy beside the Secret Key file.
5. Re-enter the last two groups of each key before creation can commit. For
   token deployments the Worker needs the displayed SHA-256 verifier configured
   as `AUTH_TOKEN_SHA256`. Only that verifier goes to Cloudflare. The lifecycle
   screen waits for server setup; the deployment tooling is a later phase.
6. Keep independent copies of your original media and encrypted vault backup.
   A repo mirror does not replace a lost decryption key.

## If something is lost

| What happened | What to do |
| --- | --- |
| New browser or cleared site data | Import the `.vpkey` file, enter the passphrase, and optionally remember its Secret Key on this device. |
| Forgot passphrase, lost SK, or both | Use RK to recover; set a new passphrase and save newly generated SK and RK. Server access still needs the API token or owner account recovery below. |
| Lost the key file but trusted browser still remembers SK | Passphrase can still unlock. With RK, rotate SK and download a new key file. A remembered non-extractable SK cannot be exported back to text. |
| Lost RK but still have passphrase + SK | You can still read. Credential changes require RK by the owner's chosen format. Make a new vault with new keys and re-upload originals if you need replacement recovery credentials. |
| Lost API token | Restore it from a key-file backup. Otherwise use the Cloudflare owner account to provision a new random token/verifier; this restores API access, not decryption. Owner recovery tooling is part of deployment hardening. |
| Lost all usable decryption paths | There is no reset/backdoor. Neither Cloudflare, HF nor the developer can recover encrypted media. |
| Server/repo disappears | Restore your encrypted backup to a fresh repo, then unlock using the saved credentials. Backup/restore tooling is a later phase. |

Changing passphrase or SK rewraps the same media key. It does not erase old
keyrings from Git history or revoke a copied old keyring plus its old secrets.
Full media-key rotation is future work; use a fresh vault for that threat.

The Secret Key stays on this device as a non-extractable HMAC CryptoKey. Clearing
browser data removes it. This blocks raw-key export through the normal crypto
API, but malicious app code or an extension can still use an unlocked device's
key. Keep hosting accounts and the browser trustworthy.

## Walkthrough acceptance checklist

- Create; attempt Continue before saving keys (must remain disabled); save SK
  and RK separately, confirm groups, configure verifier, then commit once.
- Lock; enter wrong passphrase (only `Cannot unlock`); unlock correctly with
  remembered SK. On a fresh browser import `.vpkey` or paste SK text.
- Open security settings; enter RK and new passphrase; update; lock; confirm
  old passphrase fails and new passphrase works with unchanged SK.
- Rotate SK with RK; save/confirm new SK file; verify old SK fails and new SK
  works. Existing media must still decrypt without re-upload.
- Recover with RK; choose a new passphrase; save/confirm new SK and RK; verify
  old RK fails and new credentials open the same media.
- Check default five-minute inactivity lock, configurable delay, and ten-minute
  hidden-tab maximum. Activity and visibility checks must run before renewing
  the idle timer when returning from sleep/background.
- Confirm no key text remains on screen after success/lock, keyrings contain
  only wrapped keys/public parameters, and the device DB contains only its
  non-extractable SK CryptoKey.

Android testing is deferred to future work at the owner's explicit request.
Production wiring and full browser walkthrough results will be updated as the
remaining phases complete. These checks are not an independent security audit.

## Results recorded during development

18 October 2026, Brave macOS, isolated storage/downloads in RAM: creation,
disabled-until-confirmed key-save gate, remembered-device unlock, generic wrong
passphrase, passphrase change (generation 2), SK rotation (generation 3), recovery
with new SK/RK (generation 4), old-RK rejection, and new-credential unlock passed.
A configured one-minute idle timer returned the UI to unlock; the setting was
restored to five minutes. No captured warnings/errors in that run. The ten-minute
hidden threshold is covered by policy tests, not a ten-minute live browser wait.
File import/parser and stale-session/device-key preservation tests pass in Node.
Actual OS download/file-picker behavior and production storage remain pending.
