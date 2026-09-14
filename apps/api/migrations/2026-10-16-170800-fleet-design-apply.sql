-- 2026-10-16-170800-fleet-design-apply.sql   (Fleet Designer W03, #5653)
--
-- Apply and rollback for a Fleet Design (spec §4.6, §4.8, §4.11).
-- DDL only: no rows written, no breeze.scope election. Idempotent; no inner
-- transaction (autoMigrate wraps the file).

-- 1. Rationale on the objects a design materialises --------------------------
-- A rule or watch created from a design carries the designer's "why" so a
-- technician reading the policy later sees it, and the drift design (W05)
-- can compare intent against state.
ALTER TABLE config_policy_alert_rules        ADD COLUMN IF NOT EXISTS rationale text NULL;
ALTER TABLE config_policy_monitoring_watches ADD COLUMN IF NOT EXISTS rationale text NULL;
ALTER TABLE alert_templates                  ADD COLUMN IF NOT EXISTS rationale text NULL;

-- 2. The apply ledger --------------------------------------------------------
-- TENANCY: RLS shape 1 (direct org_id). One row per applied item ref; the
-- UNIQUE (report_run_id, item_ref) index below is the idempotency key —
-- re-applying the same approval skips every ref that already has an
-- 'applied' row. Rollback reads this ledger (created_refs + before_image),
-- never a jsonb manifest on the report run.
--
-- report_run_id cascades because the org erasure PRE-CLEARS report_runs
-- (tenantCascade.ts's clear-first list) before deleting reports — a NO ACTION
-- FK here would abort that DELETE with 23503. The rows are also reached by the
-- main cascade loop on their own org_id, so either order is fine.
CREATE TABLE IF NOT EXISTS fleet_design_applied_items (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organizations (id),
  report_run_id          uuid NOT NULL REFERENCES report_runs (id) ON DELETE CASCADE,
  item_ref               text NOT NULL,
  item_kind              text NOT NULL,
  status                 text NOT NULL DEFAULT 'applied',
  step                   smallint NOT NULL,
  -- Ids the apply created or reused (group, policy, links, assignment,
  -- assessments) — an open container, export excludedOpen.
  created_refs           jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- State before the apply (previous inlineSettings, device role, prior
  -- assessment ids, memberships) — rollback's source of truth; excludedOpen.
  before_image           jsonb NULL,
  error                  text NULL,
  applied_by_user_id     uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  applied_at             timestamptz NOT NULL DEFAULT now(),
  rolled_back_by_user_id uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  rolled_back_at         timestamptz NULL,
  CONSTRAINT fleet_design_applied_items_kind_chk
    CHECK (item_kind IN ('function', 'policy', 'watch', 'rule', 'retired', 'script', 'role_correction')),
  CONSTRAINT fleet_design_applied_items_status_chk
    CHECK (status IN ('applied', 'rolled_back', 'failed')),
  CONSTRAINT fleet_design_applied_items_step_chk
    CHECK (step BETWEEN 1 AND 5),
  CONSTRAINT fleet_design_applied_items_rollback_chk
    CHECK ((status = 'rolled_back') = (rolled_back_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS fleet_design_applied_items_run_ref_uq
  ON fleet_design_applied_items (report_run_id, item_ref);
CREATE INDEX IF NOT EXISTS fleet_design_applied_items_org_run_idx
  ON fleet_design_applied_items (org_id, report_run_id);
CREATE INDEX IF NOT EXISTS fleet_design_applied_items_applied_by_idx
  ON fleet_design_applied_items (applied_by_user_id) WHERE applied_by_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fleet_design_applied_items_rolled_back_by_idx
  ON fleet_design_applied_items (rolled_back_by_user_id) WHERE rolled_back_by_user_id IS NOT NULL;

ALTER TABLE fleet_design_applied_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE fleet_design_applied_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON fleet_design_applied_items;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON fleet_design_applied_items;
DROP POLICY IF EXISTS breeze_org_isolation_update ON fleet_design_applied_items;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON fleet_design_applied_items;
CREATE POLICY breeze_org_isolation_select ON fleet_design_applied_items FOR SELECT
  USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON fleet_design_applied_items FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON fleet_design_applied_items FOR UPDATE
  USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON fleet_design_applied_items FOR DELETE
  USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON fleet_design_applied_items TO breeze_app;
