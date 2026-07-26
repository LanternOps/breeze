import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { reports, reportRuns } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import {
  decodeSiteScope,
  isSiteScopeSubset,
  reportDefinitionScopeSqlPredicate,
  reportRunScopeSqlPredicate,
  resolveRequestReportAuthority,
  type LiveSiteScopeV1,
  type PersistedSiteScopeColumns,
  type ReportAction,
  type ReportExecutionAuthority,
} from '../../services/siteScope';

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
  auth: AuthContext,
) {
  const metadataCondition = tenantAuthorizedReportCondition(reportId, auth);
  const [metadata] = await db
    .select(reportDefinitionMetadataProjection)
    .from(reports)
    .where(metadataCondition)
    .limit(1);

  if (!metadata) {
    return null;
  }

  const authorityResult = await resolveRequestReportAuthority(
    auth,
    metadata.orgId,
    'read',
  );
  if (!authorityResult.ok || authorityResult.authority.scope.kind === 'legacy_unscoped') {
    return null;
  }

  try {
    const storedScope = decodeSiteScope(
      metadata as unknown as PersistedSiteScopeColumns,
      metadata.orgId,
    );
    if (!isSiteScopeSubset(storedScope, authorityResult.authority.scope)) {
      return null;
    }
  } catch {
    return null;
  }

  const scopePredicate = reportDefinitionScopeSqlPredicate(
    reports,
    authorityResult.authority.scope,
  );
  const [report] = await db
    .select()
    .from(reports)
    .where(
      and(
        eq(reports.id, reportId),
        eq(reports.orgId, metadata.orgId),
        scopePredicate,
      ),
    )
    .limit(1);

  if (!report) return null;

  try {
    const storedScope = decodeSiteScope(
      report as unknown as PersistedSiteScopeColumns,
      report.orgId,
    );
    return isSiteScopeSubset(storedScope, authorityResult.authority.scope)
      ? report
      : null;
  } catch {
    return null;
  }
}

export const reportDefinitionMetadataProjection = {
  id: reports.id,
  orgId: reports.orgId,
  executionScopeVersion: reports.executionScopeVersion,
  executionScopeKind: reports.executionScopeKind,
  executionScopeSiteIds: reports.executionScopeSiteIds,
  executionScopeUserId: reports.executionScopeUserId,
  executionScopeFingerprint: reports.executionScopeFingerprint,
  executionScopeCapturedAt: reports.executionScopeCapturedAt,
};

export function tenantAuthorizedReportCondition(
  reportId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds'>,
): SQL<unknown> {
  const idCondition = eq(reports.id, reportId);

  if (auth.scope === 'organization') {
    return auth.orgId
      ? and(idCondition, eq(reports.orgId, auth.orgId))!
      : sql<unknown>`FALSE`;
  }

  if (auth.scope === 'partner') {
    const orgIds = auth.accessibleOrgIds ?? [];
    return orgIds.length > 0
      ? and(idCondition, inArray(reports.orgId, orgIds))!
      : sql<unknown>`FALSE`;
  }

  return idCondition;
}

export async function getReportRunWithOrgCheck(
  runId: string,
  auth: AuthContext,
  action: ReportAction,
) {
  const tenantConditions: SQL<unknown>[] = [eq(reportRuns.id, runId)];
  if (auth.scope === 'organization') {
    if (!auth.orgId) return null;
    tenantConditions.push(eq(reports.orgId, auth.orgId));
  } else if (auth.scope === 'partner') {
    const orgIds = auth.accessibleOrgIds ?? [];
    if (orgIds.length === 0) return null;
    tenantConditions.push(inArray(reports.orgId, orgIds));
  }

  const [metadata] = await db
    .select(reportRunMetadataProjection)
    .from(reportRuns)
    .innerJoin(reports, eq(reportRuns.reportId, reports.id))
    .where(and(...tenantConditions))
    .limit(1);

  if (!metadata) return null;

  const authorityResult = await resolveRequestReportAuthority(
    auth,
    metadata.orgId,
    action,
  );
  if (!authorityResult.ok || authorityResult.authority.scope.kind === 'legacy_unscoped') {
    return null;
  }

  try {
    const storedScope = decodeSiteScope(
      metadata as unknown as PersistedSiteScopeColumns,
      metadata.orgId,
    );
    if (!isSiteScopeSubset(storedScope, authorityResult.authority.scope)) {
      return null;
    }
  } catch {
    return null;
  }

  return {
    metadata,
    authority: authorityResult.authority as ReportExecutionAuthority & {
      scope: LiveSiteScopeV1;
    },
    runScopePredicate: reportRunScopeSqlPredicate(
      reportRuns,
      authorityResult.authority.scope,
    ),
  };
}

export const reportRunMetadataProjection = {
  id: reportRuns.id,
  reportId: reportRuns.reportId,
  orgId: reports.orgId,
  executionScopeVersion: reportRuns.executionScopeVersion,
  executionScopeKind: reportRuns.executionScopeKind,
  executionScopeSiteIds: reportRuns.executionScopeSiteIds,
  executionScopeUserId: reportRuns.executionScopeUserId,
  executionScopeFingerprint: reportRuns.executionScopeFingerprint,
  executionScopeCapturedAt: reportRuns.executionScopeCapturedAt,
};

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
