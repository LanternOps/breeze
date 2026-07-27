import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, eq, sql, desc, inArray, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { reports, reportRuns } from '../../db/schema';
import {
  authMiddleware,
  requirePermission,
  requireScope,
  type AuthContext,
} from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS } from '../../services/permissions';
import {
  getPagination,
  ensureOrgAccess,
  getReportWithOrgCheck,
  reportDefinitionMetadataProjection,
  tenantAuthorizedReportCondition,
} from './helpers';
import {
  decodeSiteScope,
  intersectSiteScopes,
  isSiteScopeSubset,
  persistedSiteScopeValues,
  reportDefinitionMultiOrgScopeSqlPredicate,
  reportDefinitionScopeSqlPredicate,
  reportRunScopeSqlPredicate,
  resolveRequestReportAuthority,
  resolveRequestReportAuthorityMap,
  unrestrictedReportDefinitionScopeSqlPredicate,
  type LiveSiteScopeV1,
  type PersistedSiteScopeColumns,
  type ReportAction,
} from '../../services/siteScope';
import { listReportsSchema, createReportSchema, updateReportSchema } from './schemas';

export const coreRoutes = new Hono();

coreRoutes.use('*', authMiddleware);

const REPORT_NOT_FOUND = { error: 'Report not found' } as const;

type DefinitionListScopeResult =
  | { ok: true; tenantCondition?: SQL<unknown>; definitionScopePredicate: SQL<unknown> }
  | { ok: false; error: string };

function liveScopeOf(
  result: Awaited<ReturnType<typeof resolveRequestReportAuthority>>,
): LiveSiteScopeV1 | null {
  if (!result.ok || result.authority.scope.kind === 'legacy_unscoped') {
    return null;
  }
  return result.authority.scope;
}

async function resolveDefinitionListScope(
  auth: AuthContext,
  explicitOrgId?: string,
): Promise<DefinitionListScopeResult> {
  const exactOrgId = auth.scope === 'organization'
    ? auth.orgId
    : explicitOrgId;

  if (auth.scope === 'organization' && !exactOrgId) {
    return { ok: false, error: 'Organization context required' };
  }

  if (exactOrgId) {
    const result = await resolveRequestReportAuthority(auth, exactOrgId, 'read');
    const scope = liveScopeOf(result);
    if (!scope) {
      return { ok: false, error: 'Access to this organization denied' };
    }
    return {
      ok: true,
      tenantCondition: eq(reports.orgId, exactOrgId),
      definitionScopePredicate: reportDefinitionScopeSqlPredicate(reports, scope),
    };
  }

  if (auth.scope === 'partner') {
    const orgIds = auth.accessibleOrgIds ?? [];
    const authorityMap = await resolveRequestReportAuthorityMap(
      auth,
      orgIds,
      'read',
    );
    const scopes: LiveSiteScopeV1[] = [];
    for (const result of authorityMap.values()) {
      const scope = liveScopeOf(result);
      if (scope) scopes.push(scope);
    }
    return {
      ok: true,
      tenantCondition: orgIds.length > 0
        ? inArray(reports.orgId, orgIds)
        : sql<unknown>`FALSE`,
      definitionScopePredicate: reportDefinitionMultiOrgScopeSqlPredicate(
        reports.orgId,
        reports,
        scopes,
      ),
    };
  }

  return {
    ok: true,
    definitionScopePredicate:
      unrestrictedReportDefinitionScopeSqlPredicate(reports),
  };
}

function persistedMetadataMatches(
  left: PersistedSiteScopeColumns,
  right: PersistedSiteScopeColumns,
): boolean {
  return (
    left.executionScopeVersion === right.executionScopeVersion &&
    left.executionScopeKind === right.executionScopeKind &&
    JSON.stringify(left.executionScopeSiteIds) ===
      JSON.stringify(right.executionScopeSiteIds) &&
    left.executionScopeUserId === right.executionScopeUserId &&
    left.executionScopeFingerprint === right.executionScopeFingerprint &&
    left.executionScopeCapturedAt?.getTime() ===
      right.executionScopeCapturedAt?.getTime()
  );
}

async function loadLockedDefinition(
  tx: Pick<typeof db, 'select'>,
  reportId: string,
  auth: AuthContext,
  action: Exclude<ReportAction, 'read' | 'export'>,
) {
  const [metadata] = await tx
    .select(reportDefinitionMetadataProjection)
    .from(reports)
    .where(tenantAuthorizedReportCondition(reportId, auth))
    .limit(1);
  if (!metadata) return null;

  const authorityResult = await resolveRequestReportAuthority(
    auth,
    metadata.orgId,
    action,
  );
  if (!authorityResult.ok) return null;
  const currentScope = liveScopeOf(authorityResult);
  if (!currentScope) return null;

  const definitionScopePredicate = reportDefinitionScopeSqlPredicate(
    reports,
    currentScope,
  );
  const [locked] = await tx
    .select(reportDefinitionMetadataProjection)
    .from(reports)
    .where(
      and(
        eq(reports.id, reportId),
        eq(reports.orgId, metadata.orgId),
        definitionScopePredicate,
      ),
    )
    .limit(1)
    .for('update');
  if (!locked) return null;

  try {
    const storedScope = decodeSiteScope(
      locked as PersistedSiteScopeColumns,
      locked.orgId,
    );
    if (!isSiteScopeSubset(storedScope, currentScope)) return null;
    return {
      metadata,
      locked,
      storedScope,
      currentScope,
      authority: authorityResult.authority,
      definitionScopePredicate,
    };
  } catch {
    return null;
  }
}

// GET /reports - List saved reports
coreRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.REPORTS_READ.resource, PERMISSIONS.REPORTS_READ.action),
  zValidator('query', listReportsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);
    const scopeResult = await resolveDefinitionListScope(auth, query.orgId);
    if (!scopeResult.ok) {
      return c.json({ error: scopeResult.error }, 403);
    }

    const definitionScopePredicate = scopeResult.definitionScopePredicate;
    const conditions: SQL<unknown>[] = [definitionScopePredicate];
    if (scopeResult.tenantCondition) {
      conditions.push(scopeResult.tenantCondition);
    }

    // Additional filters
    if (query.type) {
      conditions.push(eq(reports.type, query.type));
    }

    if (query.schedule) {
      conditions.push(eq(reports.schedule, query.schedule));
    }

    const whereCondition = and(...conditions);

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(reports)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get reports
    const reportsList = await db
      .select()
      .from(reports)
      .where(whereCondition)
      .orderBy(desc(reports.updatedAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: reportsList,
      pagination: { page, limit, total }
    });
  }
);

// GET /reports/templates - List the org's saved reports as reusable custom
// templates. Registered BEFORE /:id so the literal "templates" isn't treated as
// a report UUID — otherwise it falls through to /:id and Postgres rejects the
// `where id = 'templates'` cast with `invalid input syntax for type uuid` (500).
// The web (ReportTemplates.tsx) merges these rows with its curated defaults.
coreRoutes.get(
  '/templates',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.REPORTS_READ.resource, PERMISSIONS.REPORTS_READ.action),
  zValidator('query', listReportsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);
    const scopeResult = await resolveDefinitionListScope(auth, query.orgId);
    if (!scopeResult.ok) {
      return c.json({ error: scopeResult.error }, 403);
    }

    const definitionScopePredicate = scopeResult.definitionScopePredicate;
    const conditions: SQL<unknown>[] = [definitionScopePredicate];
    if (scopeResult.tenantCondition) {
      conditions.push(scopeResult.tenantCondition);
    }
    const whereCondition = and(...conditions);

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(reports)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    const templates = await db
      .select()
      .from(reports)
      .where(whereCondition)
      .orderBy(desc(reports.updatedAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: templates,
      pagination: { page, limit, total },
    });
  }
);

// GET /reports/:id - Get report config
coreRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.REPORTS_READ.resource, PERMISSIONS.REPORTS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const reportId = c.req.param('id')!;

    // Skip non-UUID sub-paths so they don't hit the `where id = $1` uuid cast.
    // 'templates' has its own handler above; listed here as defense-in-depth in
    // case route registration order ever changes.
    if (['runs', 'data', 'generate', 'templates'].includes(reportId)) {
      return c.notFound();
    }

    const report = await getReportWithOrgCheck(reportId, auth);
    if (!report) {
      return c.json({ error: 'Report not found' }, 404);
    }

    const authorityResult = await resolveRequestReportAuthority(
      auth,
      report.orgId,
      'read',
    );
    if (!authorityResult.ok || authorityResult.authority.scope.kind === 'legacy_unscoped') {
      return c.json({ error: 'Report not found' }, 404);
    }
    const runScopePredicate = reportRunScopeSqlPredicate(
      reportRuns,
      authorityResult.authority.scope,
    );

    // Get recent runs for this report
    const recentRuns = await db
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
        executionScopeVersion: reportRuns.executionScopeVersion,
        executionScopeKind: reportRuns.executionScopeKind,
        executionScopeSiteIds: reportRuns.executionScopeSiteIds,
        executionScopeUserId: reportRuns.executionScopeUserId,
        executionScopeFingerprint: reportRuns.executionScopeFingerprint,
        executionScopeCapturedAt: reportRuns.executionScopeCapturedAt,
      })
      .from(reportRuns)
      .where(and(eq(reportRuns.reportId, reportId), runScopePredicate))
      .orderBy(desc(reportRuns.createdAt))
      .limit(5);

    return c.json({
      ...report,
      recentRuns
    });
  }
);

// POST /reports - Create report definition
coreRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.REPORTS_WRITE.resource, PERMISSIONS.REPORTS_WRITE.action),
  zValidator('json', createReportSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    // Determine orgId
    let orgId = data.orgId;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgId = auth.orgId;
    } else if (auth.scope === 'partner') {
      if (!orgId) {
        const singleOrg = auth.accessibleOrgIds?.[0];
        if (auth.accessibleOrgIds?.length === 1 && singleOrg) {
          orgId = singleOrg;
        } else {
          return c.json({ error: 'orgId is required when partner has multiple organizations' }, 400);
        }
      }
      const hasAccess = await ensureOrgAccess(orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
    } else if (auth.scope === 'system' && !orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    const authorityResult = await resolveRequestReportAuthority(
      auth,
      orgId!,
      'write',
    );
    if (!authorityResult.ok) {
      return c.json({ error: 'Report scope is not authorized' }, 403);
    }
    const currentScope = liveScopeOf(authorityResult);
    if (!currentScope) {
      return c.json({ error: 'Report scope is not authorized' }, 403);
    }

    const scopeValues = persistedSiteScopeValues(authorityResult.authority);
    const [report] = await db
      .insert(reports)
      .values({
        orgId: orgId!,
        name: data.name,
        type: data.type,
        config: data.config,
        schedule: data.schedule,
        format: data.format,
        createdBy: auth.user.id,
        ...scopeValues,
      })
      .returning();

    writeRouteAudit(c, {
      orgId: report?.orgId ?? orgId ?? auth.orgId,
      action: 'report.create',
      resourceType: 'report',
      resourceId: report?.id,
      resourceName: report?.name,
      details: { type: report?.type, schedule: report?.schedule, format: report?.format }
    });

    return c.json(report, 201);
  }
);

// PUT /reports/:id - Update report
coreRoutes.put(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.REPORTS_WRITE.resource, PERMISSIONS.REPORTS_WRITE.action),
  zValidator('json', updateReportSchema),
  async (c) => {
    const auth = c.get('auth');
    const reportId = c.req.param('id')!;
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) updates.name = data.name;
    if (data.config !== undefined) updates.config = data.config;
    if (data.schedule !== undefined) updates.schedule = data.schedule;
    if (data.format !== undefined) updates.format = data.format;

    const mutation = await db.transaction(async (tx) => {
      const locked = await loadLockedDefinition(
        tx,
        reportId,
        auth,
        'write',
      );
      if (!locked) return null;

      const effectiveScope = intersectSiteScopes(
        locked.storedScope,
        locked.currentScope,
      );
      if (!effectiveScope) return null;

      const [updated] = await tx
        .update(reports)
        .set(updates)
        .where(
          and(
            eq(reports.id, reportId),
            eq(reports.orgId, locked.locked.orgId),
            locked.definitionScopePredicate,
          ),
        )
        .returning();
      if (!updated) return null;
      return { updated, locked: locked.locked };
    });

    if (!mutation) {
      return c.json(REPORT_NOT_FOUND, 404);
    }
    writeRouteAudit(c, {
      orgId: mutation.locked.orgId,
      action: 'report.update',
      resourceType: 'report',
      resourceId: mutation.updated.id,
      resourceName: mutation.updated.name,
      details: { changedFields: Object.keys(data) }
    });

    return c.json(mutation.updated);
  }
);

// POST /reports/:id/reauthorize - Explicitly replace stored scope provenance
coreRoutes.post(
  '/:id/reauthorize',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.REPORTS_WRITE.resource, PERMISSIONS.REPORTS_WRITE.action),
  async (c) => {
    const auth = c.get('auth');
    const reportId = c.req.param('id')!;

    const result = await db.transaction(async (tx) => {
      const locked = await loadLockedDefinition(
        tx,
        reportId,
        auth,
        'write',
      );
      if (!locked) return { kind: 'not_found' as const };

      if (
        locked.storedScope.kind === 'legacy_unscoped' &&
        locked.currentScope.kind !== 'unrestricted'
      ) {
        return { kind: 'not_found' as const };
      }

      if (
        !persistedMetadataMatches(
          locked.metadata as PersistedSiteScopeColumns,
          locked.locked as PersistedSiteScopeColumns,
        )
      ) {
        return { kind: 'changed' as const };
      }

      const scopeValues = persistedSiteScopeValues(locked.authority);
      const [updated] = await tx
        .update(reports)
        .set({
          ...scopeValues,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(reports.id, reportId),
            eq(reports.orgId, locked.locked.orgId),
            locked.definitionScopePredicate,
          ),
        )
        .returning();

      return updated
        ? { kind: 'updated' as const, updated }
        : { kind: 'changed' as const };
    });

    if (result.kind === 'not_found') {
      return c.json(REPORT_NOT_FOUND, 404);
    }
    if (result.kind === 'changed') {
      return c.json({ error: 'Report scope changed', code: 'SCOPE_CHANGED' }, 409);
    }

    writeRouteAudit(c, {
      orgId: result.updated.orgId,
      action: 'report.reauthorize',
      resourceType: 'report',
      resourceId: result.updated.id,
      resourceName: result.updated.name,
    });
    return c.json(result.updated);
  },
);

// DELETE /reports/:id - Delete report
coreRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.REPORTS_DELETE.resource, PERMISSIONS.REPORTS_DELETE.action),
  async (c) => {
    const auth = c.get('auth');
    const reportId = c.req.param('id')!;

    const deleted = await db.transaction(async (tx) => {
      const locked = await loadLockedDefinition(
        tx,
        reportId,
        auth,
        'delete',
      );
      if (!locked) return null;

      await tx
        .delete(reportRuns)
        .where(eq(reportRuns.reportId, reportId));

      const deletedRows = await tx
        .delete(reports)
        .where(
          and(
            eq(reports.id, reportId),
            eq(reports.orgId, locked.locked.orgId),
            locked.definitionScopePredicate,
          ),
        )
        .returning();
      if (deletedRows.length !== 1) {
        throw new Error('REPORT_DELETE_SCOPE_CHANGED');
      }
      return deletedRows[0]!;
    }).catch((error) => {
      if (
        error instanceof Error &&
        error.message === 'REPORT_DELETE_SCOPE_CHANGED'
      ) {
        return null;
      }
      throw error;
    });

    if (!deleted) {
      return c.json(REPORT_NOT_FOUND, 404);
    }
    writeRouteAudit(c, {
      orgId: deleted.orgId,
      action: 'report.delete',
      resourceType: 'report',
      resourceId: deleted.id,
      resourceName: deleted.name
    });

    return c.json({ success: true });
  }
);
