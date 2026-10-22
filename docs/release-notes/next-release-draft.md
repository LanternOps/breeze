# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.124.0** (2026-10-19).

---

## Release to-do (pre-cut gates — see `/release` Step 0.2)

_(empty — add the next tag's one-off gates here)_

## Self-Hosting / Upgrade Notes (fold into the release body)

## Features / API

- **PAM: agents report an elevation they cannot act on (#9517).** New agent route `POST /api/v1/agents/:id/pam/elevation-unable` (admission class `protected`). When the agent gives up on the PAM flow (requester session found but not active, helper did not start within the 30-second wait or lacks the PAM scope), it reports the request; uncertain cases (session unresolved, session check failed, session not in the snapshot before or during the helper wait, lease refused, a ready helper not found, no session broker or lifecycle manager yet) stay pending for the stale-request expiry; a still-pending request is closed as `expired` and the server then withdraws its mobile approvals (best-effort; a phone approval of a closed request is refused either way), and the PAM requests list shows that the device could not act under the Expired or All filter. New log lines: agent `pam: reported the elevation as unable to the server` / `pam: could not report the elevation as unable`; the API publishes `elevation.expired` with `cause: device_unable` (best-effort, like the stale-request expirer's: a failed publish is logged and the row stays the record). Older agents keep the previous behavior (the request stays pending until the stale-request expiry).

## Migrations

- `2027-01-02-180000-elevation-device-unable.sql`: three nullable columns on `elevation_requests` (`device_unable_at`, `device_unable_reason`, `device_unable_detail`) and the `device_unable` value on `elevation_audit_event_type`. The column adds are metadata-only, but the new CHECK `elevation_requests_device_unable_chk` is validated in the same statement, so Postgres scans `elevation_requests` once under the migration's lock (no rewrite). The table holds every elevation request (UAC prompts, technician JIT grants, governed AI tool actions), so the lock is held for one sequential scan of it. Scan time follows the table's heap size on disk and the storage's read speed, not its row count. Measured on one idle host (PostgreSQL 16, local NVMe, a synthetic copy of the table at about 600 bytes a row): 1 million rows (600 MB) validated in 0.21 to 0.22 s over three warm runs; 10 million rows (6 GB) in 5.0 s with the OS and Postgres caches cleared and 2.1 s warm (one run each). Anything that reads or writes `elevation_requests` (new UAC requests, approvals, the requests list) waits that long. These are single-host measurements, not a guarantee: slower, shared or busy storage, lock waits and concurrent traffic can make it materially longer. Check `SELECT pg_size_pretty(pg_relation_size('elevation_requests'))` before upgrading and plan a quiet window when that size is large for your storage.
