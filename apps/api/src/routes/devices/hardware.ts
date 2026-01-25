import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { deviceHardware, deviceDisks, deviceNetwork } from '../../db/schema';
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
