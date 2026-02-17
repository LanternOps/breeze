import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { reports, reportRuns } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';

export { getPagination } from '../../utils/pagination';

export async function ensureOrgAccess(
  orgId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>
) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    return auth.canAccessOrg(orgId);
  }

  // system scope has access to all
  return true;
}

export async function getReportWithOrgCheck(
  reportId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>
) {
  const [report] = await db
    .select()
    .from(reports)
    .where(eq(reports.id, reportId))
    .limit(1);

  if (!report) {
    return null;
  }

  const hasAccess = await ensureOrgAccess(report.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return report;
}

export async function getReportRunWithOrgCheck(
  runId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>
) {
  const [run] = await db
    .select({
      id: reportRuns.id,
      reportId: reportRuns.reportId,
      status: reportRuns.status,
      startedAt: reportRuns.startedAt,
      completedAt: reportRuns.completedAt,
      outputUrl: reportRuns.outputUrl,
      errorMessage: reportRuns.errorMessage,
      rowCount: reportRuns.rowCount,
      createdAt: reportRuns.createdAt,
      orgId: reports.orgId
    })
    .from(reportRuns)
    .innerJoin(reports, eq(reportRuns.reportId, reports.id))
    .where(eq(reportRuns.id, runId))
    .limit(1);

  if (!run) {
    return null;
  }

  const hasAccess = await ensureOrgAccess(run.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return run;
}

export async function getOrgIdsForAuth(
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds'>
): Promise<string[] | null> {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return null;
    return [auth.orgId];
  }

  if (auth.scope === 'partner') {
    return auth.accessibleOrgIds ?? [];
  }

  // system scope - return null to indicate no filtering needed
  return null;
}
