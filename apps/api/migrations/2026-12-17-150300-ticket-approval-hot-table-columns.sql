-- @no-transaction
-- #4617 spec §4.2 / §4.4: the customer-work-approval columns on the three hot
-- ticketing tables.
--   tickets       budget_minutes, budget_amount, budget_currency_code + CHECK
--   time_entries  approval_request_id + composite FK to ticket_approval_requests
--   ticket_parts  CHECK forbidding the 'awaiting_approval' hold (parts are out
--                 of scope, spec §10; the enum is shared with time_entries)
--
-- Same lock discipline as 2026-12-17-100300-time-entries-contract-line.sql:
-- outside a transaction, each column is added catalog-only (nullable, no
-- default), each constraint is added NOT VALID (no scan) and then VALIDATEd as
-- its own statement under SHARE UPDATE EXCLUSIVE, so writes continue during the
-- scan. Every new column is entirely NULL, so validation passes trivially; the
-- ticket_parts CHECK passes because nothing has ever written the value (it was
-- added by 2026-12-17-150000 and has no writer yet).
-- lock_timeout bounds how long a statement may queue behind a long-running
-- transaction; on timeout autoMigrate aborts boot and the file re-runs cleanly.
-- It is RESET before the CONCURRENTLY build, which waits for older transactions
-- without blocking writers and must not be cut short.
--
-- Idempotent: re-applying re-swaps and re-validates the same definitions. A
-- failed CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS would
-- skip, so the final DO block raises rather than letting the file be recorded.
--
-- No row is written, so no system-scope election is needed.

SET lock_timeout = '5s';

-- §4.2 ticket budget: a document value, no default.
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS budget_minutes integer;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS budget_amount numeric(12,2);
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS budget_currency_code char(3);
ALTER TABLE public.tickets
  DROP CONSTRAINT IF EXISTS tickets_budget_chk,
  ADD CONSTRAINT tickets_budget_chk CHECK (
    (budget_minutes IS NULL OR budget_minutes > 0)
    AND (budget_amount IS NULL OR budget_amount > 0)
    AND ((budget_amount IS NULL) = (budget_currency_code IS NULL))
    AND (budget_currency_code IS NULL OR budget_currency_code ~ '^[A-Z]{3}$')) NOT VALID;
ALTER TABLE public.tickets VALIDATE CONSTRAINT tickets_budget_chk;

-- §4.4 time entry link. Keyed on (id, ticket_id), not org_id, so neither org
-- mover has to defer it: a ticket's id never changes when its org does.
-- ON DELETE SET NULL (approval_request_id): the PG15 column list nulls only
-- the link; a bare SET NULL would also null ticket_id. It must not be
-- RESTRICT: the org cascade deletes ticket_approval_requests before
-- time_entries ('tic' < 'tim').
ALTER TABLE public.time_entries ADD COLUMN IF NOT EXISTS approval_request_id uuid;
ALTER TABLE public.time_entries
  DROP CONSTRAINT IF EXISTS time_entries_approval_request_fk,
  ADD CONSTRAINT time_entries_approval_request_fk
    FOREIGN KEY (approval_request_id, ticket_id)
    REFERENCES public.ticket_approval_requests (id, ticket_id)
    ON DELETE SET NULL (approval_request_id) NOT VALID;
ALTER TABLE public.time_entries VALIDATE CONSTRAINT time_entries_approval_request_fk;

ALTER TABLE public.ticket_parts
  DROP CONSTRAINT IF EXISTS ticket_parts_billing_status_not_held_chk,
  ADD CONSTRAINT ticket_parts_billing_status_not_held_chk
    CHECK (billing_status <> 'awaiting_approval') NOT VALID;
ALTER TABLE public.ticket_parts VALIDATE CONSTRAINT ticket_parts_billing_status_not_held_chk;

RESET lock_timeout;

-- The FK's child side (a request delete must find its entries) and the
-- per-request held-entry read. Partial: nearly every entry has no request.
CREATE INDEX CONCURRENTLY IF NOT EXISTS time_entries_approval_request_idx
  ON public.time_entries (approval_request_id) WHERE approval_request_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'public.time_entries'::regclass
       AND c.relname = 'time_entries_approval_request_idx'
       AND NOT i.indisvalid
  ) THEN
    RAISE EXCEPTION 'time_entries_approval_request_idx build left an INVALID index — DROP INDEX CONCURRENTLY it and re-apply this migration';
  END IF;
END $$;
