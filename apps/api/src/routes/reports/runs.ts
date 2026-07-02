import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, sql, desc, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { reports, reportRuns } from '../../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS } from '../../services/permissions';
import { generateReport, previousBaselineFor, siteScopeRequestAllowed, type ReportResult } from '../../services/reportGenerationService';
import { rowsToCsv, rowsToTsv } from '@breeze/shared';
import { getPagination, ensureOrgAccess, getReportWithOrgCheck, getReportRunWithOrgCheck } from './helpers';
import { downloadQuerySchema, listRunsSchema } from './schemas';
import type { UserPermissions } from '../../services/permissions';

export const runsRoutes = new Hono();

runsRoutes.use('*', authMiddleware);

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

    // Create a new report run
    const [run] = await db
      .insert(reportRuns)
      .values({
        reportId: report.id,
        status: 'pending',
        startedAt: new Date()
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

    const perms = c.get('permissions') as UserPermissions | undefined;
    const config = (report.config ?? {}) as Record<string, unknown>;

    if (!(await siteScopeRequestAllowed(report.orgId, config, perms))) {
      await db
        .update(reportRuns)
        .set({ status: 'failed', completedAt: new Date(), errorMessage: 'Access to report scope denied' })
        .where(eq(reportRuns.id, run.id));
      return c.json({ error: 'Access to report scope denied' }, 403);
    }

    await db
      .update(reports)
      .set({ lastGeneratedAt: new Date(), updatedAt: new Date() })
      .where(eq(reports.id, reportId));

    try {
      const result = await generateReport(report.type, report.orgId, config, perms);
      const previous = await previousBaselineFor(report.id);
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

    // Build conditions array
    const conditions: ReturnType<typeof eq>[] = [];

    // Filter by org access based on scope
    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      conditions.push(eq(reports.orgId, auth.orgId));
    } else if (auth.scope === 'partner') {
      const orgIds = auth.accessibleOrgIds ?? [];
      if (orgIds.length === 0) {
        return c.json({
          data: [],
          pagination: { page, limit, total: 0 }
        });
      }
      conditions.push(inArray(reports.orgId, orgIds));
    }

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

    const run = await getReportRunWithOrgCheck(runId, auth);
    if (!run) {
      return c.json({ error: 'Report run not found' }, 404);
    }
    if (run.status !== 'completed') {
      return c.json({ error: 'Report run is not completed' }, 409);
    }

    const [row] = await db
      .select({
        result: reportRuns.result,
        reportType: reports.type,
        reportName: reports.name,
        reportFormat: reports.format
      })
      .from(reportRuns)
      .innerJoin(reports, eq(reportRuns.reportId, reports.id))
      .where(eq(reportRuns.id, runId))
      .limit(1);

    const result = (row?.result ?? null) as ReportResult | null;
    const rows = Array.isArray(result?.rows) ? (result!.rows as unknown[]) : [];
    const format = requestedFormat ?? row?.reportFormat ?? 'csv';
    const dateStr = new Date().toISOString().split('T')[0];
    const baseName = `${row?.reportType ?? 'report'}-report-${dateStr}`;

    // PDF / JSON: hand the snapshot to the client to render (avoids a server PDF engine).
    if (format === 'pdf' || format === 'json') {
      return c.json({ type: row?.reportType, format, data: result });
    }

    if (rows.length === 0) {
      return c.json({ error: 'Report run has no tabular data to download' }, 409);
    }

    if (format === 'excel') {
      c.header('Content-Type', 'application/vnd.ms-excel');
      c.header('Content-Disposition', `attachment; filename="${baseName}.xls"`);
      return c.body(rowsToTsv(rows));
    }

    c.header('Content-Type', 'text/csv;charset=utf-8;');
    c.header('Content-Disposition', `attachment; filename="${baseName}.csv"`);
    return c.body(rowsToCsv(rows));
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

    const run = await getReportRunWithOrgCheck(runId, auth);
    if (!run) {
      return c.json({ error: 'Report run not found' }, 404);
    }

    // Get the associated report
    const [report] = await db
      .select()
      .from(reports)
      .where(eq(reports.id, run.reportId))
      .limit(1);

    return c.json({
      ...run,
      report: report ? {
        id: report.id,
        name: report.name,
        type: report.type,
        format: report.format
      } : null
    });
  }
);
