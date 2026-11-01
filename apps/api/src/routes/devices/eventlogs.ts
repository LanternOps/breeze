import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { and, eq, gte, inArray, lte, desc, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { deviceEventLogs } from '../../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED, getPagination } from './helpers';
import {
  canReadSensitiveEventLogCategory,
  resolveVisibleCategories,
  SENSITIVE_EVENT_LOG_CATEGORY,
  SensitiveEventLogAccessError,
} from '../../services/eventLogSensitivity';

export const eventLogsRoutes = new Hono();

eventLogsRoutes.use('*', authMiddleware);

// A reliability factor links to every source its scored events came from
// (#10053), so `source` may repeat (`?source=a&source=b`, any-of). A single
// value is still an exact match. Capped to keep the IN list bounded.
const MAX_SOURCE_FILTER_VALUES = 25;
const sourceFilterSchema = z
  .union([z.string(), z.array(z.string()).max(MAX_SOURCE_FILTER_VALUES)])
  .transform((value) => (Array.isArray(value) ? value : [value]));

const eventLogsQuerySchema = z.object({
  category: z.enum(['security', 'hardware', 'application', 'system']).optional(),
  level: z.enum(['info', 'warning', 'error', 'critical']).optional(),
  source: sourceFilterSchema.optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  page: z.string().optional(),
  limit: z.string().optional(),
});

// GET /devices/:id/eventlogs - Get event logs for a device
eventLogsRoutes.get(
  '/:id/eventlogs',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', eventLogsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query, 500);

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const canReadSensitiveCategory = await canReadSensitiveEventLogCategory(auth);
    let visibleCategories: typeof query.category[] | undefined;
    try {
      visibleCategories = resolveVisibleCategories(
        query.category ? [query.category] : undefined,
        canReadSensitiveCategory
      );
    } catch (error) {
      if (error instanceof SensitiveEventLogAccessError) {
        return c.json({ error: error.message }, 403);
      }
      throw error;
    }

    const conditions: SQL[] = [eq(deviceEventLogs.deviceId, deviceId)];

    if (visibleCategories && visibleCategories.length > 0) {
      conditions.push(eq(deviceEventLogs.category, visibleCategories[0]!));
    } else if (!visibleCategories && !canReadSensitiveCategory) {
      conditions.push(sql`${deviceEventLogs.category}::text != ${SENSITIVE_EVENT_LOG_CATEGORY}`);
    }
    if (query.level) {
      conditions.push(eq(deviceEventLogs.level, query.level));
    }
    // An empty value was never a filter (`?source=` skipped it); keep that.
    const sources = [...new Set((query.source ?? []).filter((source) => source !== ''))];
    if (sources.length === 1) {
      conditions.push(eq(deviceEventLogs.source, sources[0]!));
    } else if (sources.length > 1) {
      conditions.push(inArray(deviceEventLogs.source, sources));
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
      .orderBy(desc(deviceEventLogs.timestamp), desc(deviceEventLogs.id))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: events,
      pagination: { page, limit, total }
    });
  }
);
