-- Dual-axis RLS for config_policy_remote_access_settings.
--
-- The 2026-06-19 policies reached ownership only via breeze_has_org_access on
-- the parent configuration_policies.org_id. Partner-owned parents (org_id
-- NULL, partner_id set — 2026-06-27-config-policies-partner-ownership) made
-- breeze_has_org_access(NULL) return false, so partner-wide consent settings
-- were invisible and unwritable to every non-system principal. Replace the
-- four per-command org-only policies with one dual-axis policy.
--
-- Shape note: this child table owns neither org_id nor partner_id — ownership
-- is two hops away (feature_link_id -> config_policy_feature_links ->
-- configuration_policies). Keep the scalar-subquery EXISTS form with
-- configuration_policies in the EXISTS FROM: the rls-coverage contract test
-- (PARENT_FK_JOIN_POLICY_TABLES) keys on exactly that join shape.

ALTER TABLE config_policy_remote_access_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_policy_remote_access_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON config_policy_remote_access_settings;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON config_policy_remote_access_settings;
DROP POLICY IF EXISTS breeze_org_isolation_update ON config_policy_remote_access_settings;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON config_policy_remote_access_settings;
DROP POLICY IF EXISTS config_policy_remote_access_settings_isolation ON config_policy_remote_access_settings;

CREATE POLICY config_policy_remote_access_settings_isolation
  ON config_policy_remote_access_settings
  USING (
    public.breeze_current_scope() = 'system'
    OR EXISTS (
      SELECT 1 FROM configuration_policies cp
      WHERE cp.id = (SELECT fl.config_policy_id
                       FROM config_policy_feature_links fl
                      WHERE fl.id = config_policy_remote_access_settings.feature_link_id)
        AND (
          (cp.org_id IS NOT NULL AND public.breeze_has_org_access(cp.org_id))
          OR (cp.partner_id IS NOT NULL AND public.breeze_has_partner_access(cp.partner_id))
        )
    )
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR EXISTS (
      SELECT 1 FROM configuration_policies cp
      WHERE cp.id = (SELECT fl.config_policy_id
                       FROM config_policy_feature_links fl
                      WHERE fl.id = config_policy_remote_access_settings.feature_link_id)
        AND (
          (cp.org_id IS NOT NULL AND public.breeze_has_org_access(cp.org_id))
          OR (cp.partner_id IS NOT NULL AND public.breeze_has_partner_access(cp.partner_id))
        )
    )
  );
