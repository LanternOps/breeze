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

- **Wisp migrations (hosted-only feature; nothing changes with the flag unset).** This release carries the Wisp schema: `2027-01-04-100000-partner-entitlements.sql` (partner entitlements), `2027-01-04-100100-wisp-grants.sql`, `2027-01-04-100110-ai-workspace-execute-permission.sql`, `2027-01-04-110100-ai-memory-blocks.sql`, `2027-01-04-110200-wisp-threads.sql`, `2027-01-04-110300-wisp-concerns-watches.sql`, `2027-01-04-110350-ai-agent-runs-assessment-profile.sql`, `2027-01-04-110400-wisp-nudge-preferences.sql`, and (arriving with the specialist wave) `2027-01-04-120600-wisp-specialist-lineage.sql`. They run on boot like any other migration. Wisp itself is hosted-only: with `BREEZE_WISP_ENABLED` unset (the default) no Wisp route, job or UI is active, and a production API refuses the flag without `IS_HOSTED=true`. Self-hosters do not need to set anything. `BREEZE_WORKSPACE_ENABLED` (Wisp's file/email knowledge connector, needs pgvector) is a separate, independent flag.

## Features / API

- **Wisp (hosted, paid plans): a continuous triage companion.** Wisp works for one person under a self-only, 90-day grant (partner-wide or one organization, step-up MFA to create), watches what that person may see, and nudges them about concerns with quiet hours, a proactivity dial, a morning brief and feedback on each nudge. It keeps confirmable memory (`/settings/wisp-memory`), meters spend against a per-grant daily budget (defaults 200 / 500 / 1000 cents for Pro / Enterprise / Unlimited, raisable to 5x), and can request specialists (`sweep`, `analysis`, `operator_recipe`, `patch_plan`, `remediation_research`, `bulk_ticket_reply`); `sweep` and `analysis` start on their own, the rest wait for a yes on an approval card. Anything that changes something goes through the existing approval tiers. Dark unless `BREEZE_WISP_ENABLED=true` on a hosted deployment (`IS_HOSTED=true`, `BREEZE_AI_AGENTS_ENABLED=true`) and the partner's `wisp` entitlement is on. New docs page: Features, Wisp.

- **PAM: agents report an elevation they cannot act on (#9517).** New agent route `POST /api/v1/agents/:id/pam/elevation-unable` (admission class `protected`). When the agent gives up on the PAM flow (requester session found but not active, helper did not start within the 30-second wait or lacks the PAM scope), it reports the request; uncertain cases (session unresolved, session check failed, session not in the snapshot before or during the helper wait, lease refused, a ready helper not found, no session broker or lifecycle manager yet) stay pending for the stale-request expiry; a still-pending request is closed as `expired` and the server then withdraws its mobile approvals (best-effort; a phone approval of a closed request is refused either way), and the PAM requests list shows that the device could not act under the Expired or All filter. New log lines: agent `pam: reported the elevation as unable to the server` / `pam: could not report the elevation as unable`; the API publishes `elevation.expired` with `cause: device_unable` (best-effort, like the stale-request expirer's: a failed publish is logged and the row stays the record). Older agents keep the previous behavior (the request stays pending until the stale-request expiry).

## Migrations

- `2027-01-02-180000-elevation-device-unable.sql`: three nullable columns on `elevation_requests` (`device_unable_at`, `device_unable_reason`, `device_unable_detail`) and the `device_unable` value on `elevation_audit_event_type`. The column adds are metadata-only, but the new CHECK `elevation_requests_device_unable_chk` is validated in the same statement, so Postgres scans `elevation_requests` once under the migration's lock (no rewrite). The table holds every elevation request (UAC prompts, technician JIT grants, governed AI tool actions), so the lock is held for one sequential scan of it. Scan time depends on the table's size on disk, its live row count (each row's CHECK is evaluated) and the storage's read speed. Measured on one idle host (PostgreSQL 16, local NVMe, a synthetic copy of the table at about 600 bytes a row): 1 million rows (600 MB) validated in 0.21 to 0.22 s over three warm runs; 10 million rows (6 GB) in 5.0 s with the OS and Postgres caches cleared and 2.1 s warm (one run each). Anything that reads or writes `elevation_requests` (new UAC requests, approvals, the requests list) waits that long. These are single-host measurements, not a guarantee: slower, shared or busy storage, lock waits and concurrent traffic can make it materially longer. Check `SELECT pg_size_pretty(pg_relation_size('elevation_requests'))` before upgrading and plan a quiet window when that size is large for your storage.
- `2027-01-04-120600-wisp-specialist-lineage.sql` (arrives with the Wisp specialist wave): three nullable/defaulted columns on `ai_agent_runs` and `ai_operator_tasks`; DDL only.
