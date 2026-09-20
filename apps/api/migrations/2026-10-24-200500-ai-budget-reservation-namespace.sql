-- #5557 (SEC-142 residual): give ai_budget_reservations a surface namespace so
-- the /client-ai (Office add-in) end-user surface can take an atomic
-- admit-before-dispatch hold on the SAME ledger instead of its own
-- read-then-spend check against client_ai_usage.
--
-- 'technician' is the default and every pre-existing row keeps it, so the
-- organization-wide cap arithmetic is unchanged. The namespace is read only
-- when the client sub-cap (client_ai_org_policies daily/monthly budget) is
-- evaluated: that sub-cap counts ONLY client-namespace holds, while the org cap
-- keeps summing holds across both namespaces because settled client spend
-- already lands in ai_cost_usage.
--
-- RLS is unchanged: the table keeps its shape-1 org_id policies from
-- 2026-10-15-160100-ai-budget-reservations.sql. Idempotent throughout.

ALTER TABLE ai_budget_reservations
  ADD COLUMN IF NOT EXISTS namespace text NOT NULL DEFAULT 'technician';

DO $$
BEGIN
  ALTER TABLE ai_budget_reservations
    ADD CONSTRAINT ai_budget_reservations_namespace_chk
    CHECK (namespace IN ('technician', 'client'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Matches the client sub-cap predicate in reserveAiBudget()
-- (org + namespace + period keys + status). The pre-existing
-- ai_budget_reservations_active_period_idx still serves the org-wide sum and
-- the expiry sweep index stays deliberately cross-namespace.
CREATE INDEX IF NOT EXISTS ai_budget_reservations_namespace_period_idx
  ON ai_budget_reservations (org_id, namespace, daily_period_key, monthly_period_key, status);
