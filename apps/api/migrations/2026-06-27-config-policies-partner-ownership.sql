-- Partner-owned configuration policies (#1724).
--
-- Until now a configuration_policies row was always owned by exactly one org
-- (org_id NOT NULL). The "Partner" assignment level existed but a policy still
-- had to belong to a single org, so a partner-wide policy could not span all of
-- a partner's organizations.
--
-- This migration makes a policy ownable by EITHER an org (org_id set,
-- partner_id NULL — the existing shape) OR a partner (partner_id set,
-- org_id NULL — the new "partner-wide / all orgs" shape). Exactly one axis is
-- set per row, enforced by a CHECK constraint.
--
-- RLS: configuration_policies now carries BOTH axes, so its policy is dual-axis
-- (org OR partner), mirroring custom_field_definitions / client_ai_prompt_templates.
-- A partner-owned row is visible/writable only to callers with
-- breeze_has_partner_access(partner_id); an org-owned row only to
-- breeze_has_org_access(org_id). System scope short-circuits both.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, guarded ALTER/CHECK, DROP POLICY IF
-- EXISTS then CREATE. Re-applying is a no-op. No inner BEGIN/COMMIT
-- (autoMigrate wraps each file in a transaction).

-- ============================================
-- Step 1: schema — add partner_id, relax org_id, enforce exactly-one-axis
-- ============================================

ALTER TABLE configuration_policies
  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);

-- org_id was NOT NULL; partner-owned rows must allow NULL org_id.
ALTER TABLE configuration_policies
  ALTER COLUMN org_id DROP NOT NULL;

-- Exactly one ownership axis must be set. (org_id IS NULL) <> (partner_id IS NULL)
-- is true iff exactly one of the two is NULL — i.e. exactly one is set.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'configuration_policies_one_owner_chk'
      AND conrelid = 'configuration_policies'::regclass
  ) THEN
    ALTER TABLE configuration_policies
      ADD CONSTRAINT configuration_policies_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS config_policies_partner_id_idx
  ON configuration_policies(partner_id);

-- ============================================
-- Step 2: RLS — dual-axis (org OR partner) + FORCE
-- ============================================

ALTER TABLE configuration_policies ENABLE ROW LEVEL SECURITY;
-- FORCE was missing on the original baseline policy; add it so the table owner
-- (breeze_app is not owner, but defense-in-depth for any privileged role) is
-- also subject to RLS, matching the partner-axis precedent (time_entries).
ALTER TABLE configuration_policies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS configuration_policies_org_isolation ON configuration_policies;
CREATE POLICY configuration_policies_org_isolation
  ON configuration_policies
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

-- ============================================
-- Step 3: child-table RLS — extend to reach a partner-owned parent
-- ============================================
-- The feature-link / assignment / per-feature child tables reach their tenant
-- through configuration_policies and previously gated ONLY on
-- breeze_has_org_access(cp.org_id). For a partner-owned parent (org_id NULL)
-- that branch is NULL/false, so the children would become invisible and
-- unwritable. Extend each to also accept breeze_has_partner_access(cp.partner_id).
-- breeze_has_org_access(NULL) / breeze_has_partner_access(NULL) are false, so the
-- org-owned case is unchanged.

DROP POLICY IF EXISTS config_policy_feature_links_org_isolation ON config_policy_feature_links;
CREATE POLICY config_policy_feature_links_org_isolation
  ON config_policy_feature_links
  USING (
    public.breeze_current_scope() = 'system'
    OR EXISTS (
      SELECT 1 FROM configuration_policies cp
      WHERE cp.id = config_policy_feature_links.config_policy_id
        AND (public.breeze_has_org_access(cp.org_id)
             OR public.breeze_has_partner_access(cp.partner_id))
    )
  );

DROP POLICY IF EXISTS config_policy_assignments_org_isolation ON config_policy_assignments;
CREATE POLICY config_policy_assignments_org_isolation
  ON config_policy_assignments
  USING (
    public.breeze_current_scope() = 'system'
    OR EXISTS (
      SELECT 1 FROM configuration_policies cp
      WHERE cp.id = config_policy_assignments.config_policy_id
        AND (public.breeze_has_org_access(cp.org_id)
             OR public.breeze_has_partner_access(cp.partner_id))
    )
  );

-- Per-feature children that join feature_link -> policy. Same OR-extension.
DROP POLICY IF EXISTS config_policy_alert_rules_org_isolation ON config_policy_alert_rules;
CREATE POLICY config_policy_alert_rules_org_isolation
  ON config_policy_alert_rules
  USING (
    public.breeze_current_scope() = 'system'
    OR EXISTS (
      SELECT 1 FROM config_policy_feature_links fl
      JOIN configuration_policies cp ON cp.id = fl.config_policy_id
      WHERE fl.id = config_policy_alert_rules.feature_link_id
        AND (public.breeze_has_org_access(cp.org_id)
             OR public.breeze_has_partner_access(cp.partner_id))
    )
  );

DROP POLICY IF EXISTS config_policy_automations_org_isolation ON config_policy_automations;
CREATE POLICY config_policy_automations_org_isolation
  ON config_policy_automations
  USING (
    public.breeze_current_scope() = 'system'
    OR EXISTS (
      SELECT 1 FROM config_policy_feature_links fl
      JOIN configuration_policies cp ON cp.id = fl.config_policy_id
      WHERE fl.id = config_policy_automations.feature_link_id
        AND (public.breeze_has_org_access(cp.org_id)
             OR public.breeze_has_partner_access(cp.partner_id))
    )
  );

DROP POLICY IF EXISTS config_policy_compliance_rules_org_isolation ON config_policy_compliance_rules;
CREATE POLICY config_policy_compliance_rules_org_isolation
  ON config_policy_compliance_rules
  USING (
    public.breeze_current_scope() = 'system'
    OR EXISTS (
      SELECT 1 FROM config_policy_feature_links fl
      JOIN configuration_policies cp ON cp.id = fl.config_policy_id
      WHERE fl.id = config_policy_compliance_rules.feature_link_id
        AND (public.breeze_has_org_access(cp.org_id)
             OR public.breeze_has_partner_access(cp.partner_id))
    )
  );

DROP POLICY IF EXISTS config_policy_patch_settings_org_isolation ON config_policy_patch_settings;
CREATE POLICY config_policy_patch_settings_org_isolation
  ON config_policy_patch_settings
  USING (
    public.breeze_current_scope() = 'system'
    OR EXISTS (
      SELECT 1 FROM config_policy_feature_links fl
      JOIN configuration_policies cp ON cp.id = fl.config_policy_id
      WHERE fl.id = config_policy_patch_settings.feature_link_id
        AND (public.breeze_has_org_access(cp.org_id)
             OR public.breeze_has_partner_access(cp.partner_id))
    )
  );

DROP POLICY IF EXISTS config_policy_maintenance_settings_org_isolation ON config_policy_maintenance_settings;
CREATE POLICY config_policy_maintenance_settings_org_isolation
  ON config_policy_maintenance_settings
  USING (
    public.breeze_current_scope() = 'system'
    OR EXISTS (
      SELECT 1 FROM config_policy_feature_links fl
      JOIN configuration_policies cp ON cp.id = fl.config_policy_id
      WHERE fl.id = config_policy_maintenance_settings.feature_link_id
        AND (public.breeze_has_org_access(cp.org_id)
             OR public.breeze_has_partner_access(cp.partner_id))
    )
  );

-- event_log settings: single USING-only policy (0029-event-log-policy-settings.sql).
DROP POLICY IF EXISTS config_policy_event_log_settings_org_isolation ON config_policy_event_log_settings;
CREATE POLICY config_policy_event_log_settings_org_isolation
  ON config_policy_event_log_settings
  USING (
    public.breeze_current_scope() = 'system'
    OR EXISTS (
      SELECT 1 FROM config_policy_feature_links fl
      JOIN configuration_policies cp ON cp.id = fl.config_policy_id
      WHERE fl.id = config_policy_event_log_settings.feature_link_id
        AND (public.breeze_has_org_access(cp.org_id)
             OR public.breeze_has_partner_access(cp.partner_id))
    )
  );

-- ── sensitive_data / monitoring children: per-command split policies ─────────
-- These were redefined as breeze_org_isolation_{select,insert,update,delete}
-- in 2026-06-23-sec-review-1-fk-child-rls-backstop.sql, using scalar-subquery
-- chains (single-table FROM configuration_policies, #1016-safe). We re-create
-- each with the extra partner_id branch. The chain terminates at
-- configuration_policies; breeze_has_org_access(NULL) is false so org-owned is
-- unchanged. config_policy_sensitive_data_settings:
ALTER TABLE config_policy_sensitive_data_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_policy_sensitive_data_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON config_policy_sensitive_data_settings;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON config_policy_sensitive_data_settings;
DROP POLICY IF EXISTS breeze_org_isolation_update ON config_policy_sensitive_data_settings;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON config_policy_sensitive_data_settings;
CREATE POLICY breeze_org_isolation_select ON config_policy_sensitive_data_settings FOR SELECT USING (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_sensitive_data_settings.feature_link_id)
    AND (public.breeze_has_org_access(cp.org_id) OR public.breeze_has_partner_access(cp.partner_id)))
);
CREATE POLICY breeze_org_isolation_insert ON config_policy_sensitive_data_settings FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_sensitive_data_settings.feature_link_id)
    AND (public.breeze_has_org_access(cp.org_id) OR public.breeze_has_partner_access(cp.partner_id)))
);
CREATE POLICY breeze_org_isolation_update ON config_policy_sensitive_data_settings FOR UPDATE USING (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_sensitive_data_settings.feature_link_id)
    AND (public.breeze_has_org_access(cp.org_id) OR public.breeze_has_partner_access(cp.partner_id)))
) WITH CHECK (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_sensitive_data_settings.feature_link_id)
    AND (public.breeze_has_org_access(cp.org_id) OR public.breeze_has_partner_access(cp.partner_id)))
);
CREATE POLICY breeze_org_isolation_delete ON config_policy_sensitive_data_settings FOR DELETE USING (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_sensitive_data_settings.feature_link_id)
    AND (public.breeze_has_org_access(cp.org_id) OR public.breeze_has_partner_access(cp.partner_id)))
);

-- config_policy_monitoring_settings:
ALTER TABLE config_policy_monitoring_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_policy_monitoring_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON config_policy_monitoring_settings;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON config_policy_monitoring_settings;
DROP POLICY IF EXISTS breeze_org_isolation_update ON config_policy_monitoring_settings;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON config_policy_monitoring_settings;
CREATE POLICY breeze_org_isolation_select ON config_policy_monitoring_settings FOR SELECT USING (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_monitoring_settings.feature_link_id)
    AND (public.breeze_has_org_access(cp.org_id) OR public.breeze_has_partner_access(cp.partner_id)))
);
CREATE POLICY breeze_org_isolation_insert ON config_policy_monitoring_settings FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_monitoring_settings.feature_link_id)
    AND (public.breeze_has_org_access(cp.org_id) OR public.breeze_has_partner_access(cp.partner_id)))
);
CREATE POLICY breeze_org_isolation_update ON config_policy_monitoring_settings FOR UPDATE USING (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_monitoring_settings.feature_link_id)
    AND (public.breeze_has_org_access(cp.org_id) OR public.breeze_has_partner_access(cp.partner_id)))
) WITH CHECK (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_monitoring_settings.feature_link_id)
    AND (public.breeze_has_org_access(cp.org_id) OR public.breeze_has_partner_access(cp.partner_id)))
);
CREATE POLICY breeze_org_isolation_delete ON config_policy_monitoring_settings FOR DELETE USING (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_monitoring_settings.feature_link_id)
    AND (public.breeze_has_org_access(cp.org_id) OR public.breeze_has_partner_access(cp.partner_id)))
);

-- config_policy_monitoring_watches: one extra hop (settings_id -> settings).
ALTER TABLE config_policy_monitoring_watches ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_policy_monitoring_watches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON config_policy_monitoring_watches;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON config_policy_monitoring_watches;
DROP POLICY IF EXISTS breeze_org_isolation_update ON config_policy_monitoring_watches;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON config_policy_monitoring_watches;
CREATE POLICY breeze_org_isolation_select ON config_policy_monitoring_watches FOR SELECT USING (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = (SELECT ms.feature_link_id FROM config_policy_monitoring_settings ms
                                  WHERE ms.id = config_policy_monitoring_watches.settings_id))
    AND (public.breeze_has_org_access(cp.org_id) OR public.breeze_has_partner_access(cp.partner_id)))
);
CREATE POLICY breeze_org_isolation_insert ON config_policy_monitoring_watches FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = (SELECT ms.feature_link_id FROM config_policy_monitoring_settings ms
                                  WHERE ms.id = config_policy_monitoring_watches.settings_id))
    AND (public.breeze_has_org_access(cp.org_id) OR public.breeze_has_partner_access(cp.partner_id)))
);
CREATE POLICY breeze_org_isolation_update ON config_policy_monitoring_watches FOR UPDATE USING (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = (SELECT ms.feature_link_id FROM config_policy_monitoring_settings ms
                                  WHERE ms.id = config_policy_monitoring_watches.settings_id))
    AND (public.breeze_has_org_access(cp.org_id) OR public.breeze_has_partner_access(cp.partner_id)))
) WITH CHECK (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = (SELECT ms.feature_link_id FROM config_policy_monitoring_settings ms
                                  WHERE ms.id = config_policy_monitoring_watches.settings_id))
    AND (public.breeze_has_org_access(cp.org_id) OR public.breeze_has_partner_access(cp.partner_id)))
);
CREATE POLICY breeze_org_isolation_delete ON config_policy_monitoring_watches FOR DELETE USING (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = (SELECT ms.feature_link_id FROM config_policy_monitoring_settings ms
                                  WHERE ms.id = config_policy_monitoring_watches.settings_id))
    AND (public.breeze_has_org_access(cp.org_id) OR public.breeze_has_partner_access(cp.partner_id)))
);
