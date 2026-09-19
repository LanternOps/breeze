# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.114.0** (2026-09-17).

---

## Release to-do (pre-cut gates — see `/release` Step 0.2)

- [ ] (nothing yet)

## Self-Hosting / Upgrade Notes (fold into the release body)

- **Breaking — `POST /devices/:id/move-org` now requires a step-up grant (spec 2026-09-18, W01):** while two-factor authentication is enabled, the request must carry `stepUpGrant`, a single-use grant minted by `POST /auth/mfa/step-up` with `operation: "device_move_org"` and a `resource` of `{ deviceId, targetOrgId, targetSiteId, acceptCurrencyMismatch }`. Requests without it receive `403 { code: "STEP_UP_REQUIRED" }`. API keys and MCP tokens are refused outright (`403 Interactive user session required`) whether or not two-factor authentication is on. The console dialog that performs the ceremony ships in the following wave; until then only scripted callers are affected. Accounts with no enrolled factor cannot move devices — enrol an authenticator app or passkey first.
- **Site-restricted technicians (intentional, #5545 / #5777):** a technician limited to certain sites now loses a parent software deployment entirely, not just its out-of-ceiling child results, when any target device sits outside their site ceiling. That includes multi-site deployments they created themselves.
