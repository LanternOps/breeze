# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.106.0** (2026-08-17).

---

## Ticketing — auto-suggested time entries (#3900)

- **Migration `2026-09-25-time-entry-source-and-suggestion-decisions.sql` takes brief
  blocking locks on `remote_sessions` AND `time_entries`.**
  - `remote_sessions`: it builds `remote_sessions_user_ended_idx` with a plain
    `CREATE INDEX` — `CONCURRENTLY` is impossible because the migration runner wraps every
    file in one transaction. On a self-hosted instance with millions of `remote_sessions`
    rows, expect writes to that table (session start/end) to block for the duration of the
    index build.
  - `time_entries`: `ADD COLUMN … DEFAULT 'manual'` is metadata-only on PostgreSQL 11+,
    but the validated `time_entries_source_chk` that follows holds ACCESS EXCLUSIVE and
    scans every row before it commits. Large `time_entries` tables block for that scan
    too (and a re-run repeats it — the constraint is dropped and re-added for
    idempotency). No data migration is required; existing rows take the column default.
  - Run the upgrade in a maintenance window if either table is large; check first with
    `SELECT count(*) FROM remote_sessions;` and `SELECT count(*) FROM time_entries;`.
- Adds `time_entries.source` (`varchar(24) NOT NULL DEFAULT 'manual'`, CHECK-constrained to
  `manual | timer | location | remote_session | support_session`). Existing rows backfill to
  `'manual'` via the column default; see the lock note above.
- Adds `time_suggestion_decisions` (partner-axis RLS). No configuration needed.
- **New (off by default): auto-suggested time entries — API and partner setting.**
  Partner admins can enable Settings → Ticketing → Time Tracking → "Suggest time entries
  from remote sessions". This release ships the backend and that setting; the
  technician-facing suggestion list, one-tap confirm and dismiss/restore controls are a
  **Breeze mobile app** screen and ship with the mobile client. There is no web
  suggestions panel — on web this release adds only the setting and a read-only `source`
  badge on timesheet rows and the ticket Time & Billing rail. Nothing is ever written
  without an explicit tap, and the feature is invisible while the setting is off.
- **New API:** `GET /api/v1/time-entries/suggestions`,
  `POST /api/v1/time-entries/suggestions/confirm`,
  `POST|DELETE /api/v1/time-entries/suggestions/dismiss` — partner scope,
  `time_entries:read` / `time_entries:write`.
- **New field:** time entries returned by the API now carry `source`
  (`manual | timer | location | remote_session | support_session`). It is server-stamped
  and read-only: the create/update schemas do not declare it, so a client that sends
  `source` has it stripped by validation and the server's own stamp always wins.
- No new environment variables. No action required for existing deployments beyond the
  migration note above.
