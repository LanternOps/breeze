import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, eq, sql, desc, inArray, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { reports, reportRuns } from '../../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { auditSensitiveRead } from '../../services/sensitiveReadAudit';
import { PERMISSIONS } from '../../services/permissions';
import {
  assertReportExecutionPreflight,
  generateReport,
  previousBaselineFor,
  UnexecutableReportScopeError,
  type ReportResult,
} from '../../services/reportGenerationService';
import { rowsToCsv, rowsToTsv } from '@breeze/shared';
import { getPagination, getReportWithOrgCheck, getReportRunWithOrgCheck } from './helpers';
import { downloadQuerySchema, listRunsSchema } from './schemas';
import {
  decodeSiteScope,
  intersectSiteScopes,
  isSiteScopeSubset,
  persistedSiteScopeValues,
  reportRunMultiOrgScopeSqlPredicate,
  reportRunScopeSqlPredicate,
  resolveRequestReportAuthority,
  resolveRequestReportAuthorityMap,
  siteScopeFingerprint,
  unrestrictedReportRunScopeSqlPredicate,
  type LiveSiteScopeV1,
  type PersistedSiteScopeColumns,
  type ReportExecutionAuthority,
} from '../../services/siteScope';

export const runsRoutes = new Hono();

runsRoutes.use('*', authMiddleware);

function asStoredReportResult(value: unknown): ReportResult | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.rows !== undefined && !Array.isArray(candidate.rows)) return null;
  if (
    candidate.summary !== undefined
    && (candidate.summary === null || typeof candidate.summary !== 'object' || Array.isArray(candidate.summary))
  ) {
    return null;
  }
  return candidate as ReportResult;
}

function hasMeaningfulReportContent(result: ReportResult): boolean {
  const hasRows = Array.isArray(result.rows) && result.rows.length > 0;
  const hasSummary = result.summary !== undefined && Object.keys(result.summary).length > 0;
  return hasRows || hasSummary;
}

// POST /reports/:id/generate - Generate report now
runsRoutes.post(
  '/:id/generate',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.REPORTS_WRITE.resource, PERMISSIONS.REPORTS_WRITE.action),
  async (c) => {
    const auth = c.get('auth');
    const reportId = c.req.param('id')!;

    const report = await getReportWithOrgCheck(reportId, auth);
    if (!report) {
      return c.json({ error: 'Report not found' }, 404);
    }

    const liveResult = await resolveRequestReportAuthority(
      auth,
      report.orgId,
      'read',
    );
    if (!liveResult.ok || liveResult.authority.scope.kind === 'legacy_unscoped') {
      return c.json({ error: 'Access to report scope denied' }, 403);
    }

    let executionAuthority: ReportExecutionAuthority;
    try {
      const persistedScope = decodeSiteScope(
        report as unknown as PersistedSiteScopeColumns,
        report.orgId,
      );
      const effectiveScope = intersectSiteScopes(
        persistedScope,
        liveResult.authority.scope,
      );
      if (
        !effectiveScope
        || effectiveScope.kind === 'legacy_unscoped'
        || (effectiveScope.kind === 'restricted' && effectiveScope.siteIds.length === 0)
      ) {
        return c.json({ error: 'Access to report scope denied' }, 403);
      }
      executionAuthority = {
        scope: effectiveScope,
        principalUserId: liveResult.authority.principalUserId,
        capturedAt: liveResult.authority.capturedAt,
        fingerprint: siteScopeFingerprint(effectiveScope),
      };
    } catch {
      return c.json({ error: 'Report not found' }, 404);
    }

    const config = (report.config ?? {}) as Record<string, unknown>;
    try {
      assertReportExecutionPreflight(report.orgId, config, executionAuthority);
    } catch (error) {
      if (error instanceof UnexecutableReportScopeError) {
        return c.json({ error: 'Access to report scope denied' }, 403);
      }
      throw error;
    }

    // Create a new report run
    const [run] = await db
      .insert(reportRuns)
      .values({
        reportId: report.id,
        status: 'pending',
        startedAt: new Date(),
        ...persistedSiteScopeValues(executionAuthority),
      })
      .returning();

    if (!run) {
      return c.json({ error: 'Failed to create report run' }, 500);
    }

    writeRouteAudit(c, {
      orgId: report.orgId,
      action: 'report.generate',
      resourceType: 'report_run',
      resourceId: run.id,
      resourceName: report.name,
      details: { reportId: report.id }
    });

    await db
      .update(reports)
      .set({ lastGeneratedAt: new Date(), updatedAt: new Date() })
      .where(eq(reports.id, reportId));

    try {
      const result = await generateReport(
        report.type,
        report.orgId,
        config,
        executionAuthority,
      );
      const previous = await previousBaselineFor(
        report.id,
        executionAuthority.fingerprint,
      );
      if (previous) result.previous = previous;
      const rowCount = result.rowCount ?? (Array.isArray(result.rows) ? result.rows.length : 0);
      await db
        .update(reportRuns)
        .set({
          status: 'completed',
          completedAt: new Date(),
          outputUrl: `/api/reports/runs/${run.id}/download`,
          result,
          rowCount
        })
        .where(eq(reportRuns.id, run.id));
      return c.json({ message: 'Report generated', runId: run.id, status: 'completed' });
    } catch (err) {
      await db
        .update(reportRuns)
        .set({
          status: 'failed',
          completedAt: new Date(),
          errorMessage: err instanceof Error ? err.message : 'Failed to generate report'
        })
        .where(eq(reportRuns.id, run.id));
      return c.json({ message: 'Report generation failed', runId: run.id, status: 'failed' }, 500);
    }
  }
);

// GET /reports/runs - List recent report runs
runsRoutes.get(
  '/runs',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.REPORTS_READ.resource, PERMISSIONS.REPORTS_READ.action),
  zValidator('query', listRunsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const conditions: SQL<unknown>[] = [];
    let runScopePredicate: SQL<unknown>;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      const result = await resolveRequestReportAuthority(auth, auth.orgId, 'read');
      if (!result.ok || result.authority.scope.kind === 'legacy_unscoped') {
        return c.json({ data: [], pagination: { page, limit, total: 0 } });
      }
      conditions.push(eq(reports.orgId, auth.orgId));
      runScopePredicate = reportRunScopeSqlPredicate(
        reportRuns,
        result.authority.scope,
      );
    } else if (auth.scope === 'partner') {
      const orgIds = auth.accessibleOrgIds ?? [];
      const authorityMap = await resolveRequestReportAuthorityMap(
        auth,
        orgIds,
        'read',
      );
      const scopes: LiveSiteScopeV1[] = [];
      for (const result of authorityMap.values()) {
        if (result.ok && result.authority.scope.kind !== 'legacy_unscoped') {
          scopes.push(result.authority.scope);
        }
      }
      conditions.push(
        orgIds.length > 0
          ? inArray(reports.orgId, orgIds)
          : sql<unknown>`FALSE`,
      );
      runScopePredicate = reportRunMultiOrgScopeSqlPredicate(
        reports.orgId,
        reportRuns,
        scopes,
      );
    } else {
      runScopePredicate = unrestrictedReportRunScopeSqlPredicate(reportRuns);
    }

    conditions.push(runScopePredicate);

    // Additional filters
    if (query.reportId) {
      conditions.push(eq(reportRuns.reportId, query.reportId));
    }

    if (query.status) {
      conditions.push(eq(reportRuns.status, query.status));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(reportRuns)
      .innerJoin(reports, eq(reportRuns.reportId, reports.id))
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get runs with report info
    const runsList = await db
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
        reportName: reports.name,
        reportType: reports.type
      })
      .from(reportRuns)
      .innerJoin(reports, eq(reportRuns.reportId, reports.id))
      .where(whereCondition)
      .orderBy(desc(reportRuns.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: runsList,
      pagination: { page, limit, total }
    });
  }
);

// GET /reports/runs/:id/download - Download a completed run's stored snapshot
runsRoutes.get(
  '/runs/:id/download',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.REPORTS_EXPORT.resource, PERMISSIONS.REPORTS_EXPORT.action),
  zValidator('query', downloadQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const runId = c.req.param('id')!;
    const { format: requestedFormat } = c.req.valid('query');

    const access = await getReportRunWithOrgCheck(runId, auth, 'export');
    if (!access) {
      return c.json({ error: 'Report run not found' }, 404);
    }

    const [row] = await db
      .select({
        id: reportRuns.id,
        reportId: reportRuns.reportId,
        orgId: reports.orgId,
        status: reportRuns.status,
        result: reportRuns.result,
        reportType: reports.type,
        reportName: reports.name,
        reportFormat: reports.format,
        executionScopeVersion: reportRuns.executionScopeVersion,
        executionScopeKind: reportRuns.executionScopeKind,
        executionScopeSiteIds: reportRuns.executionScopeSiteIds,
        executionScopeUserId: reportRuns.executionScopeUserId,
        executionScopeFingerprint: reportRuns.executionScopeFingerprint,
        executionScopeCapturedAt: reportRuns.executionScopeCapturedAt,
      })
      .from(reportRuns)
      .innerJoin(reports, eq(reportRuns.reportId, reports.id))
      .where(and(
        eq(reportRuns.id, runId),
        eq(reports.orgId, access.metadata.orgId),
        access.runScopePredicate,
      ))
      .limit(1);

    if (!row || !runPayloadMatchesAuthority(row, access.authority.scope)) {
      return c.json({ error: 'Report run not found' }, 404);
    }
    if (row.status !== 'completed') {
      return c.json({ error: 'Report run is not completed' }, 409);
    }

    const result = asStoredReportResult(row?.result);
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    const format = requestedFormat ?? row?.reportFormat ?? 'csv';
    const dateStr = new Date().toISOString().split('T')[0];
    const baseName = `${row?.reportType ?? 'report'}-report-${dateStr}`;

    // PDF / JSON: hand the snapshot to the client to render (avoids a server PDF engine).
    if (format === 'pdf' || format === 'json') {
      if (!result || !hasMeaningfulReportContent(result)) {
        return c.json({ error: 'Report run has no result data to download' }, 409);
      }
      const payload = { type: row?.reportType, format, data: result };
      const body = JSON.stringify(payload);
      c.header('Content-Type', 'application/json; charset=UTF-8');
      auditSensitiveRead(c, {
        action: 'report.run.download',
        orgId: row.orgId,
        resourceType: 'report_run',
        resourceId: runId,
        format,
        rowCount: rows.length,
        byteCount: Buffer.byteLength(body, 'utf8'),
      });
      return c.body(body);
    }

    if (rows.length === 0) {
      return c.json({ error: 'Report run has no tabular data to download' }, 409);
    }

    if (format === 'excel') {
      const body = rowsToTsv(rows);
      c.header('Content-Type', 'application/vnd.ms-excel');
      c.header('Content-Disposition', `attachment; filename="${baseName}.xls"`);
      auditSensitiveRead(c, {
        action: 'report.run.download',
        orgId: row.orgId,
        resourceType: 'report_run',
        resourceId: runId,
        format,
        rowCount: rows.length,
        byteCount: Buffer.byteLength(body, 'utf8'),
      });
      return c.body(body);
    }

    const body = rowsToCsv(rows);
    c.header('Content-Type', 'text/csv;charset=utf-8;');
    c.header('Content-Disposition', `attachment; filename="${baseName}.csv"`);
    auditSensitiveRead(c, {
      action: 'report.run.download',
      orgId: row.orgId,
      resourceType: 'report_run',
      resourceId: runId,
      format,
      rowCount: rows.length,
      byteCount: Buffer.byteLength(body, 'utf8'),
    });
    return c.body(body);
  }
);

// GET /reports/runs/:id - Get run with download URL
runsRoutes.get(
  '/runs/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.REPORTS_READ.resource, PERMISSIONS.REPORTS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const runId = c.req.param('id')!;

    const access = await getReportRunWithOrgCheck(runId, auth, 'read');
    if (!access) {
      return c.json({ error: 'Report run not found' }, 404);
    }

    const [run] = await db
      .select({
        id: reportRuns.id,
        reportId: reportRuns.reportId,
        orgId: reports.orgId,
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
        reportName: reports.name,
        reportType: reports.type,
        reportFormat: reports.format,
      })
      .from(reportRuns)
      .innerJoin(reports, eq(reportRuns.reportId, reports.id))
      .where(and(
        eq(reportRuns.id, runId),
        eq(reports.orgId, access.metadata.orgId),
        access.runScopePredicate,
      ))
      .limit(1);

    if (!run || !runPayloadMatchesAuthority(run, access.authority.scope)) {
      return c.json({ error: 'Report run not found' }, 404);
    }

    return c.json({
      ...run,
      report: {
        id: run.reportId,
        name: run.reportName,
        type: run.reportType,
        format: run.reportFormat,
      },
    });
  }
);

function runPayloadMatchesAuthority(
  row: { orgId: string },
  currentScope: LiveSiteScopeV1,
): boolean {
  try {
    return isSiteScopeSubset(
      decodeSiteScope(row as unknown as PersistedSiteScopeColumns, row.orgId),
      currentScope,
    );
  } catch {
    return false;
  }
}
