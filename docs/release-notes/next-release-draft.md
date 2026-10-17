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

- **Connection-health digest (#9011)** — on the first deploy that includes it, every admin/owner with an open connection incident receives a digest email at 08:00 partner-local time. Expected one-time burst, not a fault.
- **AI device file read policy (#8866 W01 + #9010 W02)** — both waves ship together; W02 asserts the partner id in the resolver (W01 alone fails open).
- **AI tool output retention (#9044)** — the first nightly run after deploy scrubs AI tool outputs older than 30 days for partners with no AI data policy row; affected chats lose resumable model context. Partners who want to keep history must set retention to blank ("keep forever") *before* upgrading.
- **Connection-health W04 (#9045)** — new webhook and Google Workspace health sources seed silently, then begin real notices for stale syncs and dead webhooks. The Google probe makes one Directory API call per Google-connected org every 6 h, impersonating the org admin.

## Features / API

- **Breeze AI: System Restore ledger read (#8584).** The read-only `list_device_restore_point_attempts` chat tool (devices:read) lists a device's System Protection checkpoint attempts, newest first, with trigger and status filters. No new env vars or migrations.

## Migrations
