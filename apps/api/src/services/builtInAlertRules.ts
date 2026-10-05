import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import { alertRules } from '../db/schema';

/**
 * Built-in anchor alert rules (#7650).
 *
 * Breeze creates these per-org rules itself, lazily, the first time a producer
 * fires in an org: patch job failures and reboot pending (patchAlerts.ts), and
 * one rule per policy / compliance rule from the two policy bridges
 * (policyAlertBridge.ts, configComplianceAlertBridge.ts). Each is identified by
 * `(org_id, name)` among live rows whose `override_settings.source` is one of
 * these values.
 *
 * The partial unique index `alert_rules_builtin_anchor_uidx`
 * (migrations/2026-12-03-120000-builtin-alert-rule-unique-index.sql) enforces
 * that identity, and its predicate lists these same strings. A new built-in
 * producer must add its source here AND ship a migration that recreates the
 * index with it, or concurrent first fire can create the rule twice again.
 * builtInAlertRuleUniqueness.integration.test.ts checks the two agree.
 */
export const BUILT_IN_ALERT_RULE_SOURCES = [
  'patch-job-finalizer',
  'maintenance-reboot-sweep',
  'policy-evaluation',
  'config-policy-compliance',
] as const;

export type BuiltInAlertRuleSource = (typeof BUILT_IN_ALERT_RULE_SOURCES)[number];

/**
 * Insert a built-in org rule, or return the live one another caller created
 * first. The caller's own find-first lookup stays the fast path; this replaces
 * only its insert. Two first fires racing past that lookup both reach here:
 * one insert wins, the other waits on the unique index, does nothing once the
 * winner commits, and reads the winner's row back (a new statement under READ
 * COMMITTED sees the committed row).
 */
export async function insertBuiltInAlertRule(values: {
  orgId: string;
  templateId: string;
  name: string;
  overrideSettings: { source: BuiltInAlertRuleSource } & Record<string, unknown>;
}): Promise<string> {
  const [created] = await db
    .insert(alertRules)
    .values({
      orgId: values.orgId,
      templateId: values.templateId,
      name: values.name,
      targetType: 'org',
      targetId: values.orgId,
      isActive: true,
      overrideSettings: values.overrideSettings,
    })
    // No conflict target: the arbiter is alert_rules_builtin_anchor_uidx, the
    // only unique index this row can hit (the id is fresh and
    // managed_by_monitor_id is NULL). A target would have to restate the
    // index's partial predicate exactly or Postgres rejects the statement.
    .onConflictDoNothing()
    .returning({ id: alertRules.id });
  if (created) return created.id;

  const [existing] = await db
    .select({ id: alertRules.id })
    .from(alertRules)
    .where(and(
      eq(alertRules.orgId, values.orgId),
      eq(alertRules.name, values.name),
      isNull(alertRules.retiredAt),
      isNull(alertRules.managedByMonitorId),
      sql`${alertRules.overrideSettings}->>'source' = ${values.overrideSettings.source}`,
    ))
    .orderBy(asc(alertRules.createdAt))
    .limit(1);
  if (!existing) {
    throw new Error(
      `[builtInAlertRules] insert of "${values.name}" for org ${values.orgId} conflicted, `
      + 'but no live built-in rule with that name was found',
    );
  }
  return existing.id;
}
