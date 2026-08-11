-- Patch reboot delay is operator-configurable (issue #3197).
--
-- Patch-triggered reboots warned the logged-in user not at all. The API queued
-- schedule_reboot with a hardcoded delayMinutes: 5 while the agent gated every
-- staged warning on `totalDelay > threshold` against a 60/15/5 ladder — 5 > 5 is
-- false, so a patched workstation went down with zero notice. The agent side is
-- fixed structurally (a warning always fires at scheduling time); this column is
-- the operator control that replaces the hardcoded constant, and it is also what
-- the maintenance-window reboot path now reads instead of keeping its own
-- independent 15-minute grace.
--
-- Home: config_policy_patch_settings, i.e. an existing Configuration Policy
-- surface rather than a new table. That matters for the partner-wide-first rule:
-- the table has no org_id of its own — tenancy and ownership come transitively
-- through feature_link_id -> config_policy_feature_links -> configuration_policies,
-- and 'patch' is already in PARTNER_LINKABLE_FEATURE_TYPES. So a partner-wide
-- patch policy carries a partner-wide reboot delay for free, with no new
-- dual-ownership CHECK, no new RLS policy, and no cascade or export-policy
-- registration (those lists key on org_id columns, which this table does not have).
--
-- Default 15 rather than the old 5: 15 is the value the maintenance path already
-- used, and it leaves room for the full warning ladder.

ALTER TABLE public.config_policy_patch_settings
  ADD COLUMN IF NOT EXISTS reboot_delay_minutes integer NOT NULL DEFAULT 15;

-- Bounds mirror the zod validator (packages/shared patchInlineSettingsSchema):
-- at least a minute so the closing "restarting now" notice can render before the
-- OS takes the session down, at most 24 hours so a policy cannot park a pending
-- reboot indefinitely.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'config_policy_patch_settings_reboot_delay_minutes_chk'
      AND conrelid = 'public.config_policy_patch_settings'::regclass
  ) THEN
    ALTER TABLE public.config_policy_patch_settings
      ADD CONSTRAINT config_policy_patch_settings_reboot_delay_minutes_chk
      CHECK (reboot_delay_minutes BETWEEN 1 AND 1440);
  END IF;
END $$;

-- Re-emit the canonical partner-export projection.
--
-- The patch branch is a hand-enumerated jsonb_build_object, so a new column does
-- NOT export itself — it has to be added here or partner API consumers silently
-- never see it while CI stays green (neither the parity suite nor the watermark
-- suite enumerates columns). Fix-forward per the never-edit-a-shipped-migration
-- rule: this reproduces the whole body from
-- 2026-07-30-alert-rule-ownership-consolidation.sql, which is the currently
-- authoritative definition, with one key added.

CREATE OR REPLACE FUNCTION public.breeze_partner_export_policy_settings_pre_patch(
  link_id uuid,
  feature_type text,
  mirror jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE result jsonb;
BEGIN
  CASE feature_type
    WHEN 'alert_rule' THEN
      SELECT jsonb_build_object('items', COALESCE(jsonb_agg(jsonb_build_object(
        'name', name, 'severity', severity, 'conditions', conditions,
        'cooldownMinutes', cooldown_minutes, 'autoResolve', auto_resolve,
        'autoResolveConditions', auto_resolve_conditions,
        'titleTemplate', title_template, 'messageTemplate', message_template,
        'sortOrder', sort_order
      ) ORDER BY sort_order, id), '[]'::jsonb)) INTO result
      FROM public.config_policy_alert_rules WHERE feature_link_id = link_id;
    WHEN 'automation' THEN
      SELECT jsonb_build_object('items', COALESCE(jsonb_agg(jsonb_build_object(
        'name', name, 'enabled', enabled, 'triggerType', trigger_type,
        'cronExpression', cron_expression, 'timezone', timezone,
        'eventType', event_type, 'actions', actions, 'onFailure', on_failure,
        'sortOrder', sort_order
      ) ORDER BY sort_order, id), '[]'::jsonb)) INTO result
      FROM public.config_policy_automations WHERE feature_link_id = link_id;
    WHEN 'compliance' THEN
      SELECT jsonb_build_object('items', COALESCE(jsonb_agg(jsonb_build_object(
        'name', name, 'rules', rules, 'enforcementLevel', enforcement_level,
        'checkIntervalMinutes', check_interval_minutes,
        'remediationScriptId', remediation_script_id, 'sortOrder', sort_order
      ) ORDER BY sort_order, id), '[]'::jsonb)) INTO result
      FROM public.config_policy_compliance_rules WHERE feature_link_id = link_id;
    WHEN 'patch' THEN
      SELECT jsonb_build_object(
        'sources', settings.sources,
        'autoApprove', settings.auto_approve,
        'autoApproveSeverities', COALESCE(settings.auto_approve_severities, ARRAY[]::text[]),
        'autoApproveDeferralDays', CASE
          WHEN jsonb_typeof(mirror->'autoApproveDeferralDays') = 'number'
            AND (mirror->>'autoApproveDeferralDays') ~ '^[0-9]{1,2}$'
          THEN CASE
            WHEN (mirror->>'autoApproveDeferralDays')::integer BETWEEN 0 AND 60
            THEN (mirror->>'autoApproveDeferralDays')::integer ELSE 0 END
          ELSE 0 END,
        'apps', CASE
          WHEN jsonb_typeof(mirror->'apps') = 'array'
            AND jsonb_array_length(mirror->'apps') <= 200
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(mirror->'apps') app
              WHERE jsonb_typeof(app) IS DISTINCT FROM 'object'
                 OR jsonb_typeof(app->'source') IS DISTINCT FROM 'string'
                 OR app->>'source' NOT IN ('third_party', 'custom')
                 OR jsonb_typeof(app->'packageId') IS DISTINCT FROM 'string'
                 OR length(app->>'packageId') NOT BETWEEN 1 AND 256
                 OR jsonb_typeof(app->'action') IS DISTINCT FROM 'string'
                 OR app->>'action' NOT IN ('block', 'pin')
                 OR (app ? 'displayName' AND (
                   jsonb_typeof(app->'displayName') IS DISTINCT FROM 'string'
                   OR length(app->>'displayName') > 255
                 ))
                 OR (app->>'action' = 'pin' AND (
                   jsonb_typeof(app->'pinnedVersion') IS DISTINCT FROM 'string'
                   OR length(app->>'pinnedVersion') NOT BETWEEN 1 AND 64
                 ))
            )
          THEN COALESCE((
            SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
              'source', app->>'source', 'packageId', app->>'packageId',
              'displayName', app->>'displayName', 'action', app->>'action',
              'pinnedVersion', app->>'pinnedVersion'
            )) ORDER BY ordinal)
            FROM jsonb_array_elements(mirror->'apps') WITH ORDINALITY entries(app, ordinal)
          ), '[]'::jsonb)
          ELSE '[]'::jsonb END,
        'scheduleFrequency', settings.schedule_frequency,
        'scheduleTime', settings.schedule_time,
        'scheduleDayOfWeek', settings.schedule_day_of_week,
        'scheduleDayOfMonth', settings.schedule_day_of_month,
        'rebootPolicy', settings.reboot_policy,
        'rebootDelayMinutes', settings.reboot_delay_minutes,
        'exclusiveWindowsUpdate', settings.exclusive_windows_update
      ) INTO result FROM public.config_policy_patch_settings settings
      WHERE settings.feature_link_id = link_id;
    WHEN 'maintenance' THEN
      SELECT jsonb_build_object(
        'recurrence', recurrence, 'durationHours', duration_hours, 'timezone', timezone,
        'windowStart', window_start, 'suppressAlerts', suppress_alerts,
        'suppressPatching', suppress_patching, 'suppressAutomations', suppress_automations,
        'suppressScripts', suppress_scripts, 'rebootIfPending', reboot_if_pending,
        'notifyBeforeMinutes', notify_before_minutes, 'notifyOnStart', notify_on_start,
        'notifyOnEnd', notify_on_end
      ) INTO result FROM public.config_policy_maintenance_settings WHERE feature_link_id = link_id;
    WHEN 'event_log' THEN
      SELECT jsonb_build_object(
        'retentionDays', retention_days, 'maxEventsPerCycle', max_events_per_cycle,
        'collectCategories', collect_categories, 'minimumLevel', minimum_level,
        'collectionIntervalMinutes', collection_interval_minutes,
        'rateLimitPerHour', rate_limit_per_hour
      ) INTO result FROM public.config_policy_event_log_settings WHERE feature_link_id = link_id;
    WHEN 'sensitive_data' THEN
      SELECT jsonb_build_object(
        'detectionClasses', detection_classes, 'includePaths', include_paths,
        'excludePaths', exclude_paths, 'fileTypes', file_types,
        'maxFileSizeBytes', max_file_size_bytes, 'workers', workers,
        'timeoutSeconds', timeout_seconds, 'suppressPatternIds', suppress_pattern_ids,
        'scheduleType', schedule_type, 'intervalMinutes', interval_minutes,
        'cron', cron, 'timezone', timezone
      ) INTO result FROM public.config_policy_sensitive_data_settings WHERE feature_link_id = link_id;
    WHEN 'monitoring' THEN
      -- Canonical 2-key shape. Alert rules are owned by the alert_rule feature
      -- link as of this migration; the monitoring feature carries only the
      -- agent-side watch configuration.
      SELECT jsonb_build_object(
        'checkIntervalSeconds', settings.check_interval_seconds,
        'watches', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'watchType', watch_type, 'name', name, 'displayName', display_name,
          'enabled', enabled, 'alertOnStop', alert_on_stop,
          'alertAfterConsecutiveFailures', alert_after_consecutive_failures,
          'alertSeverity', alert_severity, 'cpuThresholdPercent', cpu_threshold_percent,
          'memoryThresholdMb', memory_threshold_mb,
          'thresholdDurationSeconds', threshold_duration_seconds,
          'autoRestart', auto_restart, 'maxRestartAttempts', max_restart_attempts,
          'restartCooldownSeconds', restart_cooldown_seconds
        ) ORDER BY sort_order, id) FROM public.config_policy_monitoring_watches
          WHERE settings_id = settings.id), '[]'::jsonb)
      ) INTO result FROM public.config_policy_monitoring_settings settings
      WHERE settings.feature_link_id = link_id;
    WHEN 'backup' THEN
      SELECT jsonb_strip_nulls(jsonb_build_object(
        'schedule', schedule, 'retention', retention, 'paths', paths,
        'backupMode', backup_mode, 'targets', targets,
        'backupProfileId', backup_profile_id,
        'destinationConfigId', destination_config_id
      )) INTO result FROM public.config_policy_backup_settings WHERE feature_link_id = link_id;
    WHEN 'remote_access' THEN
      SELECT COALESCE(mirror, '{}'::jsonb) || jsonb_build_object(
        'sessionPromptMode', session_prompt_mode,
        'consentUnavailableBehavior', consent_unavailable_behavior,
        'notifyOnSessionEnd', notify_on_session_end,
        'showActiveIndicator', show_active_indicator,
        'technicianIdentityLevel', technician_identity_level
      ) INTO result FROM public.config_policy_remote_access_settings WHERE feature_link_id = link_id;
    WHEN 'onedrive_helper' THEN
      SELECT jsonb_build_object(
        'silentAccountConfig', settings.silent_account_config,
        'filesOnDemand', settings.files_on_demand,
        'kfmSilentOptIn', settings.kfm_silent_opt_in,
        'kfmFolders', settings.kfm_folders,
        'kfmBlockOptOut', settings.kfm_block_opt_out,
        'tenantAssociationId', settings.tenant_association_id,
        'restartOnChange', settings.restart_on_change,
        'libraries', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'libraryId', library_id, 'displayName', display_name, 'siteUrl', site_url,
          'siteId', site_id, 'webId', web_id, 'listId', list_id,
          'targetingMode', targeting_mode, 'groupId', group_id, 'groupName', group_name,
          'hiveScope', hive_scope, 'enabled', enabled
        ) ORDER BY sort_order, id) FROM public.config_policy_onedrive_libraries
          WHERE settings_id = settings.id), '[]'::jsonb)
      ) INTO result FROM public.config_policy_onedrive_settings settings
      WHERE settings.feature_link_id = link_id;
    ELSE result := NULL;
  END CASE;
  RETURN COALESCE(result, mirror);
END;
$$;

REVOKE ALL ON FUNCTION public.breeze_partner_export_policy_settings_pre_patch(uuid, text, jsonb) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT EXECUTE ON FUNCTION public.breeze_partner_export_policy_settings_pre_patch(uuid, text, jsonb) TO breeze_app;
  END IF;
END $$;
