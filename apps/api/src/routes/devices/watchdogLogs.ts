import { Hono } from 'hono';
import { and, desc, eq, gte, ilike, inArray, lte, sql } from 'drizzle-orm';
import { db } from '../../db';
import { agentLogs } from '../../db/schema';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { getDeviceWithOrgCheck, getPagination } from './helpers';
import { escapeLike } from '../../utils/sql';

export const watchdogLogsRoutes = new Hono();

watchdogLogsRoutes.use('*', authMiddleware);

// GET /devices/:id/watchdog-logs — Query watchdog health journal logs
// Watchdog logs are identified by component prefix 'watchdog.' as shipped
// by the breeze-watchdog process via the agent logs endpoint.
watchdogLogsRoutes.get(
  '/:id/watchdog-logs',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const query = c.req.query();

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // Base condition: this device's logs, watchdog component prefix only
    const conditions: ReturnType<typeof eq>[] = [
      eq(agentLogs.deviceId, device.id),
      ilike(agentLogs.component, 'watchdog.%'),
    ];

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

    // Filter by component sub-path: ?component=watchdog.start
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

    // Message + fields text search: ?search=keyword
    if (query.search) {
      const pattern = `%${escapeLike(query.search)}%`;
      conditions.push(
        sql`(${agentLogs.message} ILIKE ${pattern} OR ${agentLogs.fields}::text ILIKE ${pattern})` as any
      );
    }

    const { limit, offset } = getPagination(
      { page: query.page, limit: query.limit },
      500
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
      console.error(`[WatchdogLogs] Query failed for device ${deviceId}:`, err);
      return c.json({ error: 'Failed to query watchdog logs' }, 500);
    }

    return c.json({ logs: rows, total, limit, offset });
  }
);
