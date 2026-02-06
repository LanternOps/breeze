import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, like, sql, asc } from 'drizzle-orm';
import { db } from '../../db';
import { softwareInventory } from '../../db/schema';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { getPagination, getDeviceWithOrgCheck } from './helpers';
import { softwareQuerySchema } from './schemas';

export const softwareRoutes = new Hono();

softwareRoutes.use('*', authMiddleware);

// GET /devices/:id/software - Get installed software list
softwareRoutes.get(
  '/:id/software',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', softwareQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query, 1000);

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // Build conditions
    const conditions: ReturnType<typeof eq>[] = [eq(softwareInventory.deviceId, deviceId)];

    if (query.search) {
      conditions.push(like(softwareInventory.name, `%${query.search}%`));
    }

    const whereCondition = and(...conditions);

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(softwareInventory)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get software list
    const software = await db
      .select()
      .from(softwareInventory)
      .where(whereCondition)
      .orderBy(asc(softwareInventory.name))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: software,
      pagination: { page, limit, total }
    });
  }
);
