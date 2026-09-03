-- #3525 W02 — cancellation enum values.
--
-- Split from the column migration because Postgres forbids USING a new enum
-- literal in the transaction that ADDs it, and autoMigrate wraps each file in
-- one transaction (db/autoMigrate.ts). The 'cancelling' literal is used in
-- 2026-10-07-100100's partial-index predicate.
--
-- 'cancelling' is TRANSIENT. Only a proven stop terminalises as 'cancelled';
-- an unconfirmed or failed cancel reverts status to cancel_prev_status and
-- records the failure in cancel_state (plan OD8-C state table). Keeping the
-- reverted row inside the pending|queued|running predicate is what lets
-- reapStaleScriptExecutions keep ownership of the deadline unchanged.
--
-- Positioned AFTER 'running' so the declared Drizzle order and the installed
-- type order agree — drizzle-kit compares value ORDER, so appending here and
-- inserting in TypeScript would make `pnpm db:check-drift` report phantom drift.

ALTER TYPE execution_status ADD VALUE IF NOT EXISTS 'cancelling' AFTER 'running';

-- requested  — cancel accepted, command queued, outcome not yet known
-- confirmed  — the stop was PROVEN (server retraction, or the device said so)
-- unconfirmed— we could not prove it stopped (expired, not_found, lost race)
-- failed     — the device tried and could not kill the process
-- NULL       — no cancel was ever requested (no backfill needed on a hot table)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'script_cancel_state') THEN
    CREATE TYPE script_cancel_state AS ENUM ('requested', 'confirmed', 'unconfirmed', 'failed');
  END IF;
END $$;
