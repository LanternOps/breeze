import { Hono } from 'hono';
import { db } from '../../db';
import { devices, deviceBootMetrics } from '../../db/schema';
import { eq, and, desc, sql, SQL } from 'drizzle-orm';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { getDeviceWithOrgCheck } from './helpers';

export const bootMetricsRoutes = new Hono();

bootMetricsRoutes.use('*', authMiddleware);

// GET /devices/:id/boot-metrics - Returns boot performance history
bootMetricsRoutes.get(
  '/:id/boot-metrics',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const limit = Math.min(Number(c.req.query('limit')) || 30, 100);

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const boots = await db
      .select()
      .from(deviceBootMetrics)
      .where(eq(deviceBootMetrics.deviceId, deviceId))
      .orderBy(desc(deviceBootMetrics.bootTimestamp))
      .limit(limit);

    // Compute summary
    const totalBootTimes = boots.map(b => b.totalBootSeconds).filter((t): t is number => t !== null);
    const avgBootTime = totalBootTimes.length > 0
      ? totalBootTimes.reduce((a, b) => a + b, 0) / totalBootTimes.length
      : 0;

    return c.json({
      boots,
      summary: {
        totalBoots: boots.length,
        avgBootTimeSeconds: Number(avgBootTime.toFixed(2)),
        fastestBootSeconds: totalBootTimes.length > 0 ? Number(Math.min(...totalBootTimes).toFixed(2)) : null,
        slowestBootSeconds: totalBootTimes.length > 0 ? Number(Math.max(...totalBootTimes).toFixed(2)) : null,
      }
    });
  }
);

// POST /devices/:id/collect-boot-metrics - Trigger on-demand collection
bootMetricsRoutes.post(
  '/:id/collect-boot-metrics',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    if (device.status !== 'online') {
      return c.json({ error: `Device is not online (status: ${device.status})` }, 400);
    }

    const { executeCommand } = await import('../../services/commandQueue');
    const result = await executeCommand(
      deviceId,
      'collect_boot_performance',
      {},
      { userId: auth.user.id, timeoutMs: 30000 }
    );

    return c.json(result);
  }
);

// GET /devices/:id/startup-items - Returns current startup items from most recent boot
bootMetricsRoutes.get(
  '/:id/startup-items',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const [latestBoot] = await db
      .select()
      .from(deviceBootMetrics)
      .where(eq(deviceBootMetrics.deviceId, deviceId))
      .orderBy(desc(deviceBootMetrics.bootTimestamp))
      .limit(1);

    if (!latestBoot) {
      return c.json({ items: [], bootTimestamp: null, totalItems: 0 });
    }

    return c.json({
      items: latestBoot.startupItems,
      bootTimestamp: latestBoot.bootTimestamp,
      totalItems: latestBoot.startupItemCount,
    });
  }
);

// POST /devices/:id/startup-items/:itemName/disable - Disable a startup item (Tier 3)
bootMetricsRoutes.post(
  '/:id/startup-items/:itemName/disable',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const itemName = decodeURIComponent(c.req.param('itemName'));

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    if (device.status !== 'online') {
      return c.json({ error: `Device is not online (status: ${device.status})` }, 400);
    }

    // Look up item in latest boot record
    const [latestBoot] = await db
      .select()
      .from(deviceBootMetrics)
      .where(eq(deviceBootMetrics.deviceId, deviceId))
      .orderBy(desc(deviceBootMetrics.bootTimestamp))
      .limit(1);

    if (!latestBoot) {
      return c.json({ error: 'No boot performance data available' }, 404);
    }

    const items = latestBoot.startupItems as Array<{ name: string; type: string; path: string; enabled: boolean }>;
    const item = items.find(i => i.name === itemName);
    if (!item) {
      return c.json({ error: `Startup item "${itemName}" not found` }, 404);
    }

    const { executeCommand } = await import('../../services/commandQueue');
    const result = await executeCommand(
      deviceId,
      'manage_startup_item',
      { itemName, itemType: item.type, itemPath: item.path, action: 'disable' },
      { userId: auth.user.id, timeoutMs: 30000 }
    );

    return c.json(result);
  }
);

// POST /devices/:id/startup-items/:itemName/enable - Enable a startup item (Tier 3)
bootMetricsRoutes.post(
  '/:id/startup-items/:itemName/enable',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const itemName = decodeURIComponent(c.req.param('itemName'));

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    if (device.status !== 'online') {
      return c.json({ error: `Device is not online (status: ${device.status})` }, 400);
    }

    const [latestBoot] = await db
      .select()
      .from(deviceBootMetrics)
      .where(eq(deviceBootMetrics.deviceId, deviceId))
      .orderBy(desc(deviceBootMetrics.bootTimestamp))
      .limit(1);

    if (!latestBoot) {
      return c.json({ error: 'No boot performance data available' }, 404);
    }

    const items = latestBoot.startupItems as Array<{ name: string; type: string; path: string; enabled: boolean }>;
    const item = items.find(i => i.name === itemName);
    if (!item) {
      return c.json({ error: `Startup item "${itemName}" not found` }, 404);
    }

    const { executeCommand } = await import('../../services/commandQueue');
    const result = await executeCommand(
      deviceId,
      'manage_startup_item',
      { itemName, itemType: item.type, itemPath: item.path, action: 'enable' },
      { userId: auth.user.id, timeoutMs: 30000 }
    );

    return c.json(result);
  }
);
