-- Monitoring & Automation unification, W02 (#5287 / #5289).
--
-- Monitor definitions (org XOR partner), configuration-policy attachments,
-- managed-row provenance on the three compiled tables, and the two delivery
-- columns the config-policy alert path never had.
--
-- Tenancy shape: monitor_definitions is a CONFIG table, so it follows the
-- CLAUDE.md "Partner-Wide First" playbook — org_id XOR partner_id with a
-- one-owner CHECK, one dual-axis FOR ALL policy, and a SEPARATE, additive
-- FOR SELECT partner-wide branch keyed on breeze_current_partner_id() so an
-- ORG-scoped (and agent-scoped) session can READ its partner's shared monitors
-- without the #1105 escalation. The branch is never appended to the FOR ALL
-- policy: Postgres does not consult FOR SELECT policies when computing
-- UPDATE/DELETE target rows, so a separate policy widens reads and nothing
-- else. Template: 2026-10-05-110000-config-policy-partner-wide-select.sql.
--
-- config_policy_monitors has no org_id; it reaches its tenant through
-- config_policy_feature_links -> configuration_policies (PARENT_FK_JOIN shape).
--
-- Idempotent (IF NOT EXISTS / DO $$ guards / DROP POLICY IF EXISTS + CREATE);
-- re-applying is a no-op. No inner BEGIN/COMMIT — autoMigrate wraps each file
-- in a transaction. No DML, so no breeze.scope elevation is required.
--
-- Rollback: a new migration dropping the two tables, the added columns, the
-- two functions and the trigger. Nothing reads them before this wave's code.

-- ============================================
-- 1. Monitor kinds shipped in W02. Each maps onto an existing
--    alertConditions handler; no new evaluation code in the sweep.
-- ============================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'monitor_kind') THEN
    CREATE TYPE monitor_kind AS ENUM (
      'cpu', 'memory', 'disk', 'offline', 'event_log', 'patch_compliance',
      'service', 'process', 'process_resource', 'cert_expiry',
      'bandwidth', 'disk_io', 'network_errors'
    );
  END IF;
END $$;

-- ============================================
-- 2. New configuration-policy feature type. 'monitoring' (service/process
--    watches) already exists; this one is deliberately the plural. Safe inside
--    the runner's transaction because nothing in this file consumes the value.
-- ============================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'monitors'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'config_feature_type')
  ) THEN
    ALTER TYPE config_feature_type ADD VALUE 'monitors';
  END IF;
END $$;

-- ============================================
-- 3. monitor_definitions — a config table: org_id XOR partner_id.
-- ============================================
CREATE TABLE IF NOT EXISTS monitor_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id),
  partner_id uuid REFERENCES partners(id),
  name varchar(200) NOT NULL,
  description text,
  kind monitor_kind NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  condition jsonb NOT NULL,
  severity alert_severity NOT NULL,
  cooldown_minutes integer NOT NULL DEFAULT 5,
  auto_resolve boolean NOT NULL DEFAULT false,
  auto_resolve_conditions jsonb,
  responses jsonb NOT NULL DEFAULT '[]'::jsonb,
  delivery_mode varchar(16) NOT NULL DEFAULT 'inherit',
  delivery_channel_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  escalation_policy_id uuid REFERENCES escalation_policies(id) ON DELETE SET NULL,
  recurrence_threshold integer,
  recurrence_window_hours integer,
  recurrence_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  pause_responses_on_escalation boolean NOT NULL DEFAULT true,
  ai_agent_id uuid REFERENCES ai_agents(id) ON DELETE SET NULL,
  compiled_alert_template_id uuid,
  compiled_alert_rule_id uuid,
  compiled_automation_id uuid,
  compiled_hash text,
  compiled_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monitor_definitions_one_owner_chk') THEN
    ALTER TABLE monitor_definitions
      ADD CONSTRAINT monitor_definitions_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monitor_definitions_delivery_mode_chk') THEN
    ALTER TABLE monitor_definitions
      ADD CONSTRAINT monitor_definitions_delivery_mode_chk CHECK (delivery_mode IN ('none', 'inherit', 'channels'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monitor_definitions_recurrence_chk') THEN
    ALTER TABLE monitor_definitions
      ADD CONSTRAINT monitor_definitions_recurrence_chk CHECK (
        (recurrence_threshold IS NULL) = (recurrence_window_hours IS NULL)
        AND (recurrence_threshold IS NULL OR recurrence_threshold >= 2)
        AND (recurrence_window_hours IS NULL OR recurrence_window_hours >= 1)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS monitor_definitions_org_id_idx ON monitor_definitions(org_id);
CREATE INDEX IF NOT EXISTS monitor_definitions_partner_id_idx ON monitor_definitions(partner_id);
CREATE UNIQUE INDEX IF NOT EXISTS monitor_definitions_owner_name_uidx
  ON monitor_definitions (COALESCE(org_id, partner_id), lower(name));

ALTER TABLE monitor_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitor_definitions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS monitor_definitions_isolation ON monitor_definitions;
CREATE POLICY monitor_definitions_isolation
  ON monitor_definitions
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

-- Additive, SELECT-only own-partner read branch (#4673 / CLAUDE.md
-- "Partner-Wide First" step 3). Org tokens carry breeze.current_partner_id but
-- never pass breeze_has_partner_access; the agent path sets it too
-- (middleware/agentAuth.ts), so partner-wide monitors reach agents. `=` and not
-- IS NOT DISTINCT FROM: an unset GUC reads NULL and must never match.
DROP POLICY IF EXISTS monitor_definitions_partner_wide_select ON monitor_definitions;
CREATE POLICY monitor_definitions_partner_wide_select
  ON monitor_definitions
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON monitor_definitions TO breeze_app;

-- ============================================
-- 4. config_policy_monitors — attachment rows under a 'monitors' feature link.
--    Tenant reached through the parent policy (PARENT_FK_JOIN shape). The read
--    branch also admits an org session reading its own partner's partner-wide
--    policy attachments; WITH CHECK deliberately does NOT, so writing to a
--    partner-wide policy still requires partner access.
-- ============================================
CREATE TABLE IF NOT EXISTS config_policy_monitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_link_id uuid NOT NULL REFERENCES config_policy_feature_links(id) ON DELETE CASCADE,
  monitor_id uuid NOT NULL REFERENCES monitor_definitions(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  overrides jsonb,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS config_policy_monitors_link_monitor_uidx
  ON config_policy_monitors(feature_link_id, monitor_id);
CREATE INDEX IF NOT EXISTS config_policy_monitors_monitor_id_idx ON config_policy_monitors(monitor_id);

ALTER TABLE config_policy_monitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_policy_monitors FORCE ROW LEVEL SECURITY;

-- The EXISTS reads FROM configuration_policies (the declared parent) with the
-- feature link as a scalar subquery, rather than joining the two. That shape is
-- load-bearing for the parent-FK contract test in
-- rls-coverage.integration.test.ts: it matches on the literal `FROM
-- configuration_policies` and on the helper being applied to the PARENT's
-- alias, and Postgres renders a two-table join as `FROM (configuration_policies
-- cp JOIN ...)` — with a parenthesis that defeats the match.
DROP POLICY IF EXISTS config_policy_monitors_isolation ON config_policy_monitors;
CREATE POLICY config_policy_monitors_isolation
  ON config_policy_monitors
  USING (
    public.breeze_current_scope() = 'system'
    OR EXISTS (
      SELECT 1 FROM configuration_policies cp
      WHERE cp.id = (
          SELECT fl.config_policy_id FROM config_policy_feature_links fl
          WHERE fl.id = config_policy_monitors.feature_link_id
        )
        AND (
          public.breeze_has_org_access(cp.org_id)
          OR public.breeze_has_partner_access(cp.partner_id)
        )
    )
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR EXISTS (
      SELECT 1 FROM configuration_policies cp
      WHERE cp.id = (
          SELECT fl.config_policy_id FROM config_policy_feature_links fl
          WHERE fl.id = config_policy_monitors.feature_link_id
        )
        AND (
          public.breeze_has_org_access(cp.org_id)
          OR public.breeze_has_partner_access(cp.partner_id)
        )
    )
  );

DROP POLICY IF EXISTS config_policy_monitors_partner_wide_select ON config_policy_monitors;
CREATE POLICY config_policy_monitors_partner_wide_select
  ON config_policy_monitors
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM configuration_policies cp
      WHERE cp.id = (
          SELECT fl.config_policy_id FROM config_policy_feature_links fl
          WHERE fl.id = config_policy_monitors.feature_link_id
        )
        AND cp.org_id IS NULL
        AND cp.partner_id = public.breeze_current_partner_id()
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON config_policy_monitors TO breeze_app;

-- ============================================
-- 5. Attachment compatibility. A policy may attach a monitor only when the
--    monitor is owned by the policy's org, by the policy's partner, or is
--    partner-wide under the policy org's partner. COALESCE(..., false) so a
--    lookup miss is a DENY (two-valued logic; a NULL guard fails open).
--    Mirrors breeze_config_policy_parent_compatible (#5080).
-- ============================================
CREATE OR REPLACE FUNCTION public.breeze_monitor_attachment_compatible(p_monitor_id uuid, p_feature_link_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT
      CASE
        WHEN m.org_id IS NOT NULL AND cp.org_id IS NOT NULL THEN m.org_id = cp.org_id
        WHEN m.partner_id IS NOT NULL AND cp.partner_id IS NOT NULL THEN m.partner_id = cp.partner_id
        WHEN m.partner_id IS NOT NULL AND cp.org_id IS NOT NULL THEN m.partner_id = o.partner_id
        ELSE false
      END
    FROM monitor_definitions m
    CROSS JOIN config_policy_feature_links fl
    JOIN configuration_policies cp ON cp.id = fl.config_policy_id
    LEFT JOIN organizations o ON o.id = cp.org_id
    WHERE m.id = p_monitor_id AND fl.id = p_feature_link_id
  ), false);
$$;
REVOKE ALL ON FUNCTION public.breeze_monitor_attachment_compatible(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.breeze_monitor_attachment_compatible(uuid, uuid) TO breeze_app;

CREATE OR REPLACE FUNCTION public.breeze_config_policy_monitors_compat_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.breeze_monitor_attachment_compatible(NEW.monitor_id, NEW.feature_link_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'monitor % cannot be attached to feature link %: owner mismatch', NEW.monitor_id, NEW.feature_link_id
      USING ERRCODE = '23514', CONSTRAINT = 'config_policy_monitors_compat';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'config_policy_monitors_compat_trg') THEN
    CREATE CONSTRAINT TRIGGER config_policy_monitors_compat_trg
      AFTER INSERT OR UPDATE OF monitor_id, feature_link_id ON config_policy_monitors
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION public.breeze_config_policy_monitors_compat_guard();
  END IF;
END $$;

-- ============================================
-- 6. Managed-row provenance on the compiled tables + alert linkage.
--    monitorCompiler.ts is the only writer of rows carrying these columns.
-- ============================================
ALTER TABLE alert_templates ADD COLUMN IF NOT EXISTS managed_by_monitor_id uuid REFERENCES monitor_definitions(id) ON DELETE CASCADE;
ALTER TABLE alert_rules     ADD COLUMN IF NOT EXISTS managed_by_monitor_id uuid REFERENCES monitor_definitions(id) ON DELETE CASCADE;
ALTER TABLE automations     ADD COLUMN IF NOT EXISTS managed_by_monitor_id uuid REFERENCES monitor_definitions(id) ON DELETE CASCADE;
ALTER TABLE alerts          ADD COLUMN IF NOT EXISTS monitor_id uuid REFERENCES monitor_definitions(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS alert_templates_managed_by_monitor_uidx ON alert_templates(managed_by_monitor_id) WHERE managed_by_monitor_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS alert_rules_managed_by_monitor_uidx     ON alert_rules(managed_by_monitor_id)     WHERE managed_by_monitor_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS automations_managed_by_monitor_uidx     ON automations(managed_by_monitor_id)     WHERE managed_by_monitor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS alerts_monitor_id_idx ON alerts(monitor_id) WHERE monitor_id IS NOT NULL;

-- ============================================
-- 7. Delivery parity for the config-policy alert path (spec §Delivery).
-- ============================================
ALTER TABLE config_policy_alert_rules ADD COLUMN IF NOT EXISTS escalation_policy_id uuid REFERENCES escalation_policies(id) ON DELETE SET NULL;
ALTER TABLE config_policy_alert_rules ADD COLUMN IF NOT EXISTS notification_channel_ids jsonb;
