-- Phase D2 (payment push) — Task 1.
--
-- accounting_connections gains the Breeze -> QuickBooks payment push switch.
-- accounting_entity_mappings becomes its own outbox: `pending_op` records the
-- operation the row still owes QuickBooks, `claimed_at` is the worker's lease,
-- `sync_attempts` bounds how long a doomed push keeps asking, and
-- `breeze_origin` tells the CDC pull that Breeze — not QuickBooks — is the
-- system of record for this payment (a CDC DELETION carries no PrivateNote, so
-- origin has to be known locally).
--
-- No RLS changes: both tables are partner-axis and already ENABLE + FORCE with
-- partner policies (2026-09-28-quickbooks-entity-mappings.sql:150-168). No
-- org_id anywhere, so no tenantCascade / export-policy / orgMerge registration.
--
-- The entity-partner guard trigger fires only on INSERT and
-- UPDATE OF partner_id, breeze_entity_type, breeze_entity_id, so a row whose
-- invoice_payments target has already been deleted can legally carry
-- pending_op = 'delete' until QuickBooks confirms the removal.

ALTER TABLE accounting_connections
  ADD COLUMN IF NOT EXISTS push_payments boolean NOT NULL DEFAULT true;

ALTER TABLE accounting_entity_mappings
  ADD COLUMN IF NOT EXISTS breeze_origin boolean NOT NULL DEFAULT false;
ALTER TABLE accounting_entity_mappings
  ADD COLUMN IF NOT EXISTS pending_op text;
ALTER TABLE accounting_entity_mappings
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
-- Consecutive failed/skipped attempts at the row's `pending_op`. Reset to 0
-- when the invoice fan-out re-owns a row for a fresh push. A `push` row that
-- reaches PAYMENT_PUSH_MAX_ATTEMPTS (accountingPaymentPush.ts) gives up:
-- `pending_op` is cleared and `last_error` says so, which is what stops the
-- 15-minute sweep re-enqueueing a doomed create forever. A `delete` row is
-- never capped — Breeze owns the removal of a Payment it created — so this is
-- also what throttles that row's Sentry reporting to once a day.
ALTER TABLE accounting_entity_mappings
  ADD COLUMN IF NOT EXISTS sync_attempts integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'accounting_entity_mappings_pending_op_chk'
      AND conrelid = 'accounting_entity_mappings'::regclass
  ) THEN
    ALTER TABLE accounting_entity_mappings
      ADD CONSTRAINT accounting_entity_mappings_pending_op_chk
      CHECK (pending_op IS NULL OR pending_op IN ('push', 'delete'));
  END IF;
END $$;

-- The sweep's only predicate: "which rows still owe QuickBooks something".
-- Partial, so it stays tiny — the steady state is zero pending rows.
CREATE INDEX IF NOT EXISTS accounting_entity_mappings_pending_op_idx
  ON accounting_entity_mappings (partner_id, pending_op)
  WHERE pending_op IS NOT NULL;

-- Backfill: every invoice mapping that exists today was created by Breeze's own
-- push (accountingInvoicePush.ts is the only writer of breeze_entity_type =
-- 'invoice'), so those rows are Breeze-origin. Payment rows that exist today
-- came from the Phase D pull and stay false.
--
-- `breeze.scope = 'system'` is REQUIRED: accounting_entity_mappings is
-- ENABLE + FORCE ROW LEVEL SECURITY, and on managed Postgres the migration role
-- is not a superuser, so an unscoped UPDATE silently matches zero rows while CI
-- (superuser) reports success. Same pattern as
-- 2026-09-30-100000-rls-scoped-backfill-replay.sql. `is_local = true` scopes it
-- to autoMigrate's per-file transaction.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  marked integer;
BEGIN
  UPDATE accounting_entity_mappings
     SET breeze_origin = true
   WHERE breeze_entity_type = 'invoice'
     AND breeze_origin = false;
  GET DIAGNOSTICS marked = ROW_COUNT;
  RAISE WARNING 'marked % invoice accounting mappings as Breeze-origin', marked;
END $$;
