/**
 * #10406 — which orgs an on-demand Wisp assessment covers when the person asks
 * for "the orgs with open alerts". One system read of the alerts table, kept
 * out of assessableOrgs.ts so that module stays pure (aiGuardrails imports
 * ONBOARDING_ORG_LIMIT from it; aiGuardrails.imports.contract.test.ts).
 */
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { alerts } from '../../db/schema/alerts';
import { organizations } from '../../db/schema/orgs';

/** The open alert statuses: the same set as the first-look digest (assessment.ts loadOpenAlertRows). */
const OPEN_ALERT_STATUSES = ['active', 'acknowledged'] as const;

/**
 * The orgs of `orgIds` with at least one open alert, worst open severity
 * first (the severity enum is declared critical → info, so `min` is the
 * worst), then the most open alerts, then the name; at most `limit`.
 * `orgIds` must already be the orgs the caller may assess (the launcher
 * passes only orgs inside the grant ceiling that the person can reach): this
 * is a system read, and the filter is the only scope it has.
 */
export async function orgsWithOpenAlerts(
  orgIds: readonly string[],
  limit: number,
): Promise<Array<{ orgId: string; orgName: string }>> {
  if (orgIds.length === 0 || limit <= 0) return [];
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select({ orgId: alerts.orgId, orgName: organizations.name })
    .from(alerts)
    .innerJoin(organizations, eq(organizations.id, alerts.orgId))
    .where(and(inArray(alerts.orgId, [...orgIds]), inArray(alerts.status, [...OPEN_ALERT_STATUSES])))
    .groupBy(alerts.orgId, organizations.name)
    .orderBy(asc(sql`min(${alerts.severity})`), desc(count(alerts.id)), asc(organizations.name), asc(alerts.orgId))
    .limit(limit), 'wisp.orgsWithOpenAlerts'));
  return rows.map((r) => ({ orgId: r.orgId, orgName: r.orgName }));
}
