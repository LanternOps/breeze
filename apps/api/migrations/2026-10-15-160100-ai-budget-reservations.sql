-- Durable pre-dispatch AI budget reservations.
-- Unknown outcomes remain indeterminate and continue consuming the reservation;
-- only a proven pre-dispatch failure may explicitly release it.
--
-- Reservations are BOUNDED IN TIME. A reservation holds the organization's
-- entire remaining cap, so an unreleased one is a denial of the tenant's own
-- budget: without a bound, a single provider timeout or a deploy that kills an
-- in-flight turn would zero the org's MONTHLY budget until the 1st, with no
-- admin path. `expires_at` gives admission a window to count within, and the
-- `aiBudgetReservationSweep` job transitions anything past it to `expired`.
-- Fail-closed stays fail-closed, but only for the length of the window.

DO $$ BEGIN
  CREATE TYPE ai_budget_reservation_status AS ENUM (
    'active', 'settled', 'indeterminate', 'released', 'expired'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- For a database that already applied an earlier revision of this (unreleased)
-- migration. `ADD VALUE` cannot run inside a function/DO block, so it is a
-- top-level statement; `IF NOT EXISTS` makes it a no-op on a fresh database
-- where the CREATE TYPE above already listed it. No statement in this file
-- USES the new label, which is what PostgreSQL forbids in the adding
-- transaction.
ALTER TYPE ai_budget_reservation_status ADD VALUE IF NOT EXISTS 'expired';

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
  -- The instant after which this reservation stops counting against the cap.
  -- Set on INSERT to now() + the active TTL and extended to the (much longer)
  -- indeterminate TTL when the provider outcome becomes unknown. The DEFAULT is
  -- deliberate belt-and-braces: a future INSERT that forgets the column gets a
  -- bounded reservation rather than an immortal one.
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  expired_at timestamptz,
  expiry_reason varchar(32),
  CONSTRAINT ai_budget_reservations_expiry_reason_check
    CHECK (expiry_reason IS NULL OR expiry_reason IN ('active_ttl', 'indeterminate_ttl')),
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
-- The sweep's only query shape: everything still holding capacity whose window
-- has closed. Partial so the index stays the size of the in-flight set rather
-- than the whole settlement history.
CREATE INDEX IF NOT EXISTS ai_budget_reservations_expiry_sweep_idx
  ON ai_budget_reservations (expires_at)
  WHERE status IN ('active', 'indeterminate');

-- Columns added after the first revision of this unreleased migration; no-ops
-- on a fresh database, which already got them from the CREATE TABLE above. The
-- NOT NULL DEFAULT form needs no backfill DML (PostgreSQL 11+ fast path), so
-- this file performs no UPDATE/DELETE and needs no `breeze.scope` set_config.
ALTER TABLE ai_budget_reservations
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes');
ALTER TABLE ai_budget_reservations
  ADD COLUMN IF NOT EXISTS expired_at timestamptz;
ALTER TABLE ai_budget_reservations
  ADD COLUMN IF NOT EXISTS expiry_reason varchar(32);
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_budget_reservations_expiry_reason_check'
      AND conrelid = 'ai_budget_reservations'::regclass
  ) THEN
    ALTER TABLE ai_budget_reservations
      ADD CONSTRAINT ai_budget_reservations_expiry_reason_check
      CHECK (expiry_reason IS NULL OR expiry_reason IN ('active_ttl', 'indeterminate_ttl'));
  END IF;
END $$;

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
