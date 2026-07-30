-- Forward fix on top of 2026-07-30-alert-rule-ownership-consolidation.sql.
--
-- Why a separate file: the consolidation migration shipped mid-review, so the
-- never-firing-rule cleanup it was reviewed to carry cannot be folded back into
-- it — `breeze_migrations` keys applied files by checksum, and editing a shipped
-- migration is forbidden. This runs as its own step instead. The filename sorts
-- immediately after the consolidation (`alert` < `b` under localeCompare) and is
-- independent of 2026-07-30-serialize-bulk-config-assignment-target-moves.sql,
-- which touches unrelated tables.
--
-- What it removes: the pre-consolidation Monitoring tab offered a "Network
-- Usage" metric option, but the threshold evaluator's METRIC_NAME_MAP
-- (services/alertConditions/utils.ts) has no `network` column to compare
-- against, so normalizeMetricName() returns NULL and such a rule has never
-- fired once. The same is true of a metric condition carrying no metric name at
-- all — normalizeMetricName(undefined) is likewise NULL. Left in place these
-- rows render on the Alerts tab as a permanently dead rule whose metric the
-- editor cannot represent, and whose next save the write schema rejects.
--
-- Retargeted from the original step-0 design: that version scoped the delete to
-- rows still hanging off a MONITORING feature link, because it ran before the
-- consolidation moved them. On any database that has already applied the
-- consolidation those same rows now sit under an ALERT_RULE link, so this file
-- matches on the condition shape under ANY feature link instead. That is also
-- the right net for rules the AI tool or a direct API write created straight
-- onto the alert_rule link.
--
-- What it never removes:
--   * Multi-condition rules. One bad condition among valid ones still fires on
--     the valid ones, so the row stays intact and AlertRuleTab flags the bad
--     condition for the tech instead of the migration guessing.
--   * Rules an `alerts` row references. alerts.config_policy_id stores the rule
--     id as a plain uuid with no FK, so deleting one would orphan alert
--     provenance. Those rows are counted and warned about, and left alone.
--
-- Idempotent: after a successful run no matching deletable row remains, so the
-- delete finds nothing and the mirror rebuild is skipped entirely (updated_at
-- is not bumped, which keeps the partner-export watermark stable on replay).

-- Run with system scope: config_policy_alert_rules / config_policy_feature_links
-- / alerts all have FORCE ROW LEVEL SECURITY, and the migration role is not
-- guaranteed to be a superuser on managed Postgres. Without this the DML below
-- would silently touch zero rows (transaction-local; autoMigrate wraps the file).
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  dropped_unfirable integer := 0;
  kept_unfirable integer := 0;
  dropped_names text[];
  affected_links uuid[];
  rebuilt_mirrors integer := 0;
BEGIN
  -- 1. Delete the never-firing rules, capturing their names (for the forensic
  --    trail) and their feature links (so step 2 knows which mirrors to rebuild).
  --
  --    The correlated EXISTS against `alerts` runs once per candidate row, so an
  --    empty candidate set — the steady state after this migration has run —
  --    never touches that table at all.
  WITH never_firing AS (
    SELECT r.id, r.name, r.feature_link_id
    FROM public.config_policy_alert_rules r
    WHERE jsonb_typeof(r.conditions) = 'array'
      AND jsonb_array_length(r.conditions) = 1
      AND jsonb_typeof(r.conditions->0) = 'object'
      -- 'threshold' is the evaluator's own name for the metric handler
      -- (handlers/threshold.ts declares it with aliases ['metric']).
      AND r.conditions->0->>'type' IN ('metric', 'threshold')
      -- A missing or JSON-null metric collapses to '' and is caught here too:
      -- it is dead by exactly the same mechanism as metric:'network'.
      AND COALESCE(r.conditions->0->>'metric', '') NOT IN (
        'cpu', 'cpuPercent',
        'ram', 'ramPercent', 'memory',
        'disk', 'diskPercent',
        'processCount', 'processes'
      )
  ), dropped AS (
    DELETE FROM public.config_policy_alert_rules r
    USING never_firing n
    WHERE r.id = n.id
      AND NOT EXISTS (SELECT 1 FROM public.alerts a WHERE a.config_policy_id = n.id)
    RETURNING r.name, r.feature_link_id
  )
  SELECT
    (SELECT count(*) FROM dropped),
    (SELECT COALESCE(array_agg(DISTINCT name), ARRAY[]::text[]) FROM dropped),
    (SELECT COALESCE(array_agg(DISTINCT feature_link_id), ARRAY[]::uuid[]) FROM dropped),
    (SELECT count(*) FROM never_firing n
       WHERE EXISTS (SELECT 1 FROM public.alerts a WHERE a.config_policy_id = n.id))
    INTO dropped_unfirable, dropped_names, affected_links, kept_unfirable;

  IF dropped_unfirable > 0 THEN
    RAISE WARNING 'never-firing alert rules: dropped % rule(s) whose only condition was a metric condition outside the evaluator domain (metric missing or not one of cpu/ram/memory/disk/processCount): %',
      dropped_unfirable, array_to_string(dropped_names, ', ');
  END IF;
  IF kept_unfirable > 0 THEN
    RAISE WARNING 'never-firing alert rules: LEFT IN PLACE % rule(s) because existing alerts rows reference them. They are NOT deleted; they simply remain and will never fire until a tech replaces the condition',
      kept_unfirable;
  END IF;

  -- 2. Rebuild the inline_settings items[] mirror for every alert_rule link that
  --    lost rows, matching the shape assembleInlineSettings() writes (and the
  --    consolidation migration's own step 4b).
  --
  --    Deliberately a per-link correlated aggregate rather than a
  --    `GROUP BY feature_link_id` over the rules table: a link whose ONLY rule
  --    was just deleted has no rows left to group, so the grouped form would
  --    skip it and strand the deleted rule in the mirror forever.
  --
  --    The IS DISTINCT FROM guard means only links whose mirror actually changes
  --    have updated_at bumped, so a replay is a true no-op.
  IF array_length(affected_links, 1) IS NOT NULL THEN
    UPDATE public.config_policy_feature_links al
    SET inline_settings = jsonb_build_object('items', COALESCE(sub.items, '[]'::jsonb)),
        updated_at = now()
    FROM (
      SELECT l.id AS feature_link_id, (
        SELECT jsonb_agg(jsonb_build_object(
          'name', name, 'severity', severity, 'conditions', conditions,
          'cooldownMinutes', cooldown_minutes, 'autoResolve', auto_resolve,
          'autoResolveConditions', auto_resolve_conditions,
          'titleTemplate', title_template, 'messageTemplate', message_template,
          'sortOrder', sort_order
        ) ORDER BY sort_order, created_at, id)
        FROM public.config_policy_alert_rules r
        WHERE r.feature_link_id = l.id
      ) AS items
      FROM public.config_policy_feature_links l
      WHERE l.id = ANY(affected_links)
    ) sub
    WHERE sub.feature_link_id = al.id
      AND al.feature_type = 'alert_rule'
      AND al.inline_settings IS DISTINCT FROM jsonb_build_object('items', COALESCE(sub.items, '[]'::jsonb));
    GET DIAGNOSTICS rebuilt_mirrors = ROW_COUNT;
    IF rebuilt_mirrors > 0 THEN
      RAISE WARNING 'never-firing alert rules: rebuilt % alert_rule inline_settings mirror(s)', rebuilt_mirrors;
    END IF;
  END IF;
END $$;
