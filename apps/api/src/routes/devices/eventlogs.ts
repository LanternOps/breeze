import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, gte, lte, desc, sql } from 'drizzle-orm';
import { db } from '../../db';
import { deviceEventLogs } from '../../db/schema';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { getDeviceWithOrgCheck, getPagination } from './helpers';

export const eventLogsRoutes = new Hono();

eventLogsRoutes.use('*', authMiddleware);

const eventLogsQuerySchema = z.object({
  category: z.enum(['security', 'hardware', 'application', 'system']).optional(),
  level: z.enum(['info', 'warning', 'error', 'critical']).optional(),
  source: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  page: z.string().optional(),
  limit: z.string().optional(),
});

// GET /devices/:id/eventlogs - Get event logs for a device
eventLogsRoutes.get(
  '/:id/eventlogs',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', eventLogsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query, 500);

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const conditions: ReturnType<typeof eq>[] = [eq(deviceEventLogs.deviceId, deviceId)];

    if (query.category) {
      conditions.push(eq(deviceEventLogs.category, query.category));
    }
    if (query.level) {
      conditions.push(eq(deviceEventLogs.level, query.level));
    }
    if (query.source) {
      conditions.push(eq(deviceEventLogs.source, query.source));
    }
    if (query.startDate) {
      conditions.push(gte(deviceEventLogs.timestamp, new Date(query.startDate)));
    }
    if (query.endDate) {
      conditions.push(lte(deviceEventLogs.timestamp, new Date(query.endDate)));
    }

    const whereCondition = and(...conditions);

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(deviceEventLogs)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get event logs
    const events = await db
      .select()
      .from(deviceEventLogs)
      .where(whereCondition)
      .orderBy(desc(deviceEventLogs.timestamp))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: events,
      pagination: { page, limit, total }
    });
  }
);
