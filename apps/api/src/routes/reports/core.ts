import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, sql, desc, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { reports, reportRuns } from '../../db/schema';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { getPagination, ensureOrgAccess, getReportWithOrgCheck } from './helpers';
import { listReportsSchema, createReportSchema, updateReportSchema } from './schemas';

export const coreRoutes = new Hono();

coreRoutes.use('*', authMiddleware);

// GET /reports - List saved reports
coreRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listReportsSchema),
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
      if (query.orgId) {
        const hasAccess = await ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        conditions.push(eq(reports.orgId, query.orgId));
      } else {
        const orgIds = auth.accessibleOrgIds ?? [];
        if (orgIds.length === 0) {
          return c.json({
            data: [],
            pagination: { page, limit, total: 0 }
          });
        }
        conditions.push(inArray(reports.orgId, orgIds));
      }
    } else if (auth.scope === 'system' && query.orgId) {
      conditions.push(eq(reports.orgId, query.orgId));
    }

    // Additional filters
    if (query.type) {
      conditions.push(eq(reports.type, query.type));
    }

    if (query.schedule) {
      conditions.push(eq(reports.schedule, query.schedule));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

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

// GET /reports/:id - Get report config
coreRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const reportId = c.req.param('id');

    // Skip if this is a route like /reports/runs, /reports/data, etc.
    if (['runs', 'data', 'generate'].includes(reportId)) {
      return c.notFound();
    }

    const report = await getReportWithOrgCheck(reportId, auth);
    if (!report) {
      return c.json({ error: 'Report not found' }, 404);
    }

    // Get recent runs for this report
    const recentRuns = await db
      .select()
      .from(reportRuns)
      .where(eq(reportRuns.reportId, reportId))
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
        return c.json({ error: 'orgId is required for partner scope' }, 400);
      }
      const hasAccess = await ensureOrgAccess(orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
    } else if (auth.scope === 'system' && !orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    const [report] = await db
      .insert(reports)
      .values({
        orgId: orgId!,
        name: data.name,
        type: data.type,
        config: data.config,
        schedule: data.schedule,
        format: data.format,
        createdBy: auth.user.id
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
  zValidator('json', updateReportSchema),
  async (c) => {
    const auth = c.get('auth');
    const reportId = c.req.param('id');
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const report = await getReportWithOrgCheck(reportId, auth);
    if (!report) {
      return c.json({ error: 'Report not found' }, 404);
    }

    // Build updates object
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (data.name !== undefined) updates.name = data.name;
    if (data.config !== undefined) updates.config = data.config;
    if (data.schedule !== undefined) updates.schedule = data.schedule;
    if (data.format !== undefined) updates.format = data.format;

    const [updated] = await db
      .update(reports)
      .set(updates)
      .where(eq(reports.id, reportId))
      .returning();

    writeRouteAudit(c, {
      orgId: report.orgId,
      action: 'report.update',
      resourceType: 'report',
      resourceId: updated?.id ?? reportId,
      resourceName: updated?.name ?? report.name,
      details: { changedFields: Object.keys(data) }
    });

    return c.json(updated);
  }
);

// DELETE /reports/:id - Delete report
coreRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const reportId = c.req.param('id');

    const report = await getReportWithOrgCheck(reportId, auth);
    if (!report) {
      return c.json({ error: 'Report not found' }, 404);
    }

    // Delete associated runs first
    await db
      .delete(reportRuns)
      .where(eq(reportRuns.reportId, reportId));

    // Delete the report
    await db
      .delete(reports)
      .where(eq(reports.id, reportId));

    writeRouteAudit(c, {
      orgId: report.orgId,
      action: 'report.delete',
      resourceType: 'report',
      resourceId: report.id,
      resourceName: report.name
    });

    return c.json({ success: true });
  }
);
