import { sql, type SQL } from 'drizzle-orm';
import { alertRules } from '../../db/schema';

/**
 * Built-in system anchor rules (#7206).
 *
 * "Reboot pending too long" and "Patch job failure" are per-org alert_rules on
 * an ownerless `is_built_in` alert_template (patchAlerts.ts
 * ensurePatchAlertRule). The maintenance reboot worker and the patch job
 * finalizer raise those alerts directly, not through the legacy evaluator, so
 * they keep alerting after the legacy-alerting retirement with no conversion.
 * Conversion refuses them (`unconvertible:built_in`, conversion/convert.ts) and
 * the retirement sweep skips them (`is_built_in = false`, retirementSweep.ts).
 *
 * This predicate keeps them out of every "needs conversion" surface so the
 * Monitors page never offers a Convert button that can only fail. It reads
 * alert_templates under the caller's RLS context, which is sound because the
 * alert_templates SELECT policy admits `is_built_in` rows for every caller.
 */
export function notSystemManagedRule(): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM alert_templates sm_t WHERE sm_t.id = ${alertRules.templateId} AND sm_t.is_built_in)`;
}

/**
 * The complement of `notSystemManagedRule`: only built-in system anchor rules.
 * Backs the Monitors "Built-in alerts" list (#7626), the one place an operator
 * can switch one of these rules off.
 */
export function systemManagedRule(): SQL {
  return sql`EXISTS (SELECT 1 FROM alert_templates sm_t WHERE sm_t.id = ${alertRules.templateId} AND sm_t.is_built_in)`;
}
