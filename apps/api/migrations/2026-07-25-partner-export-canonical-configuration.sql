-- Fix-forward Task 7 hardening: canonical normalized policy settings and
-- material-clock coverage for every normalized feature child.

-- A burst of database-owned triggers can advance millisecond material clocks
-- slightly ahead of wall time. A read snapshot must wait past the largest
-- committed clock while holding shared org locks; otherwise an unchanged
-- incremental request can be rejected and the next writer can reuse the
-- snapshot boundary.
CREATE OR REPLACE FUNCTION public.breeze_partner_export_lock_orgs_shared_snapshot(org_ids uuid[])
RETURNS timestamp
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE snapshot_at timestamp;
BEGIN
  PERFORM public.breeze_partner_export_lock_orgs_shared(org_ids);
  SELECT GREATEST(
    date_trunc('milliseconds', clock_timestamp()) + INTERVAL '1 millisecond',
    COALESCE(MAX(candidate.updated_at) + INTERVAL '1 millisecond', '-infinity'::timestamp)
  ) INTO snapshot_at
  FROM (
    SELECT partner_export_updated_at AS updated_at FROM public.organizations WHERE id = ANY(org_ids)
    UNION ALL
    SELECT inventory_updated_at FROM public.partner_export_device_material_state WHERE org_id = ANY(org_ids)
    UNION ALL
    SELECT software_updated_at FROM public.partner_export_device_material_state WHERE org_id = ANY(org_ids)
    UNION ALL
    SELECT relationships_updated_at FROM public.partner_export_device_material_state WHERE org_id = ANY(org_ids)
    UNION ALL
    SELECT inventory_updated_at FROM public.partner_export_site_material_state WHERE org_id = ANY(org_ids)
    UNION ALL
    SELECT relationships_updated_at FROM public.partner_export_site_material_state WHERE org_id = ANY(org_ids)
    UNION ALL
    SELECT updated_at FROM public.partner_export_configuration_org_state WHERE org_id = ANY(org_ids)
  ) candidate;
  WHILE clock_timestamp() < snapshot_at LOOP
    PERFORM pg_sleep(0.0005);
  END LOOP;
  RETURN snapshot_at;
END;
$$;

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
      SELECT jsonb_build_object('items', jsonb_agg(jsonb_build_object(
        'name', name, 'severity', severity, 'conditions', conditions,
        'cooldownMinutes', cooldown_minutes, 'autoResolve', auto_resolve,
        'autoResolveConditions', auto_resolve_conditions,
        'titleTemplate', title_template, 'messageTemplate', message_template,
        'sortOrder', sort_order
      ) ORDER BY sort_order, id)) INTO result
      FROM public.config_policy_alert_rules WHERE feature_link_id = link_id;
    WHEN 'automation' THEN
      SELECT jsonb_build_object('items', jsonb_agg(jsonb_build_object(
        'name', name, 'enabled', enabled, 'triggerType', trigger_type,
        'cronExpression', cron_expression, 'timezone', timezone,
        'eventType', event_type, 'actions', actions, 'onFailure', on_failure,
        'sortOrder', sort_order
      ) ORDER BY sort_order, id)) INTO result
      FROM public.config_policy_automations WHERE feature_link_id = link_id;
    WHEN 'compliance' THEN
      SELECT jsonb_build_object('items', jsonb_agg(jsonb_build_object(
        'name', name, 'rules', rules, 'enforcementLevel', enforcement_level,
        'checkIntervalMinutes', check_interval_minutes,
        'remediationScriptId', remediation_script_id, 'sortOrder', sort_order
      ) ORDER BY sort_order, id)) INTO result
      FROM public.config_policy_compliance_rules WHERE feature_link_id = link_id;
    WHEN 'patch' THEN
      SELECT COALESCE(mirror, '{}'::jsonb) || jsonb_build_object(
        'sources', sources, 'autoApprove', auto_approve,
        'autoApproveSeverities', COALESCE(auto_approve_severities, ARRAY[]::text[]),
        'scheduleFrequency', schedule_frequency, 'scheduleTime', schedule_time,
        'scheduleDayOfWeek', schedule_day_of_week,
        'scheduleDayOfMonth', schedule_day_of_month, 'rebootPolicy', reboot_policy,
        'exclusiveWindowsUpdate', exclusive_windows_update
      ) INTO result FROM public.config_policy_patch_settings WHERE feature_link_id = link_id;
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
          'name', name,
          'category', conditions->0->>'category',
          'level', conditions->0->>'level',
          'sourcePattern', conditions->0->>'sourcePattern',
          'messagePattern', conditions->0->>'messagePattern',
          'countThreshold', conditions->0->'countThreshold',
          'windowMinutes', conditions->0->'windowMinutes',
          'severity', severity, 'enabled', true
        )) ORDER BY sort_order, id) FROM public.config_policy_alert_rules
          WHERE feature_link_id = link_id
            AND jsonb_typeof(conditions) = 'array'
            AND jsonb_array_length(conditions) = 1
            AND conditions->0->>'type' = 'event_log'), '[]'::jsonb),
        'alertRules', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'name', name, 'severity', severity, 'conditions', conditions,
          'cooldownMinutes', cooldown_minutes, 'autoResolve', auto_resolve
        ) ORDER BY sort_order, id) FROM public.config_policy_alert_rules
          WHERE feature_link_id = link_id
            AND jsonb_typeof(conditions) = 'array'
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

CREATE OR REPLACE FUNCTION public.breeze_partner_export_normalized_policy_child()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE values jsonb[]; link_ids uuid[]; org_ids uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(to_jsonb(row)) INTO values FROM new_rows row;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(to_jsonb(row)) INTO values FROM old_rows row;
  ELSE
    SELECT array_agg(value) INTO values FROM (
      SELECT to_jsonb(row) value FROM old_rows row
      UNION ALL SELECT to_jsonb(row) value FROM new_rows row
    ) affected;
  END IF;

  IF TG_TABLE_NAME = 'config_policy_monitoring_watches' THEN
    SELECT array_agg(DISTINCT settings.feature_link_id ORDER BY settings.feature_link_id)
      INTO link_ids FROM unnest(values) value
      JOIN public.config_policy_monitoring_settings settings
        ON settings.id = (value->>'settings_id')::uuid;
  ELSIF TG_TABLE_NAME = 'config_policy_onedrive_libraries' THEN
    SELECT array_agg(DISTINCT settings.feature_link_id ORDER BY settings.feature_link_id)
      INTO link_ids FROM unnest(values) value
      JOIN public.config_policy_onedrive_settings settings
        ON settings.id = (value->>'settings_id')::uuid;
  ELSE
    SELECT array_agg(DISTINCT (value->>'feature_link_id')::uuid ORDER BY (value->>'feature_link_id')::uuid)
      INTO link_ids FROM unnest(values) value;
  END IF;

  SELECT array_agg(DISTINCT o.id ORDER BY o.id) INTO org_ids
  FROM public.config_policy_feature_links fl
  JOIN public.configuration_policies cp ON cp.id = fl.config_policy_id
  JOIN public.organizations o ON o.id = cp.org_id OR (cp.org_id IS NULL AND o.partner_id = cp.partner_id)
  WHERE fl.id = ANY(link_ids);
  PERFORM public.breeze_partner_export_touch_configuration_orgs(org_ids, ARRAY['configuration-policies']);
  RETURN NULL;
END;
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'config_policy_alert_rules', 'config_policy_automations', 'config_policy_compliance_rules',
    'config_policy_patch_settings', 'config_policy_maintenance_settings',
    'config_policy_event_log_settings', 'config_policy_sensitive_data_settings',
    'config_policy_monitoring_settings', 'config_policy_monitoring_watches',
    'config_policy_backup_settings', 'config_policy_remote_access_settings',
    'config_policy_onedrive_settings', 'config_policy_onedrive_libraries'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS breeze_partner_export_normalized_insert ON public.%I', table_name);
    EXECUTE format('CREATE TRIGGER breeze_partner_export_normalized_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_normalized_policy_child()', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS breeze_partner_export_normalized_update ON public.%I', table_name);
    EXECUTE format('CREATE TRIGGER breeze_partner_export_normalized_update AFTER UPDATE ON %I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_normalized_policy_child()', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS breeze_partner_export_normalized_delete ON public.%I', table_name);
    EXECUTE format('CREATE TRIGGER breeze_partner_export_normalized_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_normalized_policy_child()', table_name);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.breeze_partner_export_normalized_policy_child() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    REVOKE ALL ON FUNCTION public.breeze_partner_export_normalized_policy_child() FROM breeze_app;
  END IF;
END $$;
