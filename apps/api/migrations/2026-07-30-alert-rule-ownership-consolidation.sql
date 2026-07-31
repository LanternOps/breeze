-- Alerts/monitoring consolidation: the `alert_rule` feature link becomes the
-- single owner of every server-evaluated alert rule. Historically the
-- monitoring feature ALSO decomposed `alertRules` / `eventLogAlerts` into
-- config_policy_alert_rules rows keyed by the MONITORING feature link, so the
-- same policy could carry two disjoint rule sets that the resolver had to
-- union. This migration moves those rows onto the policy's alert_rule link
-- (creating one when absent), drops exact duplicates, renumbers sort_order so
-- the merged set stays deterministic, and rebuilds both inline_settings JSONB
-- mirrors.
--
-- Rule row ids are PRESERVED on the move: alerts.config_policy_id stores the
-- config_policy_alert_rules.id that produced the alert (it is a plain uuid
-- column, no FK), so re-keying would orphan alert provenance. Only the
-- deduped rows change id, and their alerts are repointed at the survivor
-- first.
--
-- The migration is idempotent: after a successful run there are no rules left
-- under monitoring links, so every step is a no-op on replay.
--
-- Alert cooldowns: the evaluator keys its Redis cooldown on the rule id
-- (`cpar:<ruleId>:<deviceId>`), so the rule ids dropped by the dedupe step
-- orphan their cooldown keys. Each deduped rule x device may therefore fire one
-- spurious alert immediately after this migration; it self-heals within that
-- rule's cooldownMinutes. Moved rules keep their ids and so keep their
-- cooldowns.
--
-- Finally, the raw-SQL partner-export materializer is fixed forward: its
-- monitoring branch still re-derived the old 4-key shape
-- (checkIntervalSeconds, watches, eventLogAlerts, alertRules). It now emits
-- the canonical 2-key shape, matching assembleInlineSettings() in
-- services/configurationPolicy.ts. Its alert_rule branch already reads
-- config_policy_alert_rules by feature_link_id, so with rules relocated it
-- serializes the merged set (metric + event_log) automatically.

-- Run with system scope: config_policy_alert_rules / config_policy_feature_links
-- / alerts all have FORCE ROW LEVEL SECURITY, and the migration role is not
-- guaranteed to be a superuser on managed Postgres. Without this the DML below
-- would silently touch zero rows (transaction-local; autoMigrate wraps the file).
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  affected_policies uuid[];
  created_links integer := 0;
  repointed_alerts integer := 0;
  removed_dupes integer := 0;
  moved_rules integer := 0;
  stripped_links integer := 0;
  stripped_nonempty integer := 0;
  rebuilt_mirrors integer := 0;
  remaining integer;
BEGIN
  -- Policies that still own alert rules through their monitoring link.
  SELECT COALESCE(array_agg(DISTINCT ml.config_policy_id), ARRAY[]::uuid[])
    INTO affected_policies
  FROM public.config_policy_feature_links ml
  JOIN public.config_policy_alert_rules r ON r.feature_link_id = ml.id
  WHERE ml.feature_type = 'monitoring';

  -- 1. Ensure every affected policy has an alert_rule link to move rows onto.
  --    `config_feature_links_unique (config_policy_id, feature_type)` makes the
  --    ON CONFLICT a true idempotency guard. id/created_at/updated_at all have
  --    column defaults, so they are intentionally omitted.
  INSERT INTO public.config_policy_feature_links (config_policy_id, feature_type, feature_policy_id, inline_settings)
  SELECT policy_id, 'alert_rule', NULL, jsonb_build_object('items', '[]'::jsonb)
  FROM unnest(affected_policies) AS policy_id
  ON CONFLICT (config_policy_id, feature_type) DO NOTHING;
  GET DIAGNOSTICS created_links = ROW_COUNT;
  IF created_links > 0 THEN
    RAISE WARNING 'alert-rule consolidation: created % alert_rule feature links', created_links;
  END IF;

  -- 2. Dedupe. A monitoring-owned rule whose exact fingerprint already exists
  --    under the same policy's alert_rule link is dropped, after repointing any
  --    alerts that reference it at the survivor. Fingerprint =
  --    (name, severity, conditions, cooldown_minutes, auto_resolve) — the
  --    fields the old monitoring decompose path wrote; templates and
  --    auto_resolve_conditions are deliberately excluded because the monitoring
  --    path always wrote defaults for them.
  --    DISTINCT ON keeps one survivor when several identical target rows exist.
  WITH dupes AS (
    SELECT DISTINCT ON (src.id) src.id AS dupe_id, tgt.id AS keep_id
    FROM public.config_policy_alert_rules src
    JOIN public.config_policy_feature_links ml
      ON ml.id = src.feature_link_id AND ml.feature_type = 'monitoring'
    JOIN public.config_policy_feature_links al
      ON al.config_policy_id = ml.config_policy_id AND al.feature_type = 'alert_rule'
    JOIN public.config_policy_alert_rules tgt
      ON tgt.feature_link_id = al.id
     AND tgt.name = src.name
     AND tgt.severity = src.severity
     AND tgt.conditions = src.conditions
     AND tgt.cooldown_minutes = src.cooldown_minutes
     AND tgt.auto_resolve = src.auto_resolve
    ORDER BY src.id, tgt.sort_order, tgt.created_at, tgt.id
  ), repointed AS (
    UPDATE public.alerts a
    SET config_policy_id = d.keep_id
    FROM dupes d
    WHERE a.config_policy_id = d.dupe_id
    RETURNING 1
  ), deleted AS (
    DELETE FROM public.config_policy_alert_rules r
    USING dupes d
    WHERE r.id = d.dupe_id
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM repointed), (SELECT count(*) FROM deleted)
    INTO repointed_alerts, removed_dupes;
  IF removed_dupes > 0 OR repointed_alerts > 0 THEN
    RAISE WARNING 'alert-rule consolidation: removed % duplicate rules, repointed % alerts',
      removed_dupes, repointed_alerts;
  END IF;

  -- 3. Move the survivors onto the alert_rule link of the SAME policy, ids
  --    preserved. sort_order continues after the highest sort_order already
  --    present on the target link so the merged ordering stays stable and
  --    collision-free; relative order within the moved set is preserved.
  WITH targets AS (
    SELECT ml.id AS monitoring_link_id,
           al.id AS alert_link_id,
           COALESCE((
             SELECT max(x.sort_order)
             FROM public.config_policy_alert_rules x
             WHERE x.feature_link_id = al.id
           ), -1) AS base_sort
    FROM public.config_policy_feature_links ml
    JOIN public.config_policy_feature_links al
      ON al.config_policy_id = ml.config_policy_id AND al.feature_type = 'alert_rule'
    WHERE ml.feature_type = 'monitoring'
  ), moved AS (
    SELECT r.id,
           t.alert_link_id,
           (t.base_sort + row_number() OVER (
              PARTITION BY t.alert_link_id ORDER BY r.sort_order, r.created_at, r.id
           ))::integer AS new_sort
    FROM public.config_policy_alert_rules r
    JOIN targets t ON t.monitoring_link_id = r.feature_link_id
  )
  UPDATE public.config_policy_alert_rules r
  SET feature_link_id = m.alert_link_id,
      sort_order = m.new_sort,
      updated_at = now()
  FROM moved m
  WHERE r.id = m.id;
  GET DIAGNOSTICS moved_rules = ROW_COUNT;
  IF moved_rules > 0 THEN
    RAISE WARNING 'alert-rule consolidation: moved % alert rules to alert_rule links', moved_rules;
  END IF;

  -- 4a. Monitoring mirrors: strip the keys the monitoring feature no longer
  --     owns. This is deliberately GLOBAL (not limited to affected policies):
  --     monitoringInlineSettingsSchema now rejects non-empty alertRules /
  --     eventLogAlerts on write, so any stored occurrence is stale. Mirrors
  --     carrying DISABLED eventLogAlerts never produced normalized rows (the
  --     old decompose skipped `enabled: false`), so those entries are dropped
  --     here rather than migrated — they were never evaluated. The count is
  --     reported separately for the forensic trail.
  SELECT count(*) INTO stripped_nonempty
  FROM public.config_policy_feature_links
  WHERE feature_type = 'monitoring'
    AND inline_settings IS NOT NULL
    AND (
      (jsonb_typeof(inline_settings->'alertRules') = 'array' AND jsonb_array_length(inline_settings->'alertRules') > 0)
      OR (jsonb_typeof(inline_settings->'eventLogAlerts') = 'array' AND jsonb_array_length(inline_settings->'eventLogAlerts') > 0)
    );

  UPDATE public.config_policy_feature_links
  SET inline_settings = (inline_settings - 'alertRules' - 'eventLogAlerts'),
      updated_at = now()
  WHERE feature_type = 'monitoring'
    AND inline_settings IS NOT NULL
    AND (inline_settings ? 'alertRules' OR inline_settings ? 'eventLogAlerts');
  GET DIAGNOSTICS stripped_links = ROW_COUNT;
  IF stripped_links > 0 THEN
    RAISE WARNING 'alert-rule consolidation: stripped alertRules/eventLogAlerts from % monitoring mirrors (% carried non-empty arrays)',
      stripped_links, stripped_nonempty;
  END IF;

  -- 4b. Alert_rule mirrors: rebuild items[] from the normalized rows for the
  --     policies this migration touched. The IS DISTINCT FROM guard keeps a
  --     replay from bumping updated_at (and the partner-export watermark).
  UPDATE public.config_policy_feature_links al
  SET inline_settings = jsonb_build_object('items', COALESCE(sub.items, '[]'::jsonb)),
      updated_at = now()
  FROM (
    SELECT feature_link_id, jsonb_agg(jsonb_build_object(
      'name', name, 'severity', severity, 'conditions', conditions,
      'cooldownMinutes', cooldown_minutes, 'autoResolve', auto_resolve,
      'autoResolveConditions', auto_resolve_conditions,
      'titleTemplate', title_template, 'messageTemplate', message_template,
      'sortOrder', sort_order
    ) ORDER BY sort_order, created_at, id) AS items
    FROM public.config_policy_alert_rules
    GROUP BY feature_link_id
  ) sub
  WHERE sub.feature_link_id = al.id
    AND al.feature_type = 'alert_rule'
    AND al.config_policy_id = ANY(affected_policies)
    AND al.inline_settings IS DISTINCT FROM jsonb_build_object('items', COALESCE(sub.items, '[]'::jsonb));
  GET DIAGNOSTICS rebuilt_mirrors = ROW_COUNT;
  IF rebuilt_mirrors > 0 THEN
    RAISE WARNING 'alert-rule consolidation: rebuilt % alert_rule inline_settings mirrors', rebuilt_mirrors;
  END IF;

  -- 5. Postcondition: no rule may remain under a monitoring link. A leftover
  --    means a policy had monitoring-owned rules but no alert_rule link could
  --    be created for it, which would leave the resolver blind to those rules
  --    once Task 6 stops reading monitoring links.
  SELECT count(*) INTO remaining
  FROM public.config_policy_alert_rules r
  JOIN public.config_policy_feature_links ml ON ml.id = r.feature_link_id
  WHERE ml.feature_type = 'monitoring';
  IF remaining > 0 THEN
    RAISE EXCEPTION 'alert-rule consolidation postcondition failed: % rules still under monitoring links', remaining;
  END IF;
END $$;

-- @data-section-end
-- Everything above is the RLS-sensitive data migration; everything below is
-- function DDL that only the migration/owner role may execute.
-- alertRuleOwnershipMigration.integration.test.ts splits the file on this
-- sentinel so it can replay just the DML as the unprivileged `breeze_app`
-- role and prove the system-scope line above is load-bearing. Keep it.

-- ---------------------------------------------------------------------------
-- Partner-export materializer parity.
--
-- 2026-07-27-d renamed the canonical materializer created by 2026-07-26-b to
-- breeze_partner_export_policy_settings_pre_patch and wrapped it with a thin
-- breeze_partner_export_effective_policy_settings that only re-projects the
-- `patch` branch. The monitoring branch therefore lives in the _pre_patch
-- body, and that is what is replaced below — replacing the wrapper instead
-- would have to duplicate the patch projection. Everything else about the
-- 2026-07-26-b contract (signature, STABLE, search_path, per-feature
-- projections, `RETURN COALESCE(result, mirror)`) is preserved verbatim; only
-- the monitoring branch changes, from the 4-key shape to the canonical 2-key
-- {checkIntervalSeconds, watches}. The alert_rule branch is unchanged: it
-- already selects config_policy_alert_rules by the alert_rule link id, so
-- post-migration it serializes the merged metric + event_log set.
-- ---------------------------------------------------------------------------
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
