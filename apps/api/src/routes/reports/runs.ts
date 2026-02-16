import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, sql, desc, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { reports, reportRuns } from '../../db/schema';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { getPagination, ensureOrgAccess, getReportWithOrgCheck, getReportRunWithOrgCheck } from './helpers';
import { listRunsSchema } from './schemas';

export const runsRoutes = new Hono();

runsRoutes.use('*', authMiddleware);

// POST /reports/:id/generate - Generate report now
runsRoutes.post(
  '/:id/generate',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const reportId = c.req.param('id');

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

    // In a real implementation, this would trigger an async job
    // For now, we'll simulate the report generation process

    // Update report's lastGeneratedAt
    await db
      .update(reports)
      .set({ lastGeneratedAt: new Date(), updatedAt: new Date() })
      .where(eq(reports.id, reportId));

    // Simulate processing (in production, this would be async)
    setTimeout(async () => {
      try {
        await db
          .update(reportRuns)
          .set({
            status: 'completed',
            completedAt: new Date(),
            outputUrl: `/api/reports/runs/${run.id}/download`
          })
          .where(eq(reportRuns.id, run.id));
      } catch {
        await db
          .update(reportRuns)
          .set({
            status: 'failed',
            completedAt: new Date(),
            errorMessage: 'Failed to generate report'
          })
          .where(eq(reportRuns.id, run.id));
      }
    }, 1000);

    return c.json({
      message: 'Report generation started',
      runId: run.id,
      status: run.status
    });
  }
);

// GET /reports/runs - List recent report runs
runsRoutes.get(
  '/runs',
  requireScope('organization', 'partner', 'system'),
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

// GET /reports/runs/:id - Get run with download URL
runsRoutes.get(
  '/runs/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const runId = c.req.param('id');

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
