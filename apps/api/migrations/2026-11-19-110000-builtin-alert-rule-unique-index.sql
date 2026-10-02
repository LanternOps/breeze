-- #7650: built-in anchor alert rules exist at most once per org.
--
-- "Patch job failures", "Reboot pending too long", and the policy and
-- config-compliance bridge rules are created lazily on first fire by
-- find-then-insert (services/builtInAlertRules.ts). Nothing made that
-- identity unique, so two producers firing at once for the first time in an
-- org could each insert a rule. The Built-in alerts list (#7639) then shows
-- both, each with its own Active switch, and switching one off does not
-- silence the other.
--
-- The identity is (org_id, name) among live rows (retired_at IS NULL, not
-- monitor-managed) whose override_settings.source is one of the built-in
-- producer sources. It is deliberately NOT (org_id, name) across all rules:
-- historical operator-authored rules may legitimately share a name, and a
-- conversion revert un-retires those rows. Built-in rules are always
-- org-owned, so org_id IS NOT NULL is part of the predicate and partner-wide
-- rows (org_id NULL) are outside the index entirely.
--
-- Step 1 collapses existing duplicates onto the oldest row per identity:
--   a. a loser's open alert that would collide with another open alert under
--      alerts_open_rule_device_subject_uidx once re-pointed is resolved
--      (reason source_retired); the survivor's own open alert, else the
--      oldest, stays open;
--   b. alerts and ai_agent_fix_watches.rule_id (a plain copy of the alert's
--      rule id, used to classify recurrences) move to the survivor;
--   c. if any copy was switched off, the survivor is switched off — the
--      operator's last explicit action on that rule was "off";
--   d. the losers are deleted (monitor_conversion_outputs.source_rule_id is
--      ON DELETE SET NULL, and built-in rules are never converted anyway).
-- Step 2 adds the partial unique index.
--
-- Idempotent: on a clean table step 1 matches nothing and step 2 is
-- IF NOT EXISTS. alert_rules is small (one row per rule, not per device), so
-- a plain CREATE INDEX inside the migration transaction is fine.

SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  n_dupes integer;
  n_closed integer;
  n_alerts integer;
  n_watches integer;
  n_off integer;
  n_deleted integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  DROP TABLE IF EXISTS breeze_7650_rule_merge;
  CREATE TEMP TABLE breeze_7650_rule_merge ON COMMIT DROP AS
  SELECT id AS loser_id, survivor_id, is_active AS loser_active
  FROM (
    SELECT
      id,
      is_active,
      first_value(id) OVER w AS survivor_id,
      row_number() OVER w AS rn
    FROM alert_rules
    WHERE org_id IS NOT NULL
      AND retired_at IS NULL
      AND managed_by_monitor_id IS NULL
      AND override_settings->>'source' IN (
        'patch-job-finalizer',
        'maintenance-reboot-sweep',
        'policy-evaluation',
        'config-policy-compliance'
      )
    WINDOW w AS (PARTITION BY org_id, name ORDER BY created_at, id)
  ) ranked
  WHERE rn > 1;

  GET DIAGNOSTICS n_dupes = ROW_COUNT;
  IF n_dupes > 0 THEN
    RAISE WARNING '#7650: found % duplicate built-in alert rule(s) to merge', n_dupes;
  END IF;

  -- a. Resolve open alerts that would collide once re-pointed.
  UPDATE alerts a
  SET status = 'resolved',
      resolved_at = now(),
      resolution_reason = 'source_retired',
      resolution_note = 'Duplicate built-in alert rule merged (#7650)'
  FROM (
    SELECT
      al.id,
      row_number() OVER (
        PARTITION BY COALESCE(m.survivor_id, al.rule_id), al.device_id, COALESCE(al.subject_key, '')
        ORDER BY (m.loser_id IS NULL) DESC, al.triggered_at, al.id
      ) AS rn
    FROM alerts al
    LEFT JOIN breeze_7650_rule_merge m ON m.loser_id = al.rule_id
    WHERE al.status IN ('active', 'acknowledged', 'suppressed')
      AND (
        al.rule_id IN (SELECT loser_id FROM breeze_7650_rule_merge)
        OR al.rule_id IN (SELECT survivor_id FROM breeze_7650_rule_merge)
      )
  ) dup
  WHERE a.id = dup.id
    AND dup.rn > 1;
  GET DIAGNOSTICS n_closed = ROW_COUNT;
  IF n_closed > 0 THEN
    RAISE WARNING '#7650: resolved % open alert(s) duplicated across merged rules', n_closed;
  END IF;

  -- b. Re-point references to the survivor.
  UPDATE alerts a
  SET rule_id = m.survivor_id
  FROM breeze_7650_rule_merge m
  WHERE a.rule_id = m.loser_id;
  GET DIAGNOSTICS n_alerts = ROW_COUNT;
  IF n_alerts > 0 THEN
    RAISE WARNING '#7650: re-pointed % alert(s) to the surviving rule', n_alerts;
  END IF;

  UPDATE ai_agent_fix_watches w
  SET rule_id = m.survivor_id
  FROM breeze_7650_rule_merge m
  WHERE w.rule_id = m.loser_id;
  GET DIAGNOSTICS n_watches = ROW_COUNT;
  IF n_watches > 0 THEN
    RAISE WARNING '#7650: re-pointed % ai_agent_fix_watches row(s) to the surviving rule', n_watches;
  END IF;

  -- c. "Off" wins: an operator who switched any copy off meant the rule.
  UPDATE alert_rules r
  SET is_active = false
  WHERE r.is_active
    AND r.id IN (SELECT survivor_id FROM breeze_7650_rule_merge WHERE NOT loser_active);
  GET DIAGNOSTICS n_off = ROW_COUNT;
  IF n_off > 0 THEN
    RAISE WARNING '#7650: switched off % surviving rule(s) whose duplicate was off', n_off;
  END IF;

  -- d. Drop the losers.
  DELETE FROM alert_rules r
  USING breeze_7650_rule_merge m
  WHERE r.id = m.loser_id;
  GET DIAGNOSTICS n_deleted = ROW_COUNT;
  IF n_deleted > 0 THEN
    RAISE WARNING '#7650: deleted % duplicate built-in alert rule(s)', n_deleted;
  END IF;

  DROP TABLE breeze_7650_rule_merge;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS alert_rules_builtin_anchor_uidx
  ON alert_rules (org_id, name)
  WHERE org_id IS NOT NULL
    AND retired_at IS NULL
    AND managed_by_monitor_id IS NULL
    AND (override_settings->>'source') IN (
      'patch-job-finalizer',
      'maintenance-reboot-sweep',
      'policy-evaluation',
      'config-policy-compliance'
    );
