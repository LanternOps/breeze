-- #3525 W05 (#4766) — automation run cancellation.
--
-- Slot note: the plan named this 2026-10-07-100200. That name sorts BEFORE
-- migrations already shipped on main, so it would replay ahead of them on a
-- fresh database. Renamed twice to sort last (origin/main gained
-- 2026-10-11-000300 while this branch was open, which the pre-push guard
-- caught); see apps/api/migrations/README.md.
--
-- This file writes no rows: it adds two enum values and one integer column with
-- a DEFAULT, so there is no UPDATE/DELETE/INSERT and no detection read against
-- an RLS-forced table. `breeze.scope` is elected anyway, so that a future edit
-- that DOES write cannot silently match zero rows under FORCE ROW LEVEL
-- SECURITY (CLAUDE.md §Schema Migration Workflow).
SELECT set_config('breeze.scope', 'system', true);

-- Both values are APPENDED (no AFTER clause) because the Drizzle pgEnum
-- declarations append them too, and drizzle-kit compares value ORDER — adding
-- here and inserting in TypeScript would make `pnpm db:check-drift` report
-- phantom drift. Postgres permits ALTER TYPE ... ADD VALUE inside the
-- transaction autoMigrate wraps each file in; it only forbids USING the new
-- literal before that transaction commits, and nothing below uses one.
ALTER TYPE automation_run_status ADD VALUE IF NOT EXISTS 'cancelled';
ALTER TYPE automation_device_result_status ADD VALUE IF NOT EXISTS 'cancelled';

-- OD6-A: cancelled is neither a success nor a failure. Counting it as failed
-- would poison automation health reporting and any alerting keyed on
-- devices_failed; counting it as skipped would overload a value that means
-- "filtered out of the target set".
--
-- The counter records CONFIRMED stops only — it is incremented by the
-- reconciler as child rows terminalise, never by the cancel REQUEST. A run
-- with 20 devices asked to stop and 3 proven stopped reports 3.
--
-- automation_runs has NO org_id and is deliberately absent from
-- CORE_ORG_CASCADE_DELETE_ORDER and CORE_TENANT_EXPORT_POLICY (verified: no
-- "automation_runs" key in tenantExportPolicyRegistry.ts). An integer counter
-- keeps it that way; do not add an org column here.
ALTER TABLE automation_runs
  ADD COLUMN IF NOT EXISTS devices_cancelled integer NOT NULL DEFAULT 0;
