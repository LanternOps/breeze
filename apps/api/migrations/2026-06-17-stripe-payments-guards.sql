-- Stripe Payments integrity guards (follow-up to #1422).
-- Promotes two state-machine invariants the reconcile code already upholds from
-- "every writer must remember" to DB-enforced CHECK constraints, so a future
-- writer that violates them fails loudly instead of leaving inconsistent rows.
-- Both tables are empty in production (the feature is dormant until STRIPE_* is
-- set), so ADD CONSTRAINT validates against zero rows. Idempotent.

-- A mapping marked 'succeeded' must link a recorded invoice_payments row.
-- (pending/failed/refunded/partially_refunded legitimately may not — a terminal
--  failure or a fully-refunded row carries invoice_payment_id IS NULL.)
DO $$ BEGIN
  ALTER TABLE invoice_stripe_payments
    ADD CONSTRAINT invoice_stripe_payments_succeeded_has_payment
    CHECK (status <> 'succeeded' OR invoice_payment_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A connected account's disconnected_at is set if and only if status='disconnected'
-- (keeps the two columns, which together encode one fact, from drifting).
DO $$ BEGIN
  ALTER TABLE stripe_connect_accounts
    ADD CONSTRAINT stripe_connect_accounts_disconnect_coupling
    CHECK ((status = 'disconnected') = (disconnected_at IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
