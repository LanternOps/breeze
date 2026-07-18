-- Fix-forward canonical settings parity. Empty multi-item settings follow the
-- Breeze read-path mirror, and patch JSON contributes only validated fields.
CREATE OR REPLACE FUNCTION public.breeze_partner_export_effective_policy_settings(
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
          WHERE settings_id = settings.id), '[]'::jsonb),
        'eventLogAlerts', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
          'name', name, 'category', conditions->0->>'category',
          'level', conditions->0->>'level', 'sourcePattern', conditions->0->>'sourcePattern',
          'messagePattern', conditions->0->>'messagePattern',
          'countThreshold', conditions->0->'countThreshold',
          'windowMinutes', conditions->0->'windowMinutes',
          'severity', severity, 'enabled', true
        )) ORDER BY sort_order, id) FROM public.config_policy_alert_rules
          WHERE feature_link_id = link_id AND jsonb_typeof(conditions) = 'array'
            AND jsonb_array_length(conditions) = 1
            AND conditions->0->>'type' = 'event_log'), '[]'::jsonb),
        'alertRules', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'name', name, 'severity', severity, 'conditions', conditions,
          'cooldownMinutes', cooldown_minutes, 'autoResolve', auto_resolve
        ) ORDER BY sort_order, id) FROM public.config_policy_alert_rules
          WHERE feature_link_id = link_id AND jsonb_typeof(conditions) = 'array'
            AND jsonb_array_length(conditions) > 0
            AND conditions->0->>'type' <> 'event_log'), '[]'::jsonb)
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

REVOKE ALL ON FUNCTION public.breeze_partner_export_effective_policy_settings(uuid, text, jsonb) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT EXECUTE ON FUNCTION public.breeze_partner_export_effective_policy_settings(uuid, text, jsonb) TO breeze_app;
  END IF;
END $$;
