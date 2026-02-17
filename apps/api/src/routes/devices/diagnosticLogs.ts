import { Hono } from 'hono';
import { and, desc, eq, gte, ilike, inArray, lte, sql } from 'drizzle-orm';
import { db } from '../../db';
import { agentLogs } from '../../db/schema';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { getDeviceWithOrgCheck, getPagination } from './helpers';
import { escapeLike } from '../../utils/sql';

export const diagnosticLogsRoutes = new Hono();

diagnosticLogsRoutes.use('*', authMiddleware);

// GET /devices/:id/diagnostic-logs — Query shipped agent logs
diagnosticLogsRoutes.get(
  '/:id/diagnostic-logs',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const query = c.req.query();

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const conditions: ReturnType<typeof eq>[] = [eq(agentLogs.deviceId, device.id)];

    // Filter by level(s): ?level=warn or ?level=warn,error
    if (query.level) {
      const validLevels = ['debug', 'info', 'warn', 'error'] as const;
      type LogLevel = typeof validLevels[number];
      const levels = query.level.split(',').filter(
        (l): l is LogLevel => (validLevels as readonly string[]).includes(l)
      );
      if (levels.length > 0) {
        conditions.push(inArray(agentLogs.level, levels));
      }
    }

    // Filter by component: ?component=updater
    if (query.component) {
      conditions.push(eq(agentLogs.component, query.component));
    }

    // Time range: ?since=ISO&until=ISO
    if (query.since) {
      const d = new Date(query.since);
      if (isNaN(d.getTime())) {
        return c.json({ error: 'Invalid since date' }, 400);
      }
      conditions.push(gte(agentLogs.timestamp, d));
    }
    if (query.until) {
      const d = new Date(query.until);
      if (isNaN(d.getTime())) {
        return c.json({ error: 'Invalid until date' }, 400);
      }
      conditions.push(lte(agentLogs.timestamp, d));
    }

    // Message text search: ?search=keyword
    if (query.search) {
      conditions.push(ilike(agentLogs.message, `%${escapeLike(query.search)}%`));
    }

    const { limit, offset } = getPagination(
      { page: query.page, limit: query.limit },
      1000
    );

    let rows: typeof agentLogs.$inferSelect[];
    let total: number;

    try {
      const [rowsResult, countRows] = await Promise.all([
        db
          .select()
          .from(agentLogs)
          .where(and(...conditions))
          .orderBy(desc(agentLogs.timestamp))
          .limit(limit)
          .offset(offset),
        db
          .select({ total: sql<number>`count(*)::int` })
          .from(agentLogs)
          .where(and(...conditions)),
      ]);
      rows = rowsResult;
      total = countRows[0]?.total ?? 0;
    } catch (err) {
      console.error(`[DiagnosticLogs] Query failed for device ${deviceId}:`, err);
      return c.json({ error: 'Failed to query diagnostic logs' }, 500);
    }

    return c.json({ logs: rows, total, limit, offset });
  }
);
