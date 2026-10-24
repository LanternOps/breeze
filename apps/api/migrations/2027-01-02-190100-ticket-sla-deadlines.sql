-- @no-transaction
-- #8973 W3 (spec §4.3, §4.6, §8.2): stored SLA deadline columns on tickets.
--   sla_paused_business_minutes  business minutes spent paused, accrued when a
--                                pause ends (equals sla_paused_minutes while
--                                no calendar applies; the SLA sweep's heal
--                                pass raises it to sla_paused_minutes if a
--                                pre-W3 API instance folded a pause)
--   response_due_at / resolution_due_at    deadline per target; NULL when the
--                                          target is NULL
--   response_warn_at / resolution_warn_at  the 80% "breaching soon" point
--
-- `timestamp` without time zone, matching created_at / first_response_at /
-- sla_paused_at, so comparisons and the backfill never depend on the session
-- time zone.
--
-- DDL only. The backfill is the next file
-- (2027-01-02-190200-ticket-sla-deadlines-backfill.sql) and the sweep indexes
-- the one after it (2027-01-02-190300-ticket-sla-due-indexes.sql), so the
-- ACCESS EXCLUSIVE lock here is held only for catalog updates.
--
-- Same lock discipline as 2026-12-20-200300-ticket-approval-hot-table-columns.sql:
-- outside a transaction, every column is catalog-only (nullable with no
-- default, or NOT NULL with a constant default, which PG 11+ stores in the
-- catalog without a rewrite). lock_timeout bounds how long a statement may
-- queue behind a long-running transaction; on timeout autoMigrate aborts boot
-- and the file re-runs cleanly.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. No row is written, so no system-scope
-- election is needed.

SET lock_timeout = '5s';

ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS sla_paused_business_minutes integer NOT NULL DEFAULT 0;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS response_due_at timestamp;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS resolution_due_at timestamp;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS response_warn_at timestamp;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS resolution_warn_at timestamp;

RESET lock_timeout;
