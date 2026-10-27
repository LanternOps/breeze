-- Tool Catalog W06 (#5215 / #5221) PR A — the legacy automation → flow
-- conversion ledger, the automation-wide occurrence claims, and
-- automations.converted_to_flow_id.
-- Spec: docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md
-- §6.4 / §6.5 / §7 (W6 amendments).
-- Plan: docs/superpowers/plans/ai-mcp/2026-10-27-tool-catalog-w6-legacy-automations.md
-- Task A2 (Open Decisions 3, 6, 7, 8).
--
-- Tenancy shape (docs/agents/tenancy-rls.md): both tables copy the shape of the
-- `automations` / `flows` they bind — org_id XOR partner_id with a one-owner
-- CHECK, ONE dual-axis FOR ALL policy, and a SEPARATE additive FOR SELECT
-- partner-wide branch keyed on breeze_current_partner_id() (an org-scoped
-- session reads its partner's partner-wide rows; its UPDATE/DELETE match 0
-- rows). Policies verbatim from 2027-01-02-130000-flows.sql, renamed.
--
-- Owner guards: a SECURITY DEFINER (pinned search_path) CONSTRAINT trigger,
-- AFTER INSERT OR UPDATE of the owner/link columns, DEFERRABLE INITIALLY
-- IMMEDIATE. A conversion's owner pair equals its automation's AND its flow's;
-- a claim's equals its automation's. It is a constraint trigger (not BEFORE
-- INSERT only) so it also holds across an org merge: the merge runs under SET
-- CONSTRAINTS ALL DEFERRED and repoints automations, flows and these rows in
-- separate statements; the guard checks the moved set at COMMIT. An
-- unreadable automation or flow is NOT FOUND and refused (fail closed).
--
-- Immutability (BEFORE UPDATE): the only owner change either table admits is
-- an org_id → org_id restamp with partner_id unchanged (the org-merge repoint;
-- the precedent is the business-calendar revision triggers, Gate B15).
-- Conversions: automation, flow, source digest/snapshot, converter and
-- created_at are fixed; switch_at/switched_at and revert_at are write-once;
-- the only state transitions are shadow → switched → reverted. Claims are
-- append-only: every other column is fixed, breeze_app has table UPDATE and
-- TRUNCATE revoked with only UPDATE (org_id) re-granted (ensureAppRole.ts
-- re-applies this on boot, #4371).
--
-- Every org_id FK is DEFERRABLE INITIALLY IMMEDIATE (org merge defers
-- constraints). No composite FK references an org_id column.
--
-- CHECK swaps: flow_runs_error_code_chk and flow_run_steps_error_code_chk
-- (last defined in 2027-01-07-140000-flow-webhooks-tools-budgets.sql, never
-- edited) gain the four W6 fleet built-in codes.
--
-- Registrations (made in code, Task A3): CORE_ORG_CASCADE_DELETE_ORDER,
-- CORE_TENANT_EXPORT_POLICY (every column; jsonb columns excludedOpen;
-- automations.converted_to_flow_id), orgMergeRegistry.ts REPOINT_TABLES,
-- rls-coverage DUAL_AXIS_TENANT_TABLES + XOR_OWNERSHIP_DUAL_AXIS_TABLES.
--
-- Idempotent (IF NOT EXISTS / DO $$ guards / DROP … IF EXISTS + ADD); no inner
-- BEGIN/COMMIT. DDL only — no row is written, so no system-scope election.
--
-- Rollback: a new migration dropping both tables, the column and its CHECK,
-- and restoring the W5 CHECK lists. Nothing writes these tables until PR B.

-- ============================================
-- 1. flow_automation_conversions — one append-only generation per conversion
-- ============================================
CREATE TABLE IF NOT EXISTS flow_automation_conversions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid,
  partner_id uuid,
  automation_id uuid NOT NULL,
  flow_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'shadow',
  fidelity text NOT NULL,
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_digest text NOT NULL,
  -- trigger (without the webhook secret), conditions, actions, on_failure,
  -- notification_targets of the automation at conversion time.
  source_snapshot jsonb NOT NULL,
  document_digest text NOT NULL,
  shadow_runs integer NOT NULL DEFAULT 0,
  shadow_divergences integer NOT NULL DEFAULT 0,
  shadow_started_at timestamptz NOT NULL DEFAULT now(),
  shadow_last_at timestamptz,
  shadow_last_divergence jsonb,
  -- now() + SWITCH_LEAD_MS, written in the transaction that enables the flow.
  switch_at timestamptz,
  -- transaction time of the switch.
  switched_at timestamptz,
  revert_at timestamptz,
  converted_by uuid,
  switched_by uuid,
  reverted_by uuid,
  divergence_acknowledged boolean NOT NULL DEFAULT false,
  scope_widening_accepted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_automation_conversions_org_fk' AND conrelid = 'flow_automation_conversions'::regclass) THEN
    ALTER TABLE flow_automation_conversions ADD CONSTRAINT flow_automation_conversions_org_fk
      FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_automation_conversions_partner_fk' AND conrelid = 'flow_automation_conversions'::regclass) THEN
    ALTER TABLE flow_automation_conversions ADD CONSTRAINT flow_automation_conversions_partner_fk
      FOREIGN KEY (partner_id) REFERENCES partners (id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_automation_conversions_automation_fk' AND conrelid = 'flow_automation_conversions'::regclass) THEN
    ALTER TABLE flow_automation_conversions ADD CONSTRAINT flow_automation_conversions_automation_fk
      FOREIGN KEY (automation_id) REFERENCES automations (id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_automation_conversions_flow_fk' AND conrelid = 'flow_automation_conversions'::regclass) THEN
    ALTER TABLE flow_automation_conversions ADD CONSTRAINT flow_automation_conversions_flow_fk
      FOREIGN KEY (flow_id) REFERENCES flows (id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_automation_conversions_converted_by_fk' AND conrelid = 'flow_automation_conversions'::regclass) THEN
    ALTER TABLE flow_automation_conversions ADD CONSTRAINT flow_automation_conversions_converted_by_fk
      FOREIGN KEY (converted_by) REFERENCES users (id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_automation_conversions_switched_by_fk' AND conrelid = 'flow_automation_conversions'::regclass) THEN
    ALTER TABLE flow_automation_conversions ADD CONSTRAINT flow_automation_conversions_switched_by_fk
      FOREIGN KEY (switched_by) REFERENCES users (id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_automation_conversions_reverted_by_fk' AND conrelid = 'flow_automation_conversions'::regclass) THEN
    ALTER TABLE flow_automation_conversions ADD CONSTRAINT flow_automation_conversions_reverted_by_fk
      FOREIGN KEY (reverted_by) REFERENCES users (id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_automation_conversions_one_owner_chk' AND conrelid = 'flow_automation_conversions'::regclass) THEN
    ALTER TABLE flow_automation_conversions ADD CONSTRAINT flow_automation_conversions_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_automation_conversions_state_chk' AND conrelid = 'flow_automation_conversions'::regclass) THEN
    ALTER TABLE flow_automation_conversions ADD CONSTRAINT flow_automation_conversions_state_chk
      CHECK (state IN ('shadow', 'switched', 'reverted'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_automation_conversions_fidelity_chk' AND conrelid = 'flow_automation_conversions'::regclass) THEN
    ALTER TABLE flow_automation_conversions ADD CONSTRAINT flow_automation_conversions_fidelity_chk
      CHECK (fidelity IN ('exact', 'needs_review', 'unconvertible'));
  END IF;
  -- An unconvertible automation never gets a ledger row (preview only).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_automation_conversions_fidelity_row_chk' AND conrelid = 'flow_automation_conversions'::regclass) THEN
    ALTER TABLE flow_automation_conversions ADD CONSTRAINT flow_automation_conversions_fidelity_row_chk
      CHECK (fidelity <> 'unconvertible');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_automation_conversions_switch_chk' AND conrelid = 'flow_automation_conversions'::regclass) THEN
    ALTER TABLE flow_automation_conversions ADD CONSTRAINT flow_automation_conversions_switch_chk
      CHECK ((state = 'shadow') = (switch_at IS NULL) AND (switch_at IS NULL) = (switched_at IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_automation_conversions_revert_chk' AND conrelid = 'flow_automation_conversions'::regclass) THEN
    ALTER TABLE flow_automation_conversions ADD CONSTRAINT flow_automation_conversions_revert_chk
      CHECK ((state = 'reverted') = (revert_at IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_automation_conversions_counters_chk' AND conrelid = 'flow_automation_conversions'::regclass) THEN
    ALTER TABLE flow_automation_conversions ADD CONSTRAINT flow_automation_conversions_counters_chk
      CHECK (0 <= shadow_divergences AND shadow_divergences <= shadow_runs);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_automation_conversions_digests_chk' AND conrelid = 'flow_automation_conversions'::regclass) THEN
    ALTER TABLE flow_automation_conversions ADD CONSTRAINT flow_automation_conversions_digests_chk
      CHECK (source_digest ~ '^[0-9a-f]{64}$' AND document_digest ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_automation_conversions_json_chk' AND conrelid = 'flow_automation_conversions'::regclass) THEN
    ALTER TABLE flow_automation_conversions ADD CONSTRAINT flow_automation_conversions_json_chk
      CHECK (jsonb_typeof(findings) = 'array' AND jsonb_typeof(source_snapshot) = 'object'
        AND (shadow_last_divergence IS NULL OR jsonb_typeof(shadow_last_divergence) = 'object'));
  END IF;
END $$;

-- At most one live (shadow or switched) generation per automation; a reverted
-- generation is terminal and converting again creates a new generation.
CREATE UNIQUE INDEX IF NOT EXISTS flow_automation_conversions_live_uq
  ON flow_automation_conversions (automation_id) WHERE state <> 'reverted';
CREATE UNIQUE INDEX IF NOT EXISTS flow_automation_conversions_flow_uq
  ON flow_automation_conversions (flow_id);
CREATE INDEX IF NOT EXISTS flow_automation_conversions_automation_created_idx
  ON flow_automation_conversions (automation_id, created_at);
CREATE INDEX IF NOT EXISTS flow_automation_conversions_org_idx
  ON flow_automation_conversions (org_id) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS flow_automation_conversions_partner_idx
  ON flow_automation_conversions (partner_id) WHERE org_id IS NULL;

CREATE OR REPLACE FUNCTION public.flow_automation_conversions_owner_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  a_org uuid;
  a_partner uuid;
  f_org uuid;
  f_partner uuid;
BEGIN
  SELECT a.org_id, a.partner_id INTO a_org, a_partner
  FROM public.automations AS a
  WHERE a.id = NEW.automation_id;
  IF FOUND THEN
    SELECT f.org_id, f.partner_id INTO f_org, f_partner
    FROM public.flows AS f
    WHERE f.id = NEW.flow_id;
    IF FOUND
       AND NEW.org_id IS NOT DISTINCT FROM a_org AND NEW.partner_id IS NOT DISTINCT FROM a_partner
       AND NEW.org_id IS NOT DISTINCT FROM f_org AND NEW.partner_id IS NOT DISTINCT FROM f_partner THEN
      RETURN NULL;
    END IF;
  END IF;

  RAISE EXCEPTION 'flow automation conversion owner does not match its automation and flow'
    USING ERRCODE = '23514',
          CONSTRAINT = 'flow_automation_conversions_owner_chk';
END $$;

DROP TRIGGER IF EXISTS flow_automation_conversions_owner_guard_trg ON flow_automation_conversions;
CREATE CONSTRAINT TRIGGER flow_automation_conversions_owner_guard_trg
  AFTER INSERT OR UPDATE OF org_id, partner_id, automation_id, flow_id ON flow_automation_conversions
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.flow_automation_conversions_owner_guard();

CREATE OR REPLACE FUNCTION public.flow_automation_conversions_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.partner_id IS DISTINCT FROM OLD.partner_id
     OR (NEW.org_id IS DISTINCT FROM OLD.org_id AND (OLD.org_id IS NULL OR NEW.org_id IS NULL))
     OR NEW.automation_id IS DISTINCT FROM OLD.automation_id
     OR NEW.flow_id IS DISTINCT FROM OLD.flow_id
     OR NEW.source_digest IS DISTINCT FROM OLD.source_digest
     OR NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     -- actor columns: only the ON DELETE SET NULL of a deleted user may change them once set
     OR (NEW.converted_by IS DISTINCT FROM OLD.converted_by AND NEW.converted_by IS NOT NULL)
     OR (OLD.switched_by IS NOT NULL AND NEW.switched_by IS DISTINCT FROM OLD.switched_by AND NEW.switched_by IS NOT NULL)
     OR (OLD.reverted_by IS NOT NULL AND NEW.reverted_by IS DISTINCT FROM OLD.reverted_by AND NEW.reverted_by IS NOT NULL)
     OR (OLD.switch_at IS NOT NULL AND NEW.switch_at IS DISTINCT FROM OLD.switch_at)
     OR (OLD.switched_at IS NOT NULL AND NEW.switched_at IS DISTINCT FROM OLD.switched_at)
     OR (OLD.revert_at IS NOT NULL AND NEW.revert_at IS DISTINCT FROM OLD.revert_at) THEN
    RAISE EXCEPTION 'flow_automation_conversions: immutable column changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
     AND NOT ((OLD.state = 'shadow' AND NEW.state = 'switched') OR (OLD.state = 'switched' AND NEW.state = 'reverted')) THEN
    RAISE EXCEPTION 'flow_automation_conversions: % → % is not a conversion transition', OLD.state, NEW.state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS flow_automation_conversions_immutable_trg ON flow_automation_conversions;
CREATE TRIGGER flow_automation_conversions_immutable_trg
  BEFORE UPDATE ON flow_automation_conversions
  FOR EACH ROW EXECUTE FUNCTION public.flow_automation_conversions_immutable_guard();

ALTER TABLE flow_automation_conversions ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_automation_conversions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS flow_automation_conversions_isolation ON flow_automation_conversions;
CREATE POLICY flow_automation_conversions_isolation
  ON flow_automation_conversions
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

-- `=` and not IS NOT DISTINCT FROM: an unset GUC reads NULL and must never match.
DROP POLICY IF EXISTS flow_automation_conversions_partner_wide_select ON flow_automation_conversions;
CREATE POLICY flow_automation_conversions_partner_wide_select
  ON flow_automation_conversions
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON flow_automation_conversions TO breeze_app;

-- ============================================
-- 2. automation_occurrence_claims — who admitted each occurrence (append-only)
-- ============================================
CREATE TABLE IF NOT EXISTS automation_occurrence_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid,
  partner_id uuid,
  automation_id uuid NOT NULL,
  -- event:<eventId> | schedule:<UTC ISO minute> | webhook:sig:<digest> | webhook:dlv:<deliveryId>
  occurrence_key text NOT NULL,
  engine text NOT NULL,
  -- Provenance only (plain uuids): the generation, the legacy run, the flow run
  -- (NULL for a partner-wide flow's parent schedule claim).
  conversion_id uuid,
  legacy_run_id uuid,
  flow_run_id uuid,
  occurrence_at timestamptz,
  claimed_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_occurrence_claims_org_fk' AND conrelid = 'automation_occurrence_claims'::regclass) THEN
    ALTER TABLE automation_occurrence_claims ADD CONSTRAINT automation_occurrence_claims_org_fk
      FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_occurrence_claims_partner_fk' AND conrelid = 'automation_occurrence_claims'::regclass) THEN
    ALTER TABLE automation_occurrence_claims ADD CONSTRAINT automation_occurrence_claims_partner_fk
      FOREIGN KEY (partner_id) REFERENCES partners (id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_occurrence_claims_automation_fk' AND conrelid = 'automation_occurrence_claims'::regclass) THEN
    ALTER TABLE automation_occurrence_claims ADD CONSTRAINT automation_occurrence_claims_automation_fk
      FOREIGN KEY (automation_id) REFERENCES automations (id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_occurrence_claims_one_owner_chk' AND conrelid = 'automation_occurrence_claims'::regclass) THEN
    ALTER TABLE automation_occurrence_claims ADD CONSTRAINT automation_occurrence_claims_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
  -- Mirrors OCCURRENCE_KEY_RE in packages/shared/src/validators/flowConversions.ts.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_occurrence_claims_key_chk' AND conrelid = 'automation_occurrence_claims'::regclass) THEN
    ALTER TABLE automation_occurrence_claims ADD CONSTRAINT automation_occurrence_claims_key_chk
      CHECK (occurrence_key ~ '^(event:[0-9a-f-]{36}|schedule:[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z|webhook:sig:[0-9a-f]{64}|webhook:dlv:[A-Za-z0-9._:-]{1,128})$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_occurrence_claims_engine_chk' AND conrelid = 'automation_occurrence_claims'::regclass) THEN
    ALTER TABLE automation_occurrence_claims ADD CONSTRAINT automation_occurrence_claims_engine_chk
      CHECK (engine IN ('legacy', 'flow'));
  END IF;
  -- A legacy admission always names its run; a flow claim may not (parent schedule claim).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_occurrence_claims_run_chk' AND conrelid = 'automation_occurrence_claims'::regclass) THEN
    ALTER TABLE automation_occurrence_claims ADD CONSTRAINT automation_occurrence_claims_run_chk
      CHECK ((engine = 'flow' OR legacy_run_id IS NOT NULL) AND (engine = 'legacy' OR legacy_run_id IS NULL));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS automation_occurrence_claims_occurrence_uq
  ON automation_occurrence_claims (automation_id, occurrence_key);
CREATE INDEX IF NOT EXISTS automation_occurrence_claims_claimed_idx
  ON automation_occurrence_claims (claimed_at);
CREATE INDEX IF NOT EXISTS automation_occurrence_claims_org_idx
  ON automation_occurrence_claims (org_id) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS automation_occurrence_claims_partner_idx
  ON automation_occurrence_claims (partner_id) WHERE org_id IS NULL;

CREATE OR REPLACE FUNCTION public.automation_occurrence_claims_owner_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  a_org uuid;
  a_partner uuid;
BEGIN
  SELECT a.org_id, a.partner_id INTO a_org, a_partner
  FROM public.automations AS a
  WHERE a.id = NEW.automation_id;
  IF FOUND AND NEW.org_id IS NOT DISTINCT FROM a_org AND NEW.partner_id IS NOT DISTINCT FROM a_partner THEN
    RETURN NULL;
  END IF;

  RAISE EXCEPTION 'automation occurrence claim owner does not match its automation'
    USING ERRCODE = '23514',
          CONSTRAINT = 'automation_occurrence_claims_owner_chk';
END $$;

DROP TRIGGER IF EXISTS automation_occurrence_claims_owner_guard_trg ON automation_occurrence_claims;
CREATE CONSTRAINT TRIGGER automation_occurrence_claims_owner_guard_trg
  AFTER INSERT OR UPDATE OF org_id, partner_id, automation_id ON automation_occurrence_claims
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.automation_occurrence_claims_owner_guard();

CREATE OR REPLACE FUNCTION public.automation_occurrence_claims_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.partner_id IS DISTINCT FROM OLD.partner_id
     OR (NEW.org_id IS DISTINCT FROM OLD.org_id AND (OLD.org_id IS NULL OR NEW.org_id IS NULL))
     OR NEW.automation_id IS DISTINCT FROM OLD.automation_id
     OR NEW.occurrence_key IS DISTINCT FROM OLD.occurrence_key
     OR NEW.engine IS DISTINCT FROM OLD.engine
     OR NEW.conversion_id IS DISTINCT FROM OLD.conversion_id
     OR NEW.legacy_run_id IS DISTINCT FROM OLD.legacy_run_id
     OR NEW.flow_run_id IS DISTINCT FROM OLD.flow_run_id
     OR NEW.occurrence_at IS DISTINCT FROM OLD.occurrence_at
     OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at THEN
    RAISE EXCEPTION 'automation_occurrence_claims: claims are append-only' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS automation_occurrence_claims_append_only_trg ON automation_occurrence_claims;
CREATE TRIGGER automation_occurrence_claims_append_only_trg
  BEFORE UPDATE ON automation_occurrence_claims
  FOR EACH ROW EXECUTE FUNCTION public.automation_occurrence_claims_append_only();

ALTER TABLE automation_occurrence_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_occurrence_claims FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS automation_occurrence_claims_isolation ON automation_occurrence_claims;
CREATE POLICY automation_occurrence_claims_isolation
  ON automation_occurrence_claims
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

DROP POLICY IF EXISTS automation_occurrence_claims_partner_wide_select ON automation_occurrence_claims;
CREATE POLICY automation_occurrence_claims_partner_wide_select
  ON automation_occurrence_claims
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

-- DELETE stays granted: org erasure and the automation cascade delete claims as breeze_app.
GRANT SELECT, INSERT, DELETE ON automation_occurrence_claims TO breeze_app;
REVOKE UPDATE, TRUNCATE ON automation_occurrence_claims FROM breeze_app;
GRANT UPDATE (org_id) ON automation_occurrence_claims TO breeze_app;

-- ============================================
-- 3. automations.converted_to_flow_id
-- ============================================
ALTER TABLE automations ADD COLUMN IF NOT EXISTS converted_to_flow_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automations_converted_to_flow_fk' AND conrelid = 'automations'::regclass) THEN
    ALTER TABLE automations ADD CONSTRAINT automations_converted_to_flow_fk
      FOREIGN KEY (converted_to_flow_id) REFERENCES flows (id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automations_converted_flow_chk' AND conrelid = 'automations'::regclass) THEN
    ALTER TABLE automations ADD CONSTRAINT automations_converted_flow_chk
      CHECK (converted_to_flow_id IS NULL OR (retired_at IS NOT NULL AND retired_reason = 'converted_to_flow'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS automations_converted_to_flow_idx
  ON automations (converted_to_flow_id) WHERE converted_to_flow_id IS NOT NULL;

-- ============================================
-- 4. CHECK swaps — the four W6 fleet built-in step error codes
-- ============================================
ALTER TABLE flow_runs DROP CONSTRAINT IF EXISTS flow_runs_error_code_chk;
ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_error_code_chk
  CHECK (error_code IS NULL OR error_code IN (
    'step_failed', 'rejected', 'drift', 'binding_drift', 'unknown_outcome', 'step_timeout', 'input_invalid',
    'reference_not_owned', 'tool_unavailable', 'tool_blocked', 'too_many_items', 'render_failed',
    'no_eligible_approvers', 'worker_lost', 'cancelled',
    'egress_blocked', 'http_status', 'notify_failed', 'ai_budget_exhausted', 'ai_output_invalid', 'ai_token_cap_reached',
    'targets_over_cap', 'targets_unresolvable', 'alert_create_failed', 'script_dispatch_failed',
    'run_timeout', 'flow_disabled', 'flows_disabled', 'delegator_inactive', 'org_merged'
  ));

ALTER TABLE flow_run_steps DROP CONSTRAINT IF EXISTS flow_run_steps_error_code_chk;
ALTER TABLE flow_run_steps ADD CONSTRAINT flow_run_steps_error_code_chk
  CHECK (error_code IS NULL OR error_code IN (
    'step_failed', 'rejected', 'drift', 'binding_drift', 'unknown_outcome', 'step_timeout', 'input_invalid',
    'reference_not_owned', 'tool_unavailable', 'tool_blocked', 'too_many_items', 'render_failed',
    'no_eligible_approvers', 'worker_lost', 'cancelled',
    'egress_blocked', 'http_status', 'notify_failed', 'ai_budget_exhausted', 'ai_output_invalid', 'ai_token_cap_reached',
    'targets_over_cap', 'targets_unresolvable', 'alert_create_failed', 'script_dispatch_failed'
  ));
