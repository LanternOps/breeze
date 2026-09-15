/**
 * AI patch agent W04 (#5750) — is this alert PATCH work?
 *
 * `alerts` has no `category` column (`db/schema/alerts.ts`); the category
 * lives on `alert_templates`. Classification is therefore a join:
 *
 *   alerts.rule_id    → alert_rules.template_id → alert_templates.category
 *   alerts.monitor_id → monitor_definitions.kind
 *
 * BOTH legs are nullable (a rule-less sourced alert, a deleted rule, a
 * deleted monitor), so the classifier FAILS CLOSED: it answers `true` only on
 * a positive match — the template category is `PATCH_ALERT_CATEGORY`, or the
 * monitor kind is `patch_compliance` — and `false` for everything else,
 * including a null category, a missing row, a foreign org and a read error.
 * "Not patch work" means triage keeps the alert; an alert is never dropped
 * because neither agent claimed it.
 *
 * ONE org-pinned statement: `alerts.org_id` is the tenant boundary, and each
 * joined leg is additionally restricted to the org's own rows or partner-wide
 * / global rows (`org_id IS NULL`) so a stray FK can never pull another
 * tenant's template into the answer. Runs wherever the caller runs (the
 * automation worker's system context); the pin is in the WHERE, not RLS.
 */
import { sql } from 'drizzle-orm';
import { PATCH_ALERT_CATEGORY } from '@breeze/shared';
import { db } from '../../db';
import { captureException } from '../sentry';

export const PATCH_WORK_MONITOR_KIND = 'patch_compliance';

export interface AlertCategoryResolution {
  /** `alert_templates.category` reached through the rule, or null. */
  category: string | null;
  /** `monitor_definitions.kind` reached through `alerts.monitor_id`, or null. */
  monitorKind: string | null;
  /** The fail-closed verdict. */
  isPatchWork: boolean;
}

const NOT_RESOLVED: AlertCategoryResolution = { category: null, monitorKind: null, isPatchWork: false };

type Row = {
  rule_id: unknown;
  monitor_id: unknown;
  template_category: unknown;
  monitor_kind: unknown;
};

/**
 * Resolve the alert's template category and monitor kind in one org-pinned
 * read. Both fields feed `alertContext` for the `alertCategories` trigger
 * filter; `isPatchWork` is the routing verdict. Never throws.
 */
export async function resolveAlertCategory(alertId: string, orgId: string): Promise<AlertCategoryResolution> {
  let rows: Row[];
  try {
    rows = [...await db.execute<Row>(sql`
      SELECT a.rule_id, a.monitor_id, t.category AS template_category, m.kind AS monitor_kind
      FROM alerts a
      LEFT JOIN alert_rules r ON r.id = a.rule_id AND (r.org_id = ${orgId} OR r.org_id IS NULL)
      LEFT JOIN alert_templates t ON t.id = r.template_id AND (t.org_id = ${orgId} OR t.org_id IS NULL)
      LEFT JOIN monitor_definitions m ON m.id = a.monitor_id AND (m.org_id = ${orgId} OR m.org_id IS NULL)
      WHERE a.id = ${alertId} AND a.org_id = ${orgId}
      LIMIT 1
    `)];
  } catch (error) {
    // Fail closed, loudly enough to diagnose: a classifier outage routes
    // every patch alert to triage, which is safe, but should not be silent.
    console.warn(`[patchWorkClassifier] read failed for alert ${alertId} (org ${orgId}); treating as not patch work:`, error);
    captureException(error, undefined, { service: 'aiAgents', operation: 'resolveAlertCategory', alertId, orgId });
    return NOT_RESOLVED;
  }

  const row = rows[0];
  if (!row) return NOT_RESOLVED;

  const category = typeof row.template_category === 'string' ? row.template_category : null;
  const monitorKind = typeof row.monitor_kind === 'string' ? row.monitor_kind : null;
  if (row.rule_id === null && row.monitor_id === null) {
    console.debug(`[patchWorkClassifier] alert ${alertId} has neither rule_id nor monitor_id; not patch work`);
  } else if (category === null && monitorKind === null) {
    console.debug(`[patchWorkClassifier] alert ${alertId} legs resolved to no category/kind (deleted rule, template or monitor?); not patch work`);
  }

  const isPatchWork = category === PATCH_ALERT_CATEGORY || monitorKind === PATCH_WORK_MONITOR_KIND;
  return { category, monitorKind, isPatchWork };
}

/** The routing verdict alone. Fail-closed; never throws. */
export async function classifyAlertAsPatchWork(alertId: string, orgId: string): Promise<boolean> {
  return (await resolveAlertCategory(alertId, orgId)).isPatchWork;
}
