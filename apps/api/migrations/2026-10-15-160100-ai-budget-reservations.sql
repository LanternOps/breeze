-- Durable pre-dispatch AI budget reservations.
-- Unknown outcomes remain indeterminate and continue consuming the reservation;
-- only a proven pre-dispatch failure may explicitly release it.

DO $$ BEGIN
  CREATE TYPE ai_budget_reservation_status AS ENUM (
    'active', 'settled', 'indeterminate', 'released'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS ai_budget_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  idempotency_key varchar(200) NOT NULL,
  session_id uuid REFERENCES ai_sessions(id) ON DELETE SET NULL,
  billing_source text NOT NULL,
  daily_period_key varchar(10) NOT NULL,
  monthly_period_key varchar(7) NOT NULL,
  uncapped boolean NOT NULL DEFAULT false,
  reserved_cost_cents numeric(20,6) NOT NULL,
  actual_cost_cents numeric(20,6),
  status ai_budget_reservation_status NOT NULL DEFAULT 'active',
  settlement_fingerprint varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  indeterminate_at timestamptz,
  settled_at timestamptz,
  released_at timestamptz,
  CONSTRAINT ai_budget_reservations_billing_source_check
    CHECK (billing_source IN ('platform', 'partner_key')),
  CONSTRAINT ai_budget_reservations_reserved_nonnegative_check
    CHECK (reserved_cost_cents >= 0),
  CONSTRAINT ai_budget_reservations_actual_nonnegative_check
    CHECK (actual_cost_cents IS NULL OR actual_cost_cents >= 0),
  CONSTRAINT ai_budget_reservations_period_keys_check
    CHECK (
      daily_period_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      AND monthly_period_key ~ '^[0-9]{4}-[0-9]{2}$'
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_budget_reservations_org_idempotency_uidx
  ON ai_budget_reservations (org_id, idempotency_key);
CREATE INDEX IF NOT EXISTS ai_budget_reservations_active_period_idx
  ON ai_budget_reservations (org_id, daily_period_key, monthly_period_key, status);

ALTER TABLE ai_budget_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_budget_reservations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON ai_budget_reservations;
CREATE POLICY breeze_org_isolation_select ON ai_budget_reservations FOR SELECT
  USING (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ai_budget_reservations;
CREATE POLICY breeze_org_isolation_insert ON ai_budget_reservations FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_update ON ai_budget_reservations;
CREATE POLICY breeze_org_isolation_update ON ai_budget_reservations FOR UPDATE
  USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ai_budget_reservations;
CREATE POLICY breeze_org_isolation_delete ON ai_budget_reservations FOR DELETE
  USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON ai_budget_reservations TO breeze_app;
REVOKE TRUNCATE ON ai_budget_reservations FROM breeze_app;
