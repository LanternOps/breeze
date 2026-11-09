/**
 * Wisp W05b — which orgs of a grant ceiling an assessment may run in. Kept
 * out of assessment.ts so the wake coordinator (which must not pull the
 * run-admission graph into the event-subscriber closure) can use it.
 * `assessableOrgIds` is pure; `orgsWithOpenAlerts` (#10406) is one system
 * read of the alerts table.
 */
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { alerts } from '../../db/schema/alerts';
import { organizations } from '../../db/schema/orgs';
import type { GrantCeiling } from './grantAuthority';

/**
 * w00 A33: onboarding assesses at most this many orgs at once; the rest reach
 * the floor tick. Lives here (pure) so the chat seed (#10391) can state it
 * without importing the wake queue; wake.ts re-exports it.
 */
export const ONBOARDING_ORG_LIMIT = 10;

/**
 * The ceiling orgs an assessment may run in: those the grant reaches WHOLE.
 * The digest reads are org-wide (alerts, tickets, incidents, runs, intents of
 * the org), so an org the grantor reaches only through a site restriction —
 * ceiling-wide (`siteIds`) or from their membership (`orgTerms[org].siteIds`)
 * — is never assessed, the same rule W05a's concern reads apply. Exported for
 * the wake coordinator's candidate selection.
 */
export function assessableOrgIds(ceiling: GrantCeiling): Set<string> {
  if (ceiling.siteIds !== null) return new Set();
  return new Set([...ceiling.orgIds].filter((id) => (ceiling.orgTerms.get(id)?.siteIds ?? null) === null));
}

/** The open alert statuses: the same set as the first-look digest (assessment.ts loadOpenAlertRows). */
const OPEN_ALERT_STATUSES = ['active', 'acknowledged'] as const;

/**
 * #10406 — the orgs of `orgIds` with at least one open alert, worst open
 * severity first (the severity enum is declared critical → info, so `min` is
 * the worst), then the most open alerts, then the name; at most `limit`.
 * `orgIds` must already be inside the caller's ceiling (assessableOrgIds):
 * this is a system read, and the filter is the only scope it has.
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
