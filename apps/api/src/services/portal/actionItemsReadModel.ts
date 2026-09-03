import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  fleetFindings,
  remediationSuggestions,
  securityPostureOrgSnapshots,
} from '../../db/schema';

export async function actionItemsTile(orgId: string, now: Date) {
  const [findingRows, suggestionRows, snapshotRows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(fleetFindings)
      .where(and(
        eq(fleetFindings.orgId, orgId),
        inArray(fleetFindings.status, ['open', 'acknowledged']),
      )),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(remediationSuggestions)
      .where(and(
        eq(remediationSuggestions.orgId, orgId),
        eq(remediationSuggestions.status, 'suggested'),
      )),
    db
      .select({ topIssues: securityPostureOrgSnapshots.topIssues })
      .from(securityPostureOrgSnapshots)
      .where(eq(securityPostureOrgSnapshots.orgId, orgId))
      .orderBy(desc(securityPostureOrgSnapshots.capturedAt))
      .limit(1),
  ]);

  const rawTopIssues = snapshotRows[0]?.topIssues;
  const topIssues: string[] = Array.isArray(rawTopIssues)
    ? rawTopIssues.flatMap((item) => {
        if (typeof item === 'string') return [item];
        if (!item || typeof item !== 'object') return [];
        const label = (item as Record<string, unknown>).label;
        return typeof label === 'string' ? [label] : [];
      }).slice(0, 3)
    : [];

  return {
    status: 'ok' as const,
    count:
      Number(findingRows[0]?.count ?? 0) +
      Number(suggestionRows[0]?.count ?? 0),
    topIssues,
    asOf: now.toISOString(),
  };
}
