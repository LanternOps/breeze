import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, lt, lte, or, sql, SQL } from 'drizzle-orm';
import { db } from '../db';
import { deviceChangeLog, devices } from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';

const changeTypeValues = [
  'software',
  'service',
  'startup',
  'network',
  'scheduled_task',
  'user_account'
] as const;

const changeActionValues = [
  'added',
  'removed',
  'modified',
  'updated'
] as const;

const listChangesQuerySchema = z.object({
  deviceId: z.string().uuid().optional(),
  startTime: z.string().datetime({ offset: true }).optional(),
  endTime: z.string().datetime({ offset: true }).optional(),
  changeType: z.enum(changeTypeValues).optional(),
  changeAction: z.enum(changeActionValues).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: z.string().min(1).optional()
});

export const changesRoutes = new Hono();

changesRoutes.use('*', authMiddleware);

changesRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listChangesQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const conditions: SQL[] = [];

    const orgCondition = auth.orgCondition(deviceChangeLog.orgId);
    if (orgCondition) {
      conditions.push(orgCondition);
    }

    if (query.deviceId) {
      const deviceConditions: SQL[] = [eq(devices.id, query.deviceId)];
      const deviceOrgCondition = auth.orgCondition(devices.orgId);
      if (deviceOrgCondition) {
        deviceConditions.push(deviceOrgCondition);
      }

      const [device] = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(...deviceConditions))
        .limit(1);

      if (!device) {
        return c.json({ error: 'Device not found' }, 404);
      }

      conditions.push(eq(deviceChangeLog.deviceId, query.deviceId));
    }

    if (query.startTime) {
      conditions.push(gte(deviceChangeLog.timestamp, new Date(query.startTime)));
    }

    if (query.endTime) {
      conditions.push(lte(deviceChangeLog.timestamp, new Date(query.endTime)));
    }

    if (query.changeType) {
      conditions.push(eq(deviceChangeLog.changeType, query.changeType));
    }

    if (query.changeAction) {
      conditions.push(eq(deviceChangeLog.changeAction, query.changeAction));
    }

    if (query.cursor) {
      let cursorTimestamp: Date;
      let cursorId: string;
      try {
        const decoded = Buffer.from(query.cursor, 'base64url').toString('utf-8');
        const parsed = JSON.parse(decoded) as { timestamp?: string; id?: string };
        if (!parsed.timestamp || !parsed.id) {
          return c.json({ error: 'Invalid cursor' }, 400);
        }
        cursorTimestamp = new Date(parsed.timestamp);
        if (isNaN(cursorTimestamp.getTime())) {
          return c.json({ error: 'Invalid cursor timestamp' }, 400);
        }
        cursorId = parsed.id;
      } catch {
        return c.json({ error: 'Invalid cursor' }, 400);
      }

      const cursorCondition = or(
        lt(deviceChangeLog.timestamp, cursorTimestamp),
        and(
          eq(deviceChangeLog.timestamp, cursorTimestamp),
          lt(deviceChangeLog.id, cursorId)
        )
      );
      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = query.limit ?? 100;
    const fetchLimit = limit + 1;

    const [changes, countRows] = await Promise.all([
      db
        .select({
          id: deviceChangeLog.id,
          deviceId: deviceChangeLog.deviceId,
          hostname: devices.hostname,
          timestamp: deviceChangeLog.timestamp,
          changeType: deviceChangeLog.changeType,
          changeAction: deviceChangeLog.changeAction,
          subject: deviceChangeLog.subject,
          beforeValue: deviceChangeLog.beforeValue,
          afterValue: deviceChangeLog.afterValue,
          details: deviceChangeLog.details
        })
        .from(deviceChangeLog)
        .leftJoin(devices, eq(deviceChangeLog.deviceId, devices.id))
        .where(whereClause)
        .orderBy(desc(deviceChangeLog.timestamp), desc(deviceChangeLog.id))
        .limit(fetchLimit),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(deviceChangeLog)
        .where(whereClause)
    ]);

    const page = changes.slice(0, limit);
    const hasMore = changes.length > limit;
    const lastRow = page[page.length - 1];
    const nextCursor = hasMore && lastRow
      ? Buffer.from(JSON.stringify({
          timestamp: lastRow.timestamp.toISOString(),
          id: lastRow.id
        }), 'utf-8').toString('base64url')
      : null;

    return c.json({
      changes: page,
      total: countRows[0]?.total ?? 0,
      showing: page.length,
      hasMore,
      nextCursor
    });
  }
);
