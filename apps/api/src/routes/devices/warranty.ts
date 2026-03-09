import { Hono } from 'hono';
import { eq, and, gte, asc, sql } from 'drizzle-orm';
import { db } from '../../db';
import { deviceWarranty, devices, deviceHardware } from '../../db/schema';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { getDeviceWithOrgCheck } from './helpers';
import { queueWarrantySyncForDevice } from '../../services/warrantyWorker';

export const warrantyRoutes = new Hono();

warrantyRoutes.use('*', authMiddleware);

// GET /devices/:id/warranty - Get warranty info for a device
warrantyRoutes.get(
  '/:id/warranty',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const [warranty] = await db
      .select()
      .from(deviceWarranty)
      .where(eq(deviceWarranty.deviceId, deviceId))
      .limit(1);

    return c.json({ warranty: warranty ?? null });
  }
);

// POST /devices/:id/warranty/refresh - Queue on-demand warranty refresh
warrantyRoutes.post(
  '/:id/warranty/refresh',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    await queueWarrantySyncForDevice(deviceId);

    return c.json({ message: 'Warranty refresh queued' });
  }
);

// GET /warranty/expiring - List devices with warranties expiring within N days
warrantyRoutes.get(
  '/warranty/expiring',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const days = Math.min(Math.max(parseInt(c.req.query('days') ?? '90', 10) || 90, 1), 365);
    const limitParam = Math.min(Math.max(parseInt(c.req.query('limit') ?? '50', 10) || 50, 1), 200);

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() + days);

    const conditions = [
      gte(deviceWarranty.warrantyEndDate, sql`CURRENT_DATE`),
      sql`${deviceWarranty.warrantyEndDate} <= ${cutoffDate.toISOString().split('T')[0]}`,
    ];

    // Tenant isolation via standard auth helper
    const orgFilter = auth.orgCondition(deviceWarranty.orgId);
    if (orgFilter) conditions.push(orgFilter);

    const rows = await db
      .select({
        warranty: deviceWarranty,
        hostname: devices.hostname,
        displayName: devices.displayName,
      })
      .from(deviceWarranty)
      .innerJoin(devices, eq(deviceWarranty.deviceId, devices.id))
      .where(and(...conditions))
      .orderBy(asc(deviceWarranty.warrantyEndDate))
      .limit(limitParam);

    return c.json({
      data: rows.map((r) => ({
        ...r.warranty,
        hostname: r.hostname,
        displayName: r.displayName,
      })),
      count: rows.length,
    });
  }
);
