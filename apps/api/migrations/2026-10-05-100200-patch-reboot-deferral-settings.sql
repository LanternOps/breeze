-- Patch reboot deferral settings (#3207)
--
-- Adds the end-user deferral budget to config_policy_patch_settings, alongside
-- reboot_delay_minutes (#3197 / 2026-08-21-patch-reboot-delay-minutes.sql).
--
-- Tenancy: this table has NO org_id and NO partner_id. Ownership and tenancy
-- come transitively through feature_link_id -> config_policy_feature_links ->
-- configuration_policies, which already carries org_id XOR partner_id, and
-- 'patch' is already in PARTNER_LINKABLE_FEATURE_TYPES. So partner-wide-first
-- is satisfied by inheritance: no new one_owner_chk, no new RLS policy, no
-- dual-axis suite, and no cascade or export-policy registration (those lists
-- key on org_id columns, which this table does not have). Verified by grepping
-- tenantCascade.ts and tenantExportPolicyRegistry.ts, not assumed.
--
-- Defaults are deliberately OFF: reboot_allow_deferral=false reproduces today's
-- behaviour exactly, so this migration is behaviour-neutral on every existing
-- row.

ALTER TABLE config_policy_patch_settings
  ADD COLUMN IF NOT EXISTS reboot_allow_deferral boolean NOT NULL DEFAULT false;

ALTER TABLE config_policy_patch_settings
  ADD COLUMN IF NOT EXISTS reboot_max_deferrals integer NOT NULL DEFAULT 3;

ALTER TABLE config_policy_patch_settings
  ADD COLUMN IF NOT EXISTS reboot_deferral_minutes integer NOT NULL DEFAULT 60;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'config_policy_patch_settings_reboot_max_deferrals_chk'
  ) THEN
    ALTER TABLE config_policy_patch_settings
      ADD CONSTRAINT config_policy_patch_settings_reboot_max_deferrals_chk
      CHECK (reboot_max_deferrals BETWEEN 0 AND 10);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'config_policy_patch_settings_reboot_deferral_minutes_chk'
  ) THEN
    ALTER TABLE config_policy_patch_settings
      ADD CONSTRAINT config_policy_patch_settings_reboot_deferral_minutes_chk
      CHECK (reboot_deferral_minutes BETWEEN 5 AND 1440);
  END IF;
END $$;

-- Re-emit the canonical partner-export projection.
--
-- The patch branch is a hand-enumerated jsonb_build_object, so a new column does
-- NOT export itself. Fix-forward per the never-edit-a-shipped-migration rule:
-- this reproduces the whole body from 2026-08-21-patch-reboot-delay-minutes.sql,
-- which is the currently authoritative definition, with three keys added.
--
-- The trailing REVOKE/GRANT block is re-emitted deliberately: CREATE OR REPLACE
-- resets function ACLs, and partnerApiConfigurationWatermark.integration.test.ts
-- asserts patchPreMaterializerPublic=false / patchPreMaterializerApp=true.

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
        'rebootAllowDeferral', settings.reboot_allow_deferral,
        'rebootMaxDeferrals', settings.reboot_max_deferrals,
        'rebootDeferralMinutes', settings.reboot_deferral_minutes,
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
