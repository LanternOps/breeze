/**
 * The Fleet Design report LIST query, moved verbatim out of
 * `routes/fleetDesign.ts` (full-control W10, #6780) so the REST route and the
 * `list_fleet_designs` tool share one copy of the rules. The detail read is
 * `loadFleetDesignReport` (`aiAgents/fleetDesignReport.ts`).
 */
import { and, desc, eq } from 'drizzle-orm';
import type { FleetDesignReportSummary } from '@breeze/shared';
import { db } from '../../db';
import { reportRuns, reports } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { FLEET_DESIGN_REPORT_TYPE } from '../aiAgents/fleetDesignReport';

/**
 * Counts sections out of a stored `FleetDesignReportSummary` for the list/
 * detail projections below. Every field on the summary is optional
 * (persisted jsonb, old snapshots must still render) — an incomplete or
 * pre-outcome row projects to zero counts rather than throwing.
 */
export function sectionCounts(summary: FleetDesignReportSummary | null | undefined) {
  const sections = summary?.fleetDesign?.outcome?.sections;
  const watchCount = sections?.monitoring.reduce((n, m) => n + m.watches.length, 0) ?? 0;
  const ruleCount = sections?.monitoring.reduce((n, m) => n + m.alertRules.length, 0) ?? 0;
  return {
    functionCount: sections?.functions.length ?? 0,
    watchCount,
    ruleCount,
    evidenceTruncated: summary?.fleetDesign?.evidenceTruncated ?? false,
    generatedAt: summary?.fleetDesign?.generatedAt ?? null,
    runId: summary?.fleetDesign?.runId ?? null,
  };
}

export interface FleetDesignListItem {
  reportRunId: string;
  reportId: string;
  orgId: string;
  generatedAt: string | null;
  runId: string | null;
  functionCount: number;
  watchCount: number;
  ruleCount: number;
  evidenceTruncated: boolean;
}

/** `GET /ai/fleet-design`: completed designs in the caller's orgs (optionally one org), newest first, at most 100. */
export async function listFleetDesigns(auth: AuthContext, queryOrgId: string | undefined): Promise<FleetDesignListItem[]> {
  if (queryOrgId && !auth.canAccessOrg(queryOrgId)) return [];

  const conditions = [eq(reports.type, FLEET_DESIGN_REPORT_TYPE), eq(reportRuns.status, 'completed')];
  const orgCond = auth.orgCondition(reports.orgId);
  if (orgCond) conditions.push(orgCond);
  if (queryOrgId) conditions.push(eq(reports.orgId, queryOrgId));

  const rows = await db
    .select({
      reportRunId: reportRuns.id,
      reportId: reports.id,
      orgId: reports.orgId,
      summary: reportRuns.result,
    })
    .from(reportRuns)
    .innerJoin(reports, eq(reportRuns.reportId, reports.id))
    .where(and(...conditions))
    .orderBy(desc(reportRuns.completedAt))
    .limit(100);

  return rows.map((row) => {
    const counts = sectionCounts((row.summary as { summary?: FleetDesignReportSummary } | null)?.summary);
    return {
      reportRunId: row.reportRunId,
      reportId: row.reportId,
      orgId: row.orgId,
      generatedAt: counts.generatedAt,
      runId: counts.runId,
      functionCount: counts.functionCount,
      watchCount: counts.watchCount,
      ruleCount: counts.ruleCount,
      evidenceTruncated: counts.evidenceTruncated,
    };
  });
}
