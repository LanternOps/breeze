# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.108.0** (2026-08-26). `v0.109.0-rc.*` tags exist as drafts.

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

## Breaking — self-hosters running a local LLM over loopback (#4324, merged)

Merged 2026-09-01 (PR #4324, closes #4121).

`MCP_LLM_PROVIDER=openai-compatible` now routes its egress through the guarded
`safeFetch` path (connect-time DNS pinning, private-network filtering, explicit
redirect refusal) instead of raw global `fetch`. The shared guard contract
permits RFC1918/ULA when the self-host private-network opt-in is set but
**never permits loopback**, and that contract is deliberately not broadened.

Consequence: a **bare-metal** install with
`MCP_LLM_BASE_URL=http://localhost:8000/v1` (or `http://127.0.0.1:8000/v1`) will
stop working. The refusal is explicit, not silent — the error names the fix.
Point `MCP_LLM_BASE_URL` at the model host's **container service name or LAN
(RFC1918/ULA) address** instead of `localhost`.

Containerized deployments are unaffected: a Compose service name resolves to a
private address and already passes. Note the default value of
`MCP_LLM_BASE_URL` is still `http://localhost:8000/v1`, so anyone relying on the
default on bare metal is affected.

## Fixed — recurring maintenance windows fire at the configured time (#4323, merged)

Merged 2026-08-31 (PR #4323, closes #4224).

Configuration-policy maintenance windows with `daily` / `weekly` / `monthly`
recurrence had **no start-time control in the UI**, and the evaluator hardcoded
every recurring window to **local midnight**. A policy configured as "daily, 2h,
Europe/Warsaw" was silently enforcing 00:00–02:00 Warsaw — a window the admin
never chose and the UI never displayed.

`config_policy_maintenance_settings.window_start` is now recurrence-discriminated
(`once` = ISO-8601 local datetime as before; `daily`/`weekly`/`monthly` = `HH:MM`,
anchored to every day / Sunday / the 1st respectively), and the evaluator resolves
the most recent occurrence at or before now.

**Operator-visible behaviour change.** There is **no migration** — the column is
already `varchar(30)` and **NULL keeps meaning midnight**, so every existing
policy keeps the schedule it has today. But any policy an admin now edits to set a
real start time will begin firing at that time rather than at midnight, which is
the point. Worth calling out so nobody reads a shifted window as a regression.
