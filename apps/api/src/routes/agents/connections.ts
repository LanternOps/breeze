import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices, deviceConnections } from '../../db/schema';
import { submitConnectionsSchema } from './schemas';

export const connectionsRoutes = new Hono();

connectionsRoutes.put(
  '/:id/connections',
  bodyLimit({ maxSize: 5 * 1024 * 1024, onError: (c) => c.json({ error: 'Request body too large' }, 413) }),
  zValidator('json', submitConnectionsSchema),
  async (c) => {
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

  try {
    await db.transaction(async (tx) => {
      await tx
        .delete(deviceConnections)
        .where(eq(deviceConnections.deviceId, device.id));

      if (data.connections.length > 0) {
        const now = new Date();
        await tx.insert(deviceConnections).values(
          data.connections.map((conn) => ({
            deviceId: device.id,
            orgId: device.orgId,
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
  } catch (err) {
    // Surface the actual Postgres error shape (code, constraint, column) so
    // we can diagnose 500s without needing per-site log spelunking. The
    // global onError handler returns "Internal Server Error" to the caller;
    // this adds route-level context to the server log.
    const pg = err as { code?: string; detail?: string; table_name?: string; column_name?: string; constraint_name?: string; message?: string };
    console.error('connections-inventory insert failed', {
      agentId,
      deviceId: device.id,
      orgId: device.orgId,
      count: data.connections.length,
      pgCode: pg.code,
      pgDetail: pg.detail,
      pgTable: pg.table_name,
      pgColumn: pg.column_name,
      pgConstraint: pg.constraint_name,
      message: pg.message
    });
    throw err;
  }

  return c.json({ success: true, count: data.connections.length });
});
