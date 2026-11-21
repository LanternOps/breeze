# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.130.0** (2026-11-21).

---

## Release to-do (pre-cut gates — see `/release` Step 0.2)

Lab checks owed before the next tag:

<!-- The v0.130.0 cut's unrun lab checks (macOS double-click, Assist localisation, sign-in screen capture, H.264 fallback, Windows self-uninstall, viewer clipboard, YARA cache, macOS Local Network prompt) were published as Known gaps in the v0.130.0 release body; re-add any that should gate v0.131.0. -->


- [ ] **Portal Sign in with Google** (#11384: W07a API and W07b web, portal and docs both ship dark; W07b's browser check stubbed Google up to the authorize redirect). Needs a real Google OAuth web client and real Workspace / Gmail accounts; gate before `PORTAL_GOOGLE_CLIENT_ID` is set in any region. Rows: (1) a Workspace token carries `hd` equal to the user's domain and `email_verified: true`, and a personal Gmail token (no `hd`) is refused; (2) record whether `hd` is the Workspace primary domain or the address's domain for a secondary-domain and an alias-domain user; (3) a consumer Google account on a company address has no `hd` and is refused; (4) a Cloud Identity Free user signs in like a Workspace user; (5) `hd=*` narrows the account chooser and is never echoed into a trusted claim; (6) the token endpoint accepts PKCE S256 with the client secret, and real tokens carry `azp` equal to the client id; (7) the binding cookie survives Google's redirect on the shared host (and fails closed on a custom portal domain); (8) the consent screen in production status with `openid email profile` shows no "unverified app" interstitial (record what brand verification was needed); (9) Workspace App access control steps allow and block sign-in as documented; (10) approval mode: request appears with its domain → approve → sign-in works, and instant mode creates the account; (11) a Google session dies after a 1 h cap and on removing the domain's verification, and the user re-authenticates through Google; (12) an existing password user at the same address gets `account_exists`, links Google from the profile, then signs in with Google.


## Self-Hosting / Upgrade Notes (fold into the release body)

- **v0.131.0: macOS agent assets without a signed minimum-OS value are refused at sync** (#12258, announced in the v0.130.0 body). Self-hosters who sign their own packages: the self-host signing template already includes it.


## Features / API


## Migrations

