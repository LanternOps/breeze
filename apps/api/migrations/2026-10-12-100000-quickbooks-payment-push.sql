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
-- Consecutive failed attempts at the row's `pending_op`. Reset to 0 when the
-- invoice fan-out re-owns a row for a fresh push. The unit is one ATTEMPT, and
-- BullMQ burns five of them per enqueue before failing a retryable job, so five
-- attempts is roughly one 15-minute sweep. A `push` row that reaches
-- PAYMENT_PUSH_MAX_ATTEMPTS (100 in accountingPaymentPush.ts, ~20 sweeps, ~5 h)
-- gives up: `pending_op` is cleared and `last_error` says so, which is what
-- stops the sweep re-enqueueing a doomed create forever. A `delete` row is never
-- capped — Breeze owns the removal of a Payment it created — so this is instead
-- what throttles that row's Sentry reporting to about once a day.
ALTER TABLE accounting_entity_mappings
  ADD COLUMN IF NOT EXISTS sync_attempts integer NOT NULL DEFAULT 0;

-- How many times this mapping has been re-owned for a FRESH QuickBooks create.
-- QuickBooks caches a create's response against its `requestid` for 24 hours
-- and REPLAYS it rather than creating again, which is exactly what makes a
-- retry safe — and exactly what breaks a legitimate re-create. When somebody
-- deletes a Breeze-created Payment by hand in QuickBooks, the pull clears
-- `remote_entity_id` and the invoice fan-out re-owns the row for a new create;
-- re-sending the same `requestid` would replay the ORIGINAL response, so the
-- worker would report success and stamp the mapping synced with the id of a
-- Payment that no longer exists (sandbox walk item 32 — silent data loss).
-- The generation is bumped by that re-own and appended to the requestid
-- (`<invoice_payments.id>:g<n>`), so it changes per ownership yet stays STABLE
-- across BullMQ retries of the same ownership — which is what keeps the retry
-- idempotency the requestid exists for. 0 means "never re-owned" and keeps the
-- bare payment id as the requestid, so every existing row is unaffected.
-- The PrivateNote adoption marker is deliberately NOT generation-tagged.
ALTER TABLE accounting_entity_mappings
  ADD COLUMN IF NOT EXISTS push_generation integer NOT NULL DEFAULT 0;

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

-- ---------------------------------------------------------------------------
-- Review wave 2, finding 6: WHEN the row started owing its `pending_op`.
--
-- The delete worker parks an unresolved delete (`pending_op = 'delete'` with no
-- `remote_entity_id`) for PAYMENT_DELETE_UNRESOLVED_GRACE_MS before dropping it
-- loudly, and that window has to be measured from when the DEBT began. It
-- cannot be `updated_at`: the lease CAS bumps that on every attempt, so an age
-- read there never expires. It cannot be `created_at` either — that is the age
-- of the MAPPING. A mapping the invoice fan-out re-owned, or one that has
-- simply been synced for a week, is already older than the window on the day
-- its payment is voided, so the row was dropped on its FIRST attempt instead of
-- getting the 24 hours the CDC pull needs to adopt the Payment.
--
-- Written by every writer of `pending_op` that starts a NEW debt
-- (insertPendingPushMapping, requestPaymentDelete, convertToDelete,
-- reownPushMapping) and left alone by the ones that merely keep an existing one
-- (the CDC adoption of a delete-pending row). NULL is tolerated and falls back
-- to `created_at` in the coordinator, which is exactly the pre-existing
-- behaviour for any row written before this column existed.
ALTER TABLE accounting_entity_mappings
  ADD COLUMN IF NOT EXISTS pending_since timestamptz;

-- Backfill only rows that currently owe something; everything else is NULL by
-- definition. `updated_at` overstates the age of a leased row, which is the
-- SAFE direction here (a longer park, never a premature drop).
DO $$
DECLARE
  stamped integer;
BEGIN
  UPDATE accounting_entity_mappings
     SET pending_since = updated_at
   WHERE pending_op IS NOT NULL
     AND pending_since IS NULL;
  GET DIAGNOSTICS stamped = ROW_COUNT;
  IF stamped > 0 THEN
    RAISE WARNING 'stamped pending_since on % accounting mappings that already owed work', stamped;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Review wave 2, finding 2: the horizon that keeps this feature off HISTORY.
--
-- `push_payments` defaults to true, so at deploy every connected realm starts
-- pushing. Without a horizon the invoice fan-out would create a QuickBooks
-- Payment for EVERY unmapped `invoice_payments` row of any invoice that is
-- re-pushed — including receipts the partner's bookkeeper had already entered
-- in QuickBooks by hand for years, which arrive as duplicate cash against the
-- same invoice. Nothing about the mapping tables can tell those apart: they have
-- no mapping precisely because they predate the feature.
--
-- So Breeze only pushes payments RECORDED AFTER the switch became active.
-- Existing connections are stamped `now()` at migration time; new ones are
-- stamped at insert; and the settings route re-stamps it whenever the operator
-- flips `push_payments` off and back on, so a deliberate pause does not later
-- flush a backlog nobody expected.
ALTER TABLE accounting_connections
  ADD COLUMN IF NOT EXISTS push_payments_since timestamptz;

DO $$
DECLARE
  stamped integer;
BEGIN
  UPDATE accounting_connections
     SET push_payments_since = now()
   WHERE push_payments_since IS NULL;
  GET DIAGNOSTICS stamped = ROW_COUNT;
  IF stamped > 0 THEN
    RAISE WARNING 'stamped push_payments_since=now() on % accounting connections (payments recorded before this are never pushed)', stamped;
  END IF;
END $$;
