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

- **Migration `2026-09-25-time-entry-source-and-suggestion-decisions.sql` takes a brief
  blocking lock on `remote_sessions`.** It builds `remote_sessions_user_ended_idx` with a
  plain `CREATE INDEX` — `CONCURRENTLY` is impossible because the migration runner wraps
  every file in one transaction. On a self-hosted instance with millions of
  `remote_sessions` rows, expect writes to that table (session start/end) to block for the
  duration of the index build. Run the upgrade in a maintenance window if your
  `remote_sessions` table is large; check first with `SELECT count(*) FROM remote_sessions;`.
- Adds `time_entries.source` (`varchar(24) NOT NULL DEFAULT 'manual'`, CHECK-constrained to
  `manual | timer | location | remote_session | support_session`). Existing rows backfill to
  `'manual'` via the column default; no data migration is required.
- Adds `time_suggestion_decisions` (partner-axis RLS). No configuration needed.

