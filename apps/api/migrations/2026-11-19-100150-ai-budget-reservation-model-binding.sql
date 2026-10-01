-- AI model registry W03 (#7601, spec §9.2 / §8): the single billing path.
--
-- 1. model_binding: the turn claim binds offering, options, rate snapshot and
--    reservation ATOMICALLY. The reservation row is the durable turn claim, so
--    the TurnBinding lives on it; settlement rejects any ledger row whose rate
--    is not one bound here.
-- 2. pending_settlement: a settlement deferred by org-lock contention persists
--    its priced ledger rows here (reservation row lock only) and the sweep
--    replays them idempotently, exactly once.
-- 3. Exactly-once platform credit debit, keyed `ai-settlement:<reservation id>`:
--    credits_debit_due_at   stamped by a LEDGER settlement of platform spend
--                           (legacy-path settlements never set it, so the
--                           sweep never re-debits what the legacy recorders
--                           already deducted);
--    credits_debited_at     the billing service confirmed the keyed debit;
--    credits_debit_failed_at / credits_debit_error
--                           terminal: a 4xx (or retries exhausted). Short
--                           code only (e.g. 'http_409:idempotency_key_reused'),
--                           never a response body. Operator-visible, excluded
--                           from the sweep's retry query;
--    credits_debit_attempts retryable (5xx / transport) attempts so far.
-- 4. ai_sessions.sdk_usage_snapshot: the last cumulative Agent SDK modelUsage
--    seen for the breeze session (W05 spike). Billing bills per-model DELTAS
--    against it; it advances in the settlement transaction.
--
-- jsonb columns -> CORE_TENANT_EXPORT_POLICY excludedOpen. DDL only (no row
-- writes, so no scope election). Idempotent; no inner transaction.
ALTER TABLE ai_budget_reservations ADD COLUMN IF NOT EXISTS model_binding jsonb NULL;
ALTER TABLE ai_budget_reservations ADD COLUMN IF NOT EXISTS pending_settlement jsonb NULL;
ALTER TABLE ai_budget_reservations ADD COLUMN IF NOT EXISTS credits_debit_due_at timestamptz NULL;
ALTER TABLE ai_budget_reservations ADD COLUMN IF NOT EXISTS credits_debited_at timestamptz NULL;
ALTER TABLE ai_budget_reservations ADD COLUMN IF NOT EXISTS credits_debit_failed_at timestamptz NULL;
ALTER TABLE ai_budget_reservations ADD COLUMN IF NOT EXISTS credits_debit_error varchar(128) NULL;
ALTER TABLE ai_budget_reservations ADD COLUMN IF NOT EXISTS credits_debit_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE ai_budget_reservations DROP CONSTRAINT IF EXISTS ai_budget_reservations_credits_debit_attempts_chk;
ALTER TABLE ai_budget_reservations ADD CONSTRAINT ai_budget_reservations_credits_debit_attempts_chk
  CHECK (credits_debit_attempts >= 0);

CREATE INDEX IF NOT EXISTS ai_budget_reservations_pending_settlement_idx
  ON ai_budget_reservations (updated_at) WHERE pending_settlement IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_budget_reservations_credits_undebited_idx
  ON ai_budget_reservations (credits_debit_due_at)
  WHERE credits_debit_due_at IS NOT NULL AND credits_debited_at IS NULL AND credits_debit_failed_at IS NULL;
CREATE INDEX IF NOT EXISTS ai_budget_reservations_credits_debit_failed_idx
  ON ai_budget_reservations (credits_debit_failed_at) WHERE credits_debit_failed_at IS NOT NULL;

ALTER TABLE ai_sessions ADD COLUMN IF NOT EXISTS sdk_usage_snapshot jsonb NULL;
