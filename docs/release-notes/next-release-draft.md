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
- **Disk Cleanup v2 — cleanup now actually frees space, and scans any fixed volume.** Cleanup deletes permanently instead of moving files into the agent's own trash directory on the same volume, so reclaimed bytes are real; on Windows the per-volume `$Recycle.Bin` is reached one level down (the volume root itself stays undeletable). Scanning and cleanup are now per volume: scan state, snapshots and cleanup runs are keyed by `(device, scan path)`, so scanning `D:\` no longer resets the `C:\` baseline or becomes the snapshot a `C:\` cleanup deletes from. Executing a cleanup requires the `cleanupRunId` returned by its preview — anything outside that pinned plan is reported as rejected and never deleted. New OS-native cleaners (Windows Disk Cleanup handlers and DISM component cleanup, macOS local snapshots and Homebrew, Linux package caches and journal) are available from the same tab and from the new `system_cleanup` AI tool; they need an agent at **v0.115.0** or newer and return `409 agent_update_required` below that. The AI tool surface is `analyze_disk_usage` (Tier 1, now takes a `path`), `disk_cleanup` (Tier 1 preview / Tier 3 execute, now takes a `path` and requires `cleanupRunId`) and `system_cleanup` (Tier 1 list and status / Tier 3 run; `run` returns a `cleanupRunId` immediately and `status` polls it, so the tool never holds a request open for the length of a run; 30 calls per hour across the three actions, with one native run per device at a time). Over MCP the Tier 3 actions are refused — read-only diagnosis works, the destructive step goes to a technician in the web app.
- **Rolling deploys: one brief window where a filesystem scan cannot save its scan state.** The Disk Cleanup v2 migration changes `device_filesystem_scan_state`'s primary key from `(device_id)` to `(device_id, scan_path)`. Hosted Breeze replaces the single API container, so old and new API code never run against the new schema at once. On a **multi-replica self-host**, any old replica still draining after the migration applies will fail its scan-state upsert with `42P10` (the snapshot insert itself still succeeds); re-running the scan once every replica is on the new build repairs the state. Single-replica self-hosts are unaffected.
