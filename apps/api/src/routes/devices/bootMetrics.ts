import { Hono } from 'hono';
import { db } from '../../db';
import { deviceBootMetrics } from '../../db/schema';
import { eq, desc } from 'drizzle-orm';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { getDeviceWithOrgCheck } from './helpers';
import {
  normalizeStartupItems,
  resolveStartupItem,
} from '../../services/startupItems';

export const bootMetricsRoutes = new Hono();

bootMetricsRoutes.use('*', authMiddleware);

function parseActionBody(body: unknown): {
  reason: string;
  itemId?: string;
  itemType?: string;
  itemPath?: string;
} {
  const payload = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const reason = typeof payload.reason === 'string' && payload.reason.trim() !== ''
    ? payload.reason.trim().slice(0, 500)
    : 'No reason provided';
  const itemId = typeof payload.itemId === 'string' && payload.itemId.trim() !== ''
    ? payload.itemId.trim()
    : undefined;
  const itemType = typeof payload.itemType === 'string' && payload.itemType.trim() !== ''
    ? payload.itemType.trim()
    : undefined;
  const itemPath = typeof payload.itemPath === 'string' && payload.itemPath.trim() !== ''
    ? payload.itemPath.trim()
    : undefined;

  return { reason, itemId, itemType, itemPath };
}

// GET /devices/:id/boot-metrics - Returns boot performance history
bootMetricsRoutes.get(
  '/:id/boot-metrics',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const deviceId = c.req.param('id');
    try {
      const auth = c.get('auth');
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

      const bootsWithNormalizedItems = boots.map((boot) => {
        const startupItems = normalizeStartupItems(Array.isArray(boot.startupItems) ? boot.startupItems : []);
        return {
          ...boot,
          startupItems,
          startupItemCount: startupItems.length,
        };
      });

      // Compute summary
      const totalBootTimes = bootsWithNormalizedItems.map(b => b.totalBootSeconds).filter((t): t is number => t !== null);
      const avgBootTime = totalBootTimes.length > 0
        ? totalBootTimes.reduce((a, b) => a + b, 0) / totalBootTimes.length
        : 0;

      return c.json({
        boots: bootsWithNormalizedItems,
        summary: {
          totalBoots: bootsWithNormalizedItems.length,
          avgBootTimeSeconds: Number(avgBootTime.toFixed(2)),
          fastestBootSeconds: totalBootTimes.length > 0 ? Number(Math.min(...totalBootTimes).toFixed(2)) : null,
          slowestBootSeconds: totalBootTimes.length > 0 ? Number(Math.max(...totalBootTimes).toFixed(2)) : null,
        }
      });
    } catch (err) {
      console.error(`[BootMetrics] GET boot-metrics failed for device ${deviceId}:`, err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  }
);

// POST /devices/:id/collect-boot-metrics - Trigger on-demand collection
bootMetricsRoutes.post(
  '/:id/collect-boot-metrics',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const deviceId = c.req.param('id');
    try {
      const auth = c.get('auth');

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
    } catch (err) {
      console.error(`[BootMetrics] POST collect-boot-metrics failed for device ${deviceId}:`, err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  }
);

// GET /devices/:id/startup-items - Returns current startup items from most recent boot
bootMetricsRoutes.get(
  '/:id/startup-items',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const deviceId = c.req.param('id');
    try {
      const auth = c.get('auth');

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

      const startupItems = normalizeStartupItems(
        Array.isArray(latestBoot.startupItems) ? latestBoot.startupItems : []
      );

      return c.json({
        items: startupItems,
        bootTimestamp: latestBoot.bootTimestamp,
        totalItems: startupItems.length,
      });
    } catch (err) {
      console.error(`[BootMetrics] GET startup-items failed for device ${deviceId}:`, err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  }
);

// POST /devices/:id/startup-items/:itemName/disable - Disable a startup item (requires online device)
bootMetricsRoutes.post(
  '/:id/startup-items/:itemName/disable',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const deviceId = c.req.param('id');
    try {
      const auth = c.get('auth');
      const itemName = decodeURIComponent(c.req.param('itemName'));
      let actionBody = parseActionBody({});
      try {
        actionBody = parseActionBody(await c.req.json());
      } catch {
        // Request body is optional for this endpoint.
      }

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

      const items = normalizeStartupItems(Array.isArray(latestBoot.startupItems) ? latestBoot.startupItems : []);
      const match = resolveStartupItem(items, {
        itemId: actionBody.itemId,
        itemName,
        itemType: actionBody.itemType,
        itemPath: actionBody.itemPath,
      });
      if (!match.item) {
        if (match.candidates && match.candidates.length > 1) {
          return c.json({
            error: `Startup item selector for "${itemName}" is ambiguous. Provide itemId or itemType+itemPath.`,
            candidates: match.candidates.slice(0, 20).map(c => ({
              itemId: c.itemId,
              name: c.name,
              type: c.type,
              path: c.path,
              enabled: c.enabled,
            })),
          }, 409);
        }
        return c.json({
          error: `Startup item "${itemName}" not found`,
          availableItems: items.slice(0, 20).map(i => ({
            itemId: i.itemId,
            name: i.name,
            type: i.type,
            path: i.path,
            enabled: i.enabled,
          })),
        }, 404);
      }

      const { executeCommand } = await import('../../services/commandQueue');
      const result = await executeCommand(
        deviceId,
        'manage_startup_item',
        {
          itemName: match.item.name,
          itemType: match.item.type,
          itemPath: match.item.path,
          itemId: match.item.itemId,
          action: 'disable',
          reason: actionBody.reason,
        },
        { userId: auth.user.id, timeoutMs: 30000 }
      );

      return c.json(result);
    } catch (err) {
      console.error(`[BootMetrics] POST disable startup item failed for device ${deviceId}:`, err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  }
);

// POST /devices/:id/startup-items/:itemName/enable - Enable a startup item (requires online device)
bootMetricsRoutes.post(
  '/:id/startup-items/:itemName/enable',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const deviceId = c.req.param('id');
    try {
      const auth = c.get('auth');
      const itemName = decodeURIComponent(c.req.param('itemName'));
      let actionBody = parseActionBody({});
      try {
        actionBody = parseActionBody(await c.req.json());
      } catch {
        // Request body is optional for this endpoint.
      }

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

      const items = normalizeStartupItems(Array.isArray(latestBoot.startupItems) ? latestBoot.startupItems : []);
      const match = resolveStartupItem(items, {
        itemId: actionBody.itemId,
        itemName,
        itemType: actionBody.itemType,
        itemPath: actionBody.itemPath,
      });
      if (!match.item) {
        if (match.candidates && match.candidates.length > 1) {
          return c.json({
            error: `Startup item selector for "${itemName}" is ambiguous. Provide itemId or itemType+itemPath.`,
            candidates: match.candidates.slice(0, 20).map(c => ({
              itemId: c.itemId,
              name: c.name,
              type: c.type,
              path: c.path,
              enabled: c.enabled,
            })),
          }, 409);
        }
        return c.json({
          error: `Startup item "${itemName}" not found`,
          availableItems: items.slice(0, 20).map(i => ({
            itemId: i.itemId,
            name: i.name,
            type: i.type,
            path: i.path,
            enabled: i.enabled,
          })),
        }, 404);
      }

      const { executeCommand } = await import('../../services/commandQueue');
      const result = await executeCommand(
        deviceId,
        'manage_startup_item',
        {
          itemName: match.item.name,
          itemType: match.item.type,
          itemPath: match.item.path,
          itemId: match.item.itemId,
          action: 'enable',
          reason: actionBody.reason,
        },
        { userId: auth.user.id, timeoutMs: 30000 }
      );

      return c.json(result);
    } catch (err) {
      console.error(`[BootMetrics] POST enable startup item failed for device ${deviceId}:`, err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  }
);
