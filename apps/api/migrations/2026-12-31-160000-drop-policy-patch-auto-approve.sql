-- 2026-12-31-160000: retire policy-level patch auto-approve storage (#8184 W04, #8188).
--
-- Contract step of #1317 (ring-owned approval rules). Auto-approval and per-app
-- block/pin rules live on the Update Ring (patch_policies.auto_approve /
-- app_rules) since W02 (2026-12-26-230000-ring-app-rules-backfill.sql, shipped
-- in v0.123.0). The policy-level copies have not been consulted by the approval
-- evaluator since 2026-08 and are no longer read or written by the API, so this
-- migration removes them from every surface:
--
--   1. the partner-API export projection stops emitting autoApprove,
--      autoApproveSeverities, autoApproveDeferralDays and apps for patch links
--      (replaced FIRST, so the function never references a dropped column);
--   2. config_policy_patch_settings drops auto_approve and auto_approve_severities;
--   3. config_policy_feature_links.inline_settings loses the same four keys on
--      patch links.
--
-- (1) Fix-forward per the never-edit-a-shipped-migration rule: this reproduces
-- the whole body of breeze_partner_export_policy_settings_pre_patch from
-- 2026-12-22-110000-patch-restart-prompt-text.sql, the currently authoritative
-- definition, removing only those four keys from the 'patch' branch. The patch
-- branch no longer reads `mirror` at all. The public wrapper
-- breeze_partner_export_effective_policy_settings (2026-07-27-d) is left as is:
-- it already removes 'autoApproveDeferralDays'/'apps' from this output (now a
-- no-op) and attaches the raw mirror under __breezePatchInlineMirror, which
-- the route strips before anything is hashed or exported. canonicalizePolicyPatchSettings
-- (routes/partnerApi/configuration.ts) checks PATCH_NORMALIZED_MATERIAL_KEYS for
-- EXACT membership, so the two must change together (they do, in this PR).
-- The trailing REVOKE/GRANT block is re-emitted deliberately: CREATE OR REPLACE
-- resets function ACLs, and partnerApiConfigurationWatermark.integration.test.ts
-- asserts patchPreMaterializerPublic=false / patchPreMaterializerApp=true.
--
-- (2) Tenancy: config_policy_patch_settings has no org_id / partner_id (tenancy
-- is transitive via feature_link_id), so no cascade / merge / export-policy
-- registry entry changes. Dropping columns needs no breeze.scope elevation.
--
-- (3) Writes rows, so it elects system scope first (FORCE RLS would otherwise
-- match zero rows). The removed keys are inert: no reader consults them and
-- patchInlineSettingsSchema no longer defines them. Some links' stored `apps`
-- are enforced by no valid ring: an invalid ring reference (missing, not a
-- ring, another partner's ring, or a disabled ring), which already denies
-- every candidate at read time (ring_reference_invalid), or no ring at all,
-- which leaves manual approvals only. Before the strip each such link is
-- reported in one
-- `drop_policy_patch_auto_approve unenforced_app_rules` WARNING carrying the
-- link id, policy id, ring reference and the stored `apps` JSON (bounded to
-- 4000 characters) — the record an operator needs to recreate the rules on a
-- ring when repairing the link. A total count follows.
--
-- Idempotent: CREATE OR REPLACE, DROP COLUMN IF EXISTS, and the strip only
-- matches rows that still carry a key, so a re-run reports 0.

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
        'scheduleFrequency', settings.schedule_frequency,
        'scheduleTime', settings.schedule_time,
        'scheduleDayOfWeek', settings.schedule_day_of_week,
        'scheduleDayOfMonth', settings.schedule_day_of_month,
        'offlineBehavior', settings.offline_behavior,
        'rebootPolicy', settings.reboot_policy,
        'rebootDelayMinutes', settings.reboot_delay_minutes,
        'rebootAllowDeferral', settings.reboot_allow_deferral,
        'rebootMaxDeferrals', settings.reboot_max_deferrals,
        'rebootDeferralMinutes', settings.reboot_deferral_minutes,
        'rebootPromptTitle', settings.reboot_prompt_title,
        'rebootPromptBody', settings.reboot_prompt_body,
        'rebootPromptButton', settings.reboot_prompt_button,
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

ALTER TABLE config_policy_patch_settings
  DROP COLUMN IF EXISTS auto_approve,
  DROP COLUMN IF EXISTS auto_approve_severities;

-- @data-section-start: dropPolicyPatchAutoApproveMigration.integration.test.ts
-- replays everything below as a NOSUPERUSER NOBYPASSRLS role (the DDL above
-- needs the owner).
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  n bigint;
  r record;
  lock_orgs uuid[];
  lock_partners uuid[];
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  -- Forensic record: legacy app rules that no valid ring enforces are
  -- discarded with the key (the link has an invalid ring reference, which
  -- fails closed, or no ring, which is manual-approval only); one WARNING per
  -- link keeps what was there. The non-empty test is `<> '[]'`, never
  -- jsonb_array_length: the planner may evaluate quals in any order, and
  -- jsonb_array_length raises on a non-array `apps` (null, object, scalar).
  n := 0;
  FOR r IN
    SELECT l.id AS link_id, l.config_policy_id, l.feature_policy_id,
           left((l.inline_settings->'apps')::text, 4000) AS apps
    FROM config_policy_feature_links l
    JOIN configuration_policies cp ON cp.id = l.config_policy_id
    LEFT JOIN organizations o ON o.id = cp.org_id
    WHERE l.feature_type = 'patch'
      AND jsonb_typeof(l.inline_settings) = 'object'
      AND jsonb_typeof(l.inline_settings->'apps') = 'array'
      AND l.inline_settings->'apps' <> '[]'::jsonb
      AND NOT EXISTS (
        SELECT 1 FROM patch_policies p
        WHERE p.id = l.feature_policy_id
          AND p.kind = 'ring'
          AND p.enabled IS TRUE
          AND p.partner_id = COALESCE(cp.partner_id, o.partner_id)
      )
    ORDER BY l.id
  LOOP
    n := n + 1;
    RAISE WARNING 'drop_policy_patch_auto_approve unenforced_app_rules link=% policy=% ring_ref=% apps=%',
      r.link_id, r.config_policy_id, COALESCE(r.feature_policy_id::text, 'none'), r.apps;
  END LOOP;
  RAISE WARNING 'drop_policy_patch_auto_approve links_with_unenforced_app_rules=%', n;

  -- Configuration-family partner-export pre-locks (#5912): partners
  -- exclusive, then their orgs, before the first config_policy_feature_links
  -- write. The set covers every link the strip below rewrites: the policy's
  -- own org, or every org of its partner for a partner-wide policy, and those
  -- orgs' partners. Empty (a no-op) when nothing is left to strip.
  SELECT
    COALESCE(array_agg(DISTINCT o.id ORDER BY o.id), ARRAY[]::uuid[]),
    COALESCE(array_agg(DISTINCT o.partner_id ORDER BY o.partner_id), ARRAY[]::uuid[])
    INTO lock_orgs, lock_partners
    FROM config_policy_feature_links l
    JOIN configuration_policies cp ON cp.id = l.config_policy_id
    JOIN organizations o
      ON o.id = cp.org_id OR (cp.org_id IS NULL AND o.partner_id = cp.partner_id)
   WHERE l.feature_type = 'patch'
     AND jsonb_typeof(l.inline_settings) = 'object'
     AND l.inline_settings ?| ARRAY['apps', 'autoApprove', 'autoApproveSeverities', 'autoApproveDeferralDays'];
  PERFORM public.breeze_partner_export_lock_partners_exclusive(lock_partners);
  PERFORM public.breeze_partner_export_lock_orgs_under_exclusive_partners(lock_orgs, lock_partners);

  UPDATE config_policy_feature_links
     SET inline_settings = inline_settings
       - 'apps' - 'autoApprove' - 'autoApproveSeverities' - 'autoApproveDeferralDays'
   WHERE feature_type = 'patch'
     AND jsonb_typeof(inline_settings) = 'object'
     AND inline_settings ?| ARRAY['apps', 'autoApprove', 'autoApproveSeverities', 'autoApproveDeferralDays'];
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'drop_policy_patch_auto_approve inline_links_stripped=%', n;
END $$;
