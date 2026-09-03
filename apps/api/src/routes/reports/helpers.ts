import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { portalBranding, reports, reportRuns } from '../../db/schema';
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

/**
 * #4562 W10 — a 409, not a 403, for the same reason as `system_managed_report`:
 * the caller's permissions are fine, it is the definition's OWNERSHIP that
 * makes the mutation impossible while the customer portal exposes it.
 */
export const PORTAL_SELF_SERVICE_REPORT = {
  error: 'portal_self_service_report',
} as const;

/**
 * #4562 W10 — is this definition the org's canonical customer-portal report
 * (`portal_self_service`) while that org currently exposes portal reports?
 *
 * While `portal_branding.enable_reports` is on, the portal lists EVERY
 * completed run of the definition and downloads it as the customer's own
 * report (`portalRunListPredicate` keys on org + marker + status only), so
 * the MSP must not rewrite its customer-safe config (PUT), generate a run
 * under a tech's — possibly site-restricted — authority (POST /:id/generate),
 * or delete it (DELETE). Once the flag is off the definition is an ordinary
 * MSP-owned report again and every mutation is allowed. Spec §8.2 / R10-3.
 *
 * Takes the transaction (or `db`) so the write routes evaluate it on the
 * same connection that holds the `FOR UPDATE` lock.
 */
export async function isPortalSelfServiceLocked(
  tx: Pick<typeof db, 'select'>,
  definition: { portalSelfService: boolean; orgId: string },
): Promise<boolean> {
  if (!definition.portalSelfService) return false;
  const [branding] = await tx
    .select({ enableReports: portalBranding.enableReports })
    .from(portalBranding)
    .where(eq(portalBranding.orgId, definition.orgId))
    .limit(1);
  return branding?.enableReports === true;
}

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
  // P2-3 (#4190): `type` rides along so the write routes can refuse a
  // system-managed definition from the SAME row they already read for scope
  // metadata — no extra query, and the refusal happens before any authority
  // resolution. See `isSystemManagedReportDefinition`.
  type: reports.type,
  executionScopeVersion: reports.executionScopeVersion,
  executionScopeKind: reports.executionScopeKind,
  executionScopeSiteIds: reports.executionScopeSiteIds,
  executionScopeUserId: reports.executionScopeUserId,
  executionScopeFingerprint: reports.executionScopeFingerprint,
  executionScopeCapturedAt: reports.executionScopeCapturedAt,
  executionScopePrincipalKind: reports.executionScopePrincipalKind,
  portalSelfService: reports.portalSelfService,
};

/**
 * P2-3 (#4190) — is this definition owned by the platform rather than by a
 * human?
 *
 * TWO independent signals, deliberately OR-ed. `execution_scope_principal_kind
 * = 'system'` is the provenance the scheduled-report worker also keys on;
 * `type = 'ai_org_narrative'` is the report's identity. Either alone would
 * leave a gap: a row whose principal was somehow rewritten to 'user' is still a
 * narrative nobody can regenerate, and a future system-managed report of an
 * ordinary type would still have no acting user to mutate on behalf of.
 *
 * Reads and downloads never consult this — a system-managed report exists to be
 * read. Only the four mutation routes do.
 */
export function isSystemManagedReportDefinition(
  row: { type: string | null; executionScopePrincipalKind: string | null },
): boolean {
  return row.executionScopePrincipalKind === 'system' || row.type === 'ai_org_narrative';
}

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
  executionScopePrincipalKind: reportRuns.executionScopePrincipalKind,
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
