-- Alerting consolidation W05c1 (spec §Conversion, §Tenancy and safety):
-- the conversion ledger. One `monitor_conversions` row per converted legacy
-- source row (an alert_templates source is the entire template/rules group) (idempotent on (source_table, source_id) while un-reverted); one
-- `monitor_conversion_outputs` row per monitor that conversion produced
-- (a watch can produce up to three: primary + resource_cpu + resource_memory).
--
-- Tenancy: both tables are owned on the SAME axis as the converted policy —
-- org_id XOR partner_id (CLAUDE.md "Partner-Wide First"), one dual-axis FOR
-- ALL policy, and a SEPARATE, additive FOR SELECT partner-wide branch keyed
-- on breeze_current_partner_id() (template: 2026-10-05-110000-config-policy-
-- partner-wide-select.sql; same shape as 2026-10-16-160300-monitor-definitions).
-- The outputs table denormalises the owner axes so it can sit in the org
-- cascade list in its own right; its composite FK (conversion_id, org_id) is
-- DEFERRABLE INITIALLY IMMEDIATE because org merge re-points org_id on parent
-- and child in separate statements under SET CONSTRAINTS ALL DEFERRED.
--
-- Idempotent (IF NOT EXISTS / DO $$ guards / DROP POLICY IF EXISTS + CREATE).
-- No inner BEGIN/COMMIT. No DML, so no breeze.scope elevation.
-- Rollback: a new migration dropping the two tables.

CREATE TABLE IF NOT EXISTS monitor_conversions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id),
  partner_id uuid REFERENCES partners(id),
  source_table text NOT NULL,
  source_id uuid NOT NULL,
  policy_id uuid REFERENCES configuration_policies(id) ON DELETE SET NULL,
  converted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  converted_at timestamptz NOT NULL DEFAULT now(),
  preview_hash text NOT NULL,
  source_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  reverted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monitor_conversions_one_owner_chk') THEN
    ALTER TABLE monitor_conversions
      ADD CONSTRAINT monitor_conversions_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monitor_conversions_source_table_chk') THEN
    ALTER TABLE monitor_conversions
      ADD CONSTRAINT monitor_conversions_source_table_chk CHECK (source_table IN (
        'config_policy_alert_rules', 'config_policy_monitoring_watches', 'alert_templates',
        'automations', 'config_policy_automations', 'network_monitors'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS monitor_conversions_org_id_idx ON monitor_conversions(org_id);
CREATE INDEX IF NOT EXISTS monitor_conversions_partner_id_idx ON monitor_conversions(partner_id);
CREATE INDEX IF NOT EXISTS monitor_conversions_policy_id_idx ON monitor_conversions(policy_id) WHERE policy_id IS NOT NULL;
-- Idempotency: one LIVE conversion per source row.
CREATE UNIQUE INDEX IF NOT EXISTS monitor_conversions_live_source_uidx
  ON monitor_conversions(source_table, source_id) WHERE reverted_at IS NULL;
-- Referenced by the outputs composite FK below (a non-partial unique index is a valid FK target).
CREATE UNIQUE INDEX IF NOT EXISTS monitor_conversions_id_org_uidx ON monitor_conversions(id, org_id);
CREATE UNIQUE INDEX IF NOT EXISTS monitor_conversions_id_partner_uidx ON monitor_conversions(id, partner_id);

ALTER TABLE monitor_conversions ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitor_conversions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS monitor_conversions_isolation ON monitor_conversions;
CREATE POLICY monitor_conversions_isolation
  ON monitor_conversions
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

DROP POLICY IF EXISTS monitor_conversions_partner_wide_select ON monitor_conversions;
CREATE POLICY monitor_conversions_partner_wide_select
  ON monitor_conversions
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON monitor_conversions TO breeze_app;

CREATE TABLE IF NOT EXISTS monitor_conversion_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversion_id uuid NOT NULL REFERENCES monitor_conversions(id) ON DELETE CASCADE,
  org_id uuid REFERENCES organizations(id),
  partner_id uuid REFERENCES partners(id),
  monitor_id uuid REFERENCES monitor_definitions(id) ON DELETE SET NULL,
  role text NOT NULL,
  moved_alert_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  moved_alert_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  reused_monitor boolean NOT NULL DEFAULT false,
  source_rule_id uuid REFERENCES alert_rules(id) ON DELETE SET NULL,
  policy_id uuid REFERENCES configuration_policies(id) ON DELETE SET NULL,
  attachment_id uuid REFERENCES config_policy_monitors(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monitor_conversion_outputs_one_owner_chk') THEN
    ALTER TABLE monitor_conversion_outputs
      ADD CONSTRAINT monitor_conversion_outputs_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monitor_conversion_outputs_role_chk') THEN
    ALTER TABLE monitor_conversion_outputs
      ADD CONSTRAINT monitor_conversion_outputs_role_chk
      CHECK (role IN ('primary', 'resource_cpu', 'resource_memory', 'response'));
  END IF;
  -- Org-merge contract: every composite FK carrying org_id is DEFERRABLE INITIALLY IMMEDIATE.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monitor_conversion_outputs_conversion_org_fk') THEN
    ALTER TABLE monitor_conversion_outputs
      ADD CONSTRAINT monitor_conversion_outputs_conversion_org_fk
      FOREIGN KEY (conversion_id, org_id) REFERENCES monitor_conversions(id, org_id)
      ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monitor_conversion_outputs_conversion_partner_fk') THEN
    ALTER TABLE monitor_conversion_outputs
      ADD CONSTRAINT monitor_conversion_outputs_conversion_partner_fk
      FOREIGN KEY (conversion_id, partner_id) REFERENCES monitor_conversions(id, partner_id)
      ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS monitor_conversion_outputs_conversion_id_idx ON monitor_conversion_outputs(conversion_id);
CREATE INDEX IF NOT EXISTS monitor_conversion_outputs_org_id_idx ON monitor_conversion_outputs(org_id);
CREATE INDEX IF NOT EXISTS monitor_conversion_outputs_partner_id_idx ON monitor_conversion_outputs(partner_id);
CREATE INDEX IF NOT EXISTS monitor_conversion_outputs_monitor_id_idx ON monitor_conversion_outputs(monitor_id) WHERE monitor_id IS NOT NULL;

ALTER TABLE monitor_conversion_outputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitor_conversion_outputs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS monitor_conversion_outputs_isolation ON monitor_conversion_outputs;
CREATE POLICY monitor_conversion_outputs_isolation
  ON monitor_conversion_outputs
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

DROP POLICY IF EXISTS monitor_conversion_outputs_partner_wide_select ON monitor_conversion_outputs;
CREATE POLICY monitor_conversion_outputs_partner_wide_select
  ON monitor_conversion_outputs
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON monitor_conversion_outputs TO breeze_app;
