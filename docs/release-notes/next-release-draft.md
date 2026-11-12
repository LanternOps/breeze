# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.128.0** (2026-11-10).

---

## Release to-do (pre-cut gates — see `/release` Step 0.2)

Lab checks owed before the next tag:

- [ ] **macOS remote desktop double-click** (#11670, #11549). Run on a signed release candidate on the lab Mac (a branch build cannot keep the screen-recording grant). Rows: double-click opens a folder; double-click selects a word; triple-click selects a line; two slow clicks still rename; click-move-click is two clicks; right-then-left is not a double-click; drag-select still works.
- [ ] **Helper branding and localisation** (#11204). Check native window titles and tray labels in Portuguese on Windows and macOS (the contributor tested on Linux only).
- [ ] **Windows sign-in screen capture** (#9583). The RDP-session preference step is still not lab-verified.
- [ ] **Built-in H.264 encoder fallback** (#11639, open). If a fix lands, re-check picture quality after a burst on a static screen.
- [ ] **Windows self-uninstall** (#11349, still open) — on hold for its lab leg.
- [ ] **Viewer clipboard** (#11325, still open) — on hold for its lab leg.
- [ ] **YARA scan skips its own rule cache** (#11728). On a Windows host with YARA rule sets and auto-quarantine on, run a full scan: no threat under `%ProgramData%\Breeze\data\yara\cache\`, and the `.byrc` files are still there afterwards (reported in #11728).
- [ ] **Portal Sign in with Google** (#11384: W07a API and W07b web, portal and docs both ship dark; W07b's browser check stubbed Google up to the authorize redirect). Needs a real Google OAuth web client and real Workspace / Gmail accounts; gate before `PORTAL_GOOGLE_CLIENT_ID` is set in any region (after W07b deploys). Rows: (1) a Workspace token carries `hd` equal to the user's domain and `email_verified: true`, and a personal Gmail token (no `hd`) is refused; (2) record whether `hd` is the Workspace primary domain or the address's domain for a secondary-domain and an alias-domain user; (3) a consumer Google account on a company address has no `hd` and is refused; (4) a Cloud Identity Free user signs in like a Workspace user; (5) `hd=*` narrows the account chooser and is never echoed into a trusted claim; (6) the token endpoint accepts PKCE S256 with the client secret, and real tokens carry `azp` equal to the client id; (7) the binding cookie survives Google's redirect on the shared host (and fails closed on a custom portal domain); (8) the consent screen in production status with `openid email profile` shows no "unverified app" interstitial (record what brand verification was needed); (9) Workspace App access control steps allow and block sign-in as documented; (10) approval mode: request appears with its domain → approve → sign-in works, and instant mode creates the account; (11) a Google session dies after a 1 h cap and on removing the domain's verification, and the user re-authenticates through Google; (12) an existing password user at the same address gets `account_exists`, links Google from the profile, then signs in with Google.
- [ ] **macOS Local Network prompt** (#11311). On a Mac enrolled to a LAN-hosted server, confirm macOS shows "Allow breeze-agent to find devices on local networks?" and that Breeze Assist connecting triggers it. On a Mac enrolled to an internet-hosted server, confirm no prompt appears.


## Self-Hosting / Upgrade Notes (fold into the release body)

- **Portal Sign in with Google (new, optional, off by default)** (#11384). Three new env vars: `PORTAL_GOOGLE_CLIENT_ID`, `PORTAL_GOOGLE_CLIENT_SECRET` and `PORTAL_GOOGLE_CALLBACK_BASE_URL` (optional; falls back to `PUBLIC_URL`, `PUBLIC_APP_URL`, `PUBLIC_API_URL`). With them unset nothing changes: no Google row, button or copy appears and every Google route answers 404. Leave them unset until Google sign-in is announced as supported. Once the client is set, boot also needs a valid callback base (`PORTAL_GOOGLE_CALLBACK_BASE_URL` or one of the fallbacks). The only redirect URI to register is `https://<your-breeze-domain>/api/v1/portal/auth/oidc/google/callback`. The client id must be lower-case and end in `.apps.googleusercontent.com`; a malformed value fails boot.
- **Behaviour change: conflicting portal access requests** (#11384). A Microsoft (or Google) portal sign-in in approval mode at an address that already has a pending request for a different identity (another account, another provider, or a pending self-registration) is now refused instead of silently keeping the first request. The portal tells the person a request for their address is already waiting (`/login?sso=request_pending`) instead of the generic failure. The MSP denies the pending request, then the person signs in again.


## Features / API


## Migrations

- `2027-01-24-170000-portal-access-requests-google-hosted-domain.sql`: adds nullable `portal_access_requests.google_hosted_domain` and the CHECK `portal_access_requests_google_hd_chk` (validated in the same file when no Google request lacks a domain, which is every existing database). DDL only; fast.
