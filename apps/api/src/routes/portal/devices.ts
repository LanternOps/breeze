import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { devices } from '../../db/schema';
import { listSchema } from './schemas';
import { getPagination } from './helpers';

export const deviceRoutes = new Hono();

deviceRoutes.get('/devices', zValidator('query', listSchema), async (c) => {
  const auth = c.get('portalAuth');
  const query = c.req.valid('query');
  const { page, limit, offset } = getPagination(query);

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(devices)
    .where(eq(devices.orgId, auth.user.orgId));
  const count = countResult[0]?.count ?? 0;

  const data = await db
    .select({
      id: devices.id,
      hostname: devices.hostname,
      displayName: devices.displayName,
      osType: devices.osType,
      osVersion: devices.osVersion,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt
    })
    .from(devices)
    .where(eq(devices.orgId, auth.user.orgId))
    .orderBy(desc(devices.lastSeenAt))
    .limit(limit)
    .offset(offset);

  return c.json({
    data,
    pagination: { page, limit, total: Number(count ?? 0) }
  });
});
