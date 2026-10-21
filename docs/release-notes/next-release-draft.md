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

- **PAM: agents report an elevation they cannot act on (#9517).** New agent route `POST /api/v1/agents/:id/pam/elevation-unable` (admission class `protected`). When the agent cannot find or start a SYSTEM helper in the requester's session, it reports the request; a still-pending request is closed as `expired` (its mobile approvals are withdrawn) and the PAM requests list shows that the device could not act. New log lines: agent `pam: reported the elevation as unable to the server` / `pam: could not report the elevation as unable`; the API publishes `elevation.expired` with `cause: device_unable`. Older agents keep the previous behavior (the request stays pending until the stale-request expiry).

## Migrations

- `2027-01-02-170000-elevation-device-unable.sql`: three nullable columns on `elevation_requests` (`device_unable_at`, `device_unable_reason`, `device_unable_detail`) with a CHECK, and the `device_unable` value on `elevation_audit_event_type`. Metadata-only; no rewrite.
