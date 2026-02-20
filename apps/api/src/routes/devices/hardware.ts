import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db';
import { deviceHardware, deviceDisks, deviceNetwork, deviceConnections, deviceIpHistory } from '../../db/schema';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { getDeviceWithOrgCheck } from './helpers';

export const hardwareRoutes = new Hono();

hardwareRoutes.use('*', authMiddleware);

// GET /devices/:id/hardware - Get device hardware with disks and network adapters
hardwareRoutes.get(
  '/:id/hardware',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const [hardware] = await db
      .select()
      .from(deviceHardware)
      .where(eq(deviceHardware.deviceId, deviceId))
      .limit(1);

    // Get disk drives
    const diskDrives = await db
      .select()
      .from(deviceDisks)
      .where(eq(deviceDisks.deviceId, deviceId));

    // Get network adapters
    const networkInterfaces = await db
      .select()
      .from(deviceNetwork)
      .where(eq(deviceNetwork.deviceId, deviceId));

    return c.json({
      hardware: hardware || null,
      diskDrives,
      networkInterfaces
    });
  }
);

// GET /devices/:id/network - Get device network adapters
hardwareRoutes.get(
  '/:id/network',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const networkInterfaces = await db
      .select()
      .from(deviceNetwork)
      .where(eq(deviceNetwork.deviceId, deviceId));

    return c.json({ data: networkInterfaces });
  }
);

// GET /devices/:id/ip-history - Get historical IP assignments for a device
hardwareRoutes.get(
  '/:id/ip-history',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const rawLimit = Number.parseInt(c.req.query('limit') ?? '100', 10);
    const rawOffset = Number.parseInt(c.req.query('offset') ?? '0', 10);
    const activeOnly = c.req.query('active_only') === 'true';

    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 100;
    const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;

    const conditions = [eq(deviceIpHistory.deviceId, deviceId)];
    if (activeOnly) {
      conditions.push(eq(deviceIpHistory.isActive, true));
    }

    const history = await db
      .select()
      .from(deviceIpHistory)
      .where(and(...conditions))
      .orderBy(desc(deviceIpHistory.firstSeen))
      .limit(limit)
      .offset(offset);

    return c.json({
      deviceId,
      count: history.length,
      data: history,
    });
  }
);

// GET /devices/:id/disks - Get device disk drives
hardwareRoutes.get(
  '/:id/disks',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const diskDrives = await db
      .select()
      .from(deviceDisks)
      .where(eq(deviceDisks.deviceId, deviceId));

    return c.json({ data: diskDrives });
  }
);

// GET /devices/:id/connections - Get active network connections
hardwareRoutes.get(
  '/:id/connections',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const connections = await db
      .select()
      .from(deviceConnections)
      .where(eq(deviceConnections.deviceId, deviceId));

    return c.json({ data: connections });
  }
);
