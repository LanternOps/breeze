import { Hono } from 'hono';
import { eq, and, gte, asc, sql, inArray, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { deviceWarranty, devices } from '../../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';
import { queueWarrantySyncForDevice } from '../../services/warrantyWorker';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';

export const warrantyRoutes = new Hono();

warrantyRoutes.use('*', authMiddleware);

// GET /devices/:id/warranty - Get warranty info for a device
warrantyRoutes.get(
  '/:id/warranty',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
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
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
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
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const days = Math.min(Math.max(parseInt(c.req.query('days') ?? '90', 10) || 90, 1), 365);
    const limitParam = Math.min(Math.max(parseInt(c.req.query('limit') ?? '50', 10) || 50, 1), 200);

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() + days);

    const conditions: SQL[] = [
      gte(deviceWarranty.warrantyEndDate, sql`CURRENT_DATE`),
      sql`${deviceWarranty.warrantyEndDate} <= ${cutoffDate.toISOString().split('T')[0]}`,
    ];

    // Tenant isolation via standard auth helper
    const orgFilter = auth.orgCondition(deviceWarranty.orgId);
    if (orgFilter) conditions.push(orgFilter);

    const permissions = c.get('permissions') as UserPermissions | undefined;
    if (permissions?.allowedSiteIds) {
      conditions.push(permissions.allowedSiteIds.length > 0
        ? inArray(devices.siteId, permissions.allowedSiteIds)
        : sql`false`);
    }

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
