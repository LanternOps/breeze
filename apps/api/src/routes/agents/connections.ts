import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices, deviceConnections } from '../../db/schema';
import { submitConnectionsSchema } from './schemas';

export const connectionsRoutes = new Hono();

connectionsRoutes.put('/:id/connections', zValidator('json', submitConnectionsSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(deviceConnections)
      .where(eq(deviceConnections.deviceId, device.id));

    if (data.connections.length > 0) {
      const now = new Date();
      await tx.insert(deviceConnections).values(
        data.connections.map((conn) => ({
          deviceId: device.id,
          protocol: conn.protocol,
          localAddr: conn.localAddr,
          localPort: conn.localPort,
          remoteAddr: conn.remoteAddr || null,
          remotePort: conn.remotePort || null,
          state: conn.state || null,
          pid: conn.pid || null,
          processName: conn.processName || null,
          updatedAt: now
        }))
      );
    }
  });

  return c.json({ success: true, count: data.connections.length });
});
