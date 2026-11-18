-- #9451 / #7717: durable, keyed platform credit debits that have no budget
-- reservation to ride on.
--
-- ai_credit_debits is an outbox: one row per debit the billing service owes us
-- an answer for. The row is written in the SAME transaction as the spend it
-- bills (the compute settlement claim on ai_agent_runs, or the unreserved
-- token ledger rows), so a crash after commit can never lose the debit; the
-- sweep (jobs/aiBudgetReservationSweep.ts) retries anything unconfirmed.
--
--   source / source_id   'compute' -> ai_agent_runs.id, 'invocation' -> the
--                        first ai_invocations.id of the settlement. No FK on
--                        purpose: ai_invocations is append-only and both tables
--                        sort before this one in the org cascade, so an FK would
--                        invert the delete order. The idempotency key carries
--                        the identity the billing service dedupes on.
--   idempotency_key      'ai-compute:<run id>:<attempt>' or
--                        'ai-invocation:<first ledger row id>'. Globally unique:
--                        the billing service dedupes on it, and a re-drive must
--                        re-send exactly this key with exactly cost_cents
--                        (a key reused with another amount is a 409).
--   debited_at           the billing service confirmed the keyed debit.
--   failed_at / error    terminal (4xx, or retries exhausted). Never retried by
--                        the sweep; listed for an operator, who re-drives it.
--   attempts             retryable (5xx / 408 / 429 / transport) attempts.
--
-- ai_agent_runs.compute_settled_at is the per-attempt compute settlement claim
-- (all billing sources): only the call that sets it writes compute_cents, the
-- ai_cost_usage rollups and the debit intent, so the run loop's finalize and
-- the terminal-transition reservation release can no longer both bill one
-- run. The enqueue_failed reclaim (a new attempt on the same row) clears it.

CREATE TABLE IF NOT EXISTS ai_credit_debits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source varchar(16) NOT NULL,
  source_id uuid NOT NULL,
  idempotency_key varchar(255) NOT NULL,
  cost_cents numeric(20,6) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  debited_at timestamptz,
  failed_at timestamptz,
  error varchar(128),
  attempts integer NOT NULL DEFAULT 0,
  CONSTRAINT ai_credit_debits_source_check CHECK (source IN ('compute', 'invocation')),
  CONSTRAINT ai_credit_debits_cost_positive_check CHECK (cost_cents > 0),
  CONSTRAINT ai_credit_debits_attempts_check CHECK (attempts >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_credit_debits_idempotency_key_uidx
  ON ai_credit_debits (idempotency_key);
CREATE INDEX IF NOT EXISTS ai_credit_debits_org_idx
  ON ai_credit_debits (org_id);
CREATE INDEX IF NOT EXISTS ai_credit_debits_undelivered_idx
  ON ai_credit_debits (created_at)
  WHERE debited_at IS NULL AND failed_at IS NULL;
CREATE INDEX IF NOT EXISTS ai_credit_debits_failed_idx
  ON ai_credit_debits (failed_at)
  WHERE failed_at IS NOT NULL AND debited_at IS NULL;

ALTER TABLE ai_credit_debits ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_credit_debits FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON ai_credit_debits;
CREATE POLICY breeze_org_isolation_select ON ai_credit_debits FOR SELECT
  USING (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ai_credit_debits;
CREATE POLICY breeze_org_isolation_insert ON ai_credit_debits FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_update ON ai_credit_debits;
CREATE POLICY breeze_org_isolation_update ON ai_credit_debits FOR UPDATE
  USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ai_credit_debits;
CREATE POLICY breeze_org_isolation_delete ON ai_credit_debits FOR DELETE
  USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON ai_credit_debits TO breeze_app;
REVOKE TRUNCATE ON ai_credit_debits FROM breeze_app;

ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS compute_settled_at timestamptz;
