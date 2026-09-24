-- Alerting consolidation W05d — legacy alerting retirement, the SQL half.
-- Spec: docs/superpowers/specs/monitoring/2026-09-19-alerting-consolidation-design.md
--       (§Data model "Monitors" last bullet; §Conversion "Who runs it").
--
-- 1. Re-key config_policy_monitoring_settings from each policy's `monitoring`
--    link to its `monitors` link, creating the `monitors` link when absent.
--    Retired watches stay attached to the settings row (alert history); the
--    `monitors` assemble path never reads them.
-- 2. Mirror check_interval_seconds into the monitors link's inline_settings so
--    the JSONB mirror and the normalized row agree.
-- 3. Report what is still unretired. The boot-time TypeScript sweep
--    (services/monitors/conversion/retirementSweep.ts) converts or retires it;
--    SQL cannot — conversion compiles monitors and moves open alerts.
--
-- Idempotent. No inner BEGIN/COMMIT (autoMigrate wraps the file). DML below,
-- so elect system scope first: FORCE ROW LEVEL SECURITY binds the owner role
-- and a 'none'-scope UPDATE matches zero rows silently.
SELECT set_config('breeze.scope', 'system', true);

-- 1a. A `monitors` link for every policy that owns a settings row through a
--     `monitoring` link and has no `monitors` link. `items: []` is the W02
--     empty attachment set; `inheritance: 'cumulative'` is W05c1's default.
DO $$
DECLARE n integer;
BEGIN
  INSERT INTO config_policy_feature_links (config_policy_id, feature_type, feature_policy_id, inline_settings)
  SELECT l.config_policy_id,
         'monitors'::config_feature_type,
         NULL,
         jsonb_build_object(
           'items', '[]'::jsonb,
           'inheritance', 'cumulative',
           'checkIntervalSeconds', s.check_interval_seconds
         )
  FROM config_policy_feature_links l
  JOIN config_policy_monitoring_settings s ON s.feature_link_id = l.id
  WHERE l.feature_type = 'monitoring'
    AND NOT EXISTS (
      SELECT 1 FROM config_policy_feature_links m
      WHERE m.config_policy_id = l.config_policy_id AND m.feature_type = 'monitors'
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'W05d retirement: created % monitors link(s) for policies that only had a monitoring link', n;
  END IF;
END $$;

-- 1b. Re-key. feature_link_id is UNIQUE, so a monitors link that already owns
--     a row keeps it and the monitoring-keyed row is left where it is (1c
--     reports it; nothing is deleted — its watches may be unconverted).
DO $$
DECLARE n integer;
BEGIN
  UPDATE config_policy_monitoring_settings s
  SET feature_link_id = m.id,
      updated_at = now()
  FROM config_policy_feature_links l
  JOIN config_policy_feature_links m
    ON m.config_policy_id = l.config_policy_id AND m.feature_type = 'monitors'
  WHERE s.feature_link_id = l.id
    AND l.feature_type = 'monitoring'
    AND NOT EXISTS (
      SELECT 1 FROM config_policy_monitoring_settings s2 WHERE s2.feature_link_id = m.id
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'W05d retirement: re-keyed % monitoring settings row(s) onto the monitors link', n;
  END IF;
END $$;

-- 1c. Report (never delete) settings rows still keyed on a monitoring link.
--     Only reachable when a policy had a settings row under BOTH links.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
  FROM config_policy_monitoring_settings s
  JOIN config_policy_feature_links l ON l.id = s.feature_link_id
  WHERE l.feature_type = 'monitoring';
  IF n > 0 THEN
    RAISE WARNING 'W05d retirement: % settings row(s) still keyed on a monitoring link because the monitors link already owned one — the sweep converts their watches; the row itself is inert', n;
  END IF;
END $$;

-- 2. Mirror the normalized interval onto the monitors link's JSONB.
DO $$
DECLARE n integer;
BEGIN
  UPDATE config_policy_feature_links m
  SET inline_settings = COALESCE(m.inline_settings, '{}'::jsonb)
                        || jsonb_build_object('checkIntervalSeconds', s.check_interval_seconds),
      updated_at = now()
  FROM config_policy_monitoring_settings s
  WHERE s.feature_link_id = m.id
    AND m.feature_type = 'monitors'
    AND (m.inline_settings ->> 'checkIntervalSeconds') IS DISTINCT FROM s.check_interval_seconds::text;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'W05d retirement: mirrored checkIntervalSeconds onto % monitors link(s)', n;
  END IF;
END $$;

-- 3. What the W05c release left unconverted. Counts only; the boot sweep acts.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT 'config_policy_alert_rules' AS t, count(*) AS n
      FROM config_policy_alert_rules WHERE retired_at IS NULL
    UNION ALL
    SELECT 'config_policy_monitoring_watches', count(*)
      FROM config_policy_monitoring_watches WHERE retired_at IS NULL
    UNION ALL
    SELECT 'alert_rules (unmanaged)', count(*)
      FROM alert_rules WHERE retired_at IS NULL AND managed_by_monitor_id IS NULL
    UNION ALL
    SELECT 'alert_templates (unmanaged, custom)', count(*)
      FROM alert_templates WHERE retired_at IS NULL AND managed_by_monitor_id IS NULL AND is_built_in = false
  LOOP
    IF r.n > 0 THEN
      RAISE WARNING 'W05d retirement: % unretired row(s) in % — the boot-time sweep converts or retires them; the startup check reports whatever remains', r.n, r.t;
    END IF;
  END LOOP;
END $$;
