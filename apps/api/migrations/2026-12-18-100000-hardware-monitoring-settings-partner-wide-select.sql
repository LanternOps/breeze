-- Partner-wide READ branch for config_policy_hardware_monitoring_settings
-- (#8142, horizontal-scaling W03 / W1a-2).
--
-- Every other per-feature settings table on the configuration-policy chain got
-- a SELECT-only own-partner branch in 2026-10-05-110000 (wave 1 of #4673) or in
-- its own creating migration (time_sync, 2026-11-10-120000). This table was
-- created by 2026-10-30-110100 without one, so an ORG-scoped context could not
-- read a partner-wide (org_id NULL) hardware-monitoring policy's settings, and
-- resolveHardwareMonitoring compensated by widening
-- breeze.accessible_partner_ids in place. W03 moves the agent heartbeat's
-- policy reads to the org-scoped context, so the branch is what makes
-- partner-wide hardware monitoring reach agents.
--
-- Same shape as config_policy_time_sync_settings_partner_wide_select: a
-- SEPARATE permissive FOR SELECT policy (never an edit to the per-command
-- breeze_parent_* policies), so UPDATE/DELETE targeting is unchanged.
-- Idempotent. Writes no rows, so no breeze.scope elevation is needed.
DROP POLICY IF EXISTS config_policy_hardware_monitoring_settings_partner_wide_select
  ON public.config_policy_hardware_monitoring_settings;
CREATE POLICY config_policy_hardware_monitoring_settings_partner_wide_select
  ON public.config_policy_hardware_monitoring_settings
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.configuration_policies cp
      WHERE cp.id = (
        SELECT fl.config_policy_id FROM public.config_policy_feature_links fl
        WHERE fl.id = config_policy_hardware_monitoring_settings.feature_link_id
      )
      AND cp.org_id IS NULL
      AND cp.partner_id = public.breeze_current_partner_id()
    )
  );
