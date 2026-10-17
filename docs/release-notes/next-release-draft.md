# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.123.0** (2026-10-17).

---

## Release to-do (pre-cut gates — see `/release` Step 0.2)

## Self-Hosting / Upgrade Notes (fold into the release body)

## Features / API

- **Breeze AI: System Restore ledger read (#8584).** The read-only `list_device_restore_point_attempts` chat tool (devices:read) lists a device's System Protection checkpoint attempts, newest first, with trigger and status filters. No new env vars or migrations.

## Migrations
