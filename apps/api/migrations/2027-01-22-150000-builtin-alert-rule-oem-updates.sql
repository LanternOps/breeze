-- #11068 (feature #11065 W03): add the vendor update alert source to the
-- built-in anchor rule identity. Same predicate as
-- 2026-12-03-120000-builtin-alert-rule-unique-index.sql, plus 'oem-updates'.
-- BUILT_IN_ALERT_RULE_SOURCES (services/builtInAlertRules.ts) must agree;
-- builtInAlertRuleUniqueness.integration.test.ts checks it.
--
-- Nothing can have written a rule with this source before this file ships, so
-- the duplicate collapse from the original migration has nothing to do here.
-- alert_rules is small (one row per rule, not per device), so a plain CREATE
-- INDEX inside the migration transaction is fine.
--
-- No row is written; the scope election keeps this file to the same shape as
-- the one it follows.

SELECT set_config('breeze.scope', 'system', true);

DROP INDEX IF EXISTS alert_rules_builtin_anchor_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS alert_rules_builtin_anchor_uidx
  ON alert_rules (org_id, name)
  WHERE org_id IS NOT NULL
    AND retired_at IS NULL
    AND managed_by_monitor_id IS NULL
    AND (override_settings->>'source') IN (
      'patch-job-finalizer',
      'maintenance-reboot-sweep',
      'policy-evaluation',
      'config-policy-compliance',
      'oem-updates'
    );
