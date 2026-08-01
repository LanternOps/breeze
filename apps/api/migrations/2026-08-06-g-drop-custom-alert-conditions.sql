-- Cleanup for the retired `custom` alert-condition type (#2948).
--
-- The `custom` type was offered by the alert-rule editors but never had a
-- handler registered in services/alertConditions. conditionRegistry.evaluate()
-- answers "Unknown condition type: custom" with passed=false, and a root-level
-- conditions ARRAY is evaluated as an implicit AND (services/alertConditions/
-- index.ts wraps it in {logic:'and'}), so any rule whose conditions are ALL
-- `custom` has never fired once and never can. PR #2946 dropped the type from
-- the config-policy editor and the shared write schema; this file removes what
-- is already stored, and the same PR-2948 change closes the remaining write
-- paths (POST/PUT /alerts/rules, POST/PATCH /alert-templates/rules, and
-- POST/PATCH /alert-templates).
--
-- Modelled on 2026-07-30-b-drop-never-firing-metric-alert-rules.sql, which did
-- the same job for metric conditions naming a column the evaluator has no entry
-- for. Same shape for the config-policy delete + mirror rebuild; this file
-- widens the match (that one required jsonb_array_length = 1) and adds a second
-- remedy for the standalone alert_rules table.
--
-- Scope — deliberately narrow. Only rows with NO evaluable condition at all are
-- touched:
--   * conditions is a non-empty ARRAY and EVERY element has type 'custom', or
--   * conditions is a single OBJECT with type 'custom'.
-- A rule that MIXES `custom` with a real condition is left alone. At the ARRAY
-- root such a rule is also dead (the root array is an implicit AND), but a
-- nested {logic:'or'} group inside it need not be, and this migration does not
-- descend into groups to find out. Both editors already flag the bad condition
-- for the tech, so a human decides. Guessing on a mixed rule risks silently
-- disabling working alerting; the unambiguous all-custom case does not.
-- Likewise NOT touched, for the same reason: a group-rooted rule
-- ({logic:'and', conditions:[{type:'custom'}]}), whose ->>'type' is NULL.
--
-- Two different remedies, because the two tables have different blast radii:
--   * config_policy_alert_rules rows are DELETED (as in the 07-30-b precedent),
--     skipping any row an `alerts` row references via the FK-less
--     alerts.config_policy_id, and rebuilding the inline_settings mirror.
--   * alert_rules rows are DEACTIVATED, never deleted. alerts.rule_id is a real
--     FK with no ON DELETE (NO ACTION), so a delete would raise an FK violation
--     outright — the opposite of the FK-less config_policy_id case above, where
--     the risk is stranding rather than failing. is_active=false is honest: the
--     rule already did nothing, and now the UI says so.
--     Re-enabling is gated by retiredConditionReactivationError()
--     (routes/alerts/helpers.ts) on both the PUT and the toggle route, so this
--     is not a state a tech can silently undo back into the original bug.
--
-- Idempotent: after a successful run there is no matching config-policy row
-- left to delete and no matching active alert_rules row left to deactivate, so
-- a replay touches nothing and the partner-export watermark stays stable.

-- alerts, alert_rules and alert_templates have FORCE ROW LEVEL SECURITY;
-- config_policy_alert_rules and config_policy_feature_links have RLS enabled but
-- not forced. The migration role is not guaranteed to be a superuser or the table
-- owner on managed Postgres, so without the system scope the DML below could
-- silently affect zero rows. Transaction-local; autoMigrate wraps the file.
-- The DO block below hard-fails if the scope did not take, precisely because a
-- silently-zero-row run is otherwise indistinguishable from a clean no-op.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  dropped_policy_rules integer := 0;
  kept_policy_rules integer := 0;
  dropped_names text[];
  affected_links uuid[];
  rebuilt_mirrors integer := 0;
  deactivated_rules integer := 0;
BEGIN
  -- Fail loudly if the system scope did not take. Every warning below is gated
  -- on a non-zero count, so a run that silently matched nothing because RLS hid
  -- the rows would otherwise be byte-identical in the logs to a clean no-op —
  -- the one failure mode the header warns about, made undetectable.
  IF current_setting('breeze.scope', true) IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'custom alert conditions: breeze.scope did not take (got %); RLS would silently hide rows',
      COALESCE(current_setting('breeze.scope', true), '<unset>');
  END IF;
  -- 1. config_policy_alert_rules: delete the all-custom rules.
  WITH all_custom AS (
    SELECT r.id, r.name, r.feature_link_id
    FROM public.config_policy_alert_rules r
    WHERE (
        jsonb_typeof(r.conditions) = 'array'
        -- `<> '[]'` rather than `jsonb_array_length(...) > 0`: identical here,
        -- but it cannot raise. jsonb_array_length() throws "cannot get array
        -- length of a non-array", and it is shielded from the object rows only
        -- by AND short-circuiting INSIDE this OR expression. Flatten the OR away
        -- in some future edit and the planner's order_qual_clauses is free to
        -- reorder by cost, at which point the call hard-fails the migration for
        -- any tenant holding object-form conditions.
        AND r.conditions <> '[]'::jsonb
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(r.conditions) e
          WHERE COALESCE(e->>'type', '') <> 'custom'
        )
      )
      OR (
        jsonb_typeof(r.conditions) = 'object'
        AND NOT (r.conditions ? 'logic')
        AND r.conditions->>'type' = 'custom'
      )
  ), dropped AS (
    DELETE FROM public.config_policy_alert_rules r
    USING all_custom n
    WHERE r.id = n.id
      AND NOT EXISTS (SELECT 1 FROM public.alerts a WHERE a.config_policy_id = n.id)
    RETURNING r.name, r.feature_link_id
  )
  SELECT
    (SELECT count(*) FROM dropped),
    (SELECT COALESCE(array_agg(DISTINCT name), ARRAY[]::text[]) FROM dropped),
    (SELECT COALESCE(array_agg(DISTINCT feature_link_id), ARRAY[]::uuid[]) FROM dropped),
    (SELECT count(*) FROM all_custom n
       WHERE EXISTS (SELECT 1 FROM public.alerts a WHERE a.config_policy_id = n.id))
    INTO dropped_policy_rules, dropped_names, affected_links, kept_policy_rules;

  IF dropped_policy_rules > 0 THEN
    RAISE WARNING 'custom alert conditions: dropped % config-policy rule(s) whose every condition was the retired ''custom'' type (no evaluator handler, never fired): %',
      dropped_policy_rules, array_to_string(dropped_names, ', ');
  END IF;
  IF kept_policy_rules > 0 THEN
    RAISE WARNING 'custom alert conditions: LEFT IN PLACE % config-policy rule(s) because existing alerts rows reference them. They are NOT deleted and will never fire until a tech replaces the condition',
      kept_policy_rules;
  END IF;

  -- 2. Rebuild the inline_settings items[] mirror for every alert_rule link that
  --    lost rows, matching the shape assembleInlineSettings() writes. Per-link
  --    correlated aggregate, not GROUP BY: a link whose ONLY rule was deleted
  --    has nothing left to group and would otherwise keep the stale mirror.
  --    The IS DISTINCT FROM guard keeps a replay from bumping updated_at.
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
      RAISE WARNING 'custom alert conditions: rebuilt % alert_rule inline_settings mirror(s)', rebuilt_mirrors;
    END IF;
  END IF;

  -- 3. alert_rules (the standalone Alerts > Rules path): deactivate, never
  --    delete. The effective conditions are the rule's override_settings
  --    ->'conditions' when present, else the template's own conditions —
  --    the same precedence formatAlertRuleResponse() and the evaluator use.
  WITH effective AS (
    SELECT
      r.id,
      r.name,
      -- NULLIF so a stored JSON `null` under `conditions` falls through to the
      -- template, matching the JS `overrides.conditions ?? template.conditions`
      -- precedence. Plain `->` yields jsonb-null (not SQL NULL), which COALESCE
      -- would keep, leaving the rule unmatched.
      COALESCE(NULLIF(r.override_settings->'conditions', 'null'::jsonb), t.conditions) AS conditions
    FROM public.alert_rules r
    JOIN public.alert_templates t ON t.id = r.template_id
    WHERE r.is_active
  )
  UPDATE public.alert_rules r
  SET is_active = false
  FROM effective e
  WHERE r.id = e.id
    AND (
      (
        jsonb_typeof(e.conditions) = 'array'
        -- See the note on the config-policy branch above: exception-safe form.
        AND e.conditions <> '[]'::jsonb
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(e.conditions) x
          WHERE COALESCE(x->>'type', '') <> 'custom'
        )
      )
      OR (
        jsonb_typeof(e.conditions) = 'object'
        AND NOT (e.conditions ? 'logic')
        AND e.conditions->>'type' = 'custom'
      )
    );
  GET DIAGNOSTICS deactivated_rules = ROW_COUNT;

  IF deactivated_rules > 0 THEN
    RAISE WARNING 'custom alert conditions: deactivated % alert_rules row(s) whose every effective condition was the retired ''custom'' type. Rows are kept because alerts.rule_id points at them; re-enable after switching to a supported condition',
      deactivated_rules;
  END IF;

  -- Unconditional, even when every counter is zero: CLAUDE.md requires the
  -- forensic count to be recorded on a clean run too, and this is the line that
  -- proves the migration executed under the right scope rather than no-oping.
  RAISE WARNING 'custom alert conditions: complete — policy_rules_dropped=% policy_rules_kept=% mirrors_rebuilt=% alert_rules_deactivated=%',
    dropped_policy_rules, kept_policy_rules, rebuilt_mirrors, deactivated_rules;
END $$;
