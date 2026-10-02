-- AI chargeback W10 (#7608, spec §8): the monthly close of chargeable AI usage
-- into billable source rows.
--
--   ai_usage_charge_runs   one row per (org, UTC month) — the idempotency claim
--                          (contract_billing_periods precedent): a month closes
--                          exactly once per org.
--   ai_usage_charges       the billable source rows invoice assembly turns into
--                          lines; billing_status follows the time-entry
--                          lifecycle (not_billed → billed at issue, released at
--                          void). 'no_charge' (rounded to zero) and 'unpriced'
--                          (no client price) are never gathered.
--   ai_usage_charge_claims one row per claimed invocation (PK invocation_id):
--                          ai_invocations is append-only and cannot carry a
--                          "billed" mark, so double-claiming is made impossible
--                          here instead.
--
-- TENANCY: shape 1 (breeze_has_org_access(org_id)), like invoices/invoice_lines;
-- auto-discovered by rls-coverage. (org_id, partner_id) → organizations is
-- DEFERRABLE INITIALLY IMMEDIATE (org-merge contract) on runs and charges.
-- run_id is a snapshot id with NO FK: org merge leaves the loser's runs for
-- erasure (leave-for-erasure) while its charges/claims follow the client
-- (repoint), so a FK would block the loser's erasure.
-- Registrations: CORE_ORG_CASCADE_DELETE_ORDER (claims before charges — FK),
-- orgMergeRegistry (charges, claims: repoint; runs: leave-for-erasure),
-- CORE_TENANT_EXPORT_POLICY (all columns included; no json/bytea).
-- DDL only, idempotent.

CREATE TABLE IF NOT EXISTS public.ai_usage_charge_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  partner_id uuid NOT NULL REFERENCES public.partners(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  invocation_count integer NOT NULL DEFAULT 0,
  charge_count integer NOT NULL DEFAULT 0,
  unpriced_invocation_count integer NOT NULL DEFAULT 0,
  late_invocation_count integer NOT NULL DEFAULT 0,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_usage_charge_runs_month_chk CHECK (
    period_start = date_trunc('month', period_start)::date
    AND period_end = (period_start + interval '1 month')::date),
  CONSTRAINT ai_usage_charge_runs_counts_chk CHECK (
    invocation_count >= 0 AND charge_count >= 0 AND unpriced_invocation_count >= 0 AND late_invocation_count >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_charge_runs_org_period_uq
  ON public.ai_usage_charge_runs (org_id, period_start);

CREATE TABLE IF NOT EXISTS public.ai_usage_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  partner_id uuid NOT NULL REFERENCES public.partners(id),
  run_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  usage_period_start date NOT NULL,
  currency_code char(3) NOT NULL REFERENCES public.supported_currencies(code),
  served_model text NOT NULL,
  model_label text NOT NULL,
  priced boolean NOT NULL,
  invocation_count integer NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cache_read_tokens bigint NOT NULL DEFAULT 0,
  cache_write_tokens bigint NOT NULL DEFAULT 0,
  amount_exact numeric(20, 6),
  amount numeric(12, 2),
  billing_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_usage_charges_status_chk
    CHECK (billing_status IN ('not_billed', 'billed', 'no_charge', 'unpriced')),
  CONSTRAINT ai_usage_charges_priced_chk CHECK (
    priced = (amount_exact IS NOT NULL)
    AND (amount IS NULL) = (amount_exact IS NULL)
    AND (billing_status = 'unpriced') = (NOT priced)
    AND (amount IS NULL OR amount >= 0)),
  CONSTRAINT ai_usage_charges_period_chk CHECK (
    period_start = date_trunc('month', period_start)::date
    AND period_end = (period_start + interval '1 month')::date
    AND usage_period_start = date_trunc('month', usage_period_start)::date
    AND usage_period_start <= period_start),
  CONSTRAINT ai_usage_charges_counts_chk CHECK (
    invocation_count > 0 AND input_tokens >= 0 AND output_tokens >= 0
    AND cache_read_tokens >= 0 AND cache_write_tokens >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_charges_run_group_uq
  ON public.ai_usage_charges (run_id, usage_period_start, currency_code, served_model, priced);
-- Target of the claims' composite FK (Codex review finding 3).
CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_charges_id_org_uq ON public.ai_usage_charges (id, org_id);
CREATE INDEX IF NOT EXISTS ai_usage_charges_org_status_period_idx
  ON public.ai_usage_charges (org_id, billing_status, period_start);

CREATE TABLE IF NOT EXISTS public.ai_usage_charge_claims (
  -- Snapshot id, no FK: the claim must outlive ledger retention so a pruned
  -- invocation can never be re-claimed (aggregation only looks back 92 days).
  invocation_id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  run_id uuid NOT NULL,
  -- Composite FK below: a claim can only point at a charge of its OWN org.
  charge_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_usage_charge_claims_charge_idx ON public.ai_usage_charge_claims (charge_id);
CREATE INDEX IF NOT EXISTS ai_usage_charge_claims_org_idx ON public.ai_usage_charge_claims (org_id);

-- Org merge defers these while re-pointing parent and child org_id separately.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_usage_charge_runs_org_partner_fk') THEN
    ALTER TABLE public.ai_usage_charge_runs ADD CONSTRAINT ai_usage_charge_runs_org_partner_fk
      FOREIGN KEY (org_id, partner_id) REFERENCES public.organizations (id, partner_id) DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;
-- FK checks bypass RLS, so a single-column charge_id FK would let an org-A claim
-- reference an org-B charge (Codex review finding 3). DEFERRABLE: org merge
-- re-points charges and claims in separate statements.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_usage_charge_claims_charge_org_fk') THEN
    ALTER TABLE public.ai_usage_charge_claims ADD CONSTRAINT ai_usage_charge_claims_charge_org_fk
      FOREIGN KEY (charge_id, org_id) REFERENCES public.ai_usage_charges (id, org_id) DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_usage_charges_org_partner_fk') THEN
    ALTER TABLE public.ai_usage_charges ADD CONSTRAINT ai_usage_charges_org_partner_fk
      FOREIGN KEY (org_id, partner_id) REFERENCES public.organizations (id, partner_id) DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_usage_charge_runs', 'ai_usage_charges', 'ai_usage_charge_claims'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_select ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_update ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.%I', t);
    EXECUTE format('CREATE POLICY breeze_org_isolation_select ON public.%I FOR SELECT USING (public.breeze_has_org_access(org_id))', t);
    EXECUTE format('CREATE POLICY breeze_org_isolation_insert ON public.%I FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id))', t);
    EXECUTE format('CREATE POLICY breeze_org_isolation_update ON public.%I FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id))', t);
    EXECUTE format('CREATE POLICY breeze_org_isolation_delete ON public.%I FOR DELETE USING (public.breeze_has_org_access(org_id))', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_usage_charge_runs TO breeze_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_usage_charges TO breeze_app;
-- Claims are written once; only an org-merge re-point and erasure touch them.
-- ALTER DEFAULT PRIVILEGES (ensureAppRole.ts step 4) already granted table-level
-- UPDATE, so REVOKE it explicitly before the column grant (Codex review finding 6);
-- ensureAppRole.ts re-applies the same pair on every boot.
GRANT SELECT, INSERT, DELETE ON public.ai_usage_charge_claims TO breeze_app;
REVOKE UPDATE ON public.ai_usage_charge_claims FROM breeze_app;
GRANT UPDATE (org_id) ON public.ai_usage_charge_claims TO breeze_app;
