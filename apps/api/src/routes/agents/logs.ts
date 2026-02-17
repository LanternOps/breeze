import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices, agentLogs } from '../../db/schema';
import { agentLogIngestSchema } from './schemas';

export const logsRoutes = new Hono();

logsRoutes.post('/:id/logs', zValidator('json', agentLogIngestSchema), async (c) => {
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

  if (data.logs.length === 0) {
    return c.json({ received: 0 }, 200);
  }

  const rows = data.logs.map((log: any) => ({
    deviceId: device.id,
    orgId: device.orgId,
    timestamp: new Date(log.timestamp),
    level: log.level,
    component: log.component,
    message: log.message,
    fields: log.fields || null,
    agentVersion: log.agentVersion || null,
  }));

  let inserted = 0;
  try {
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100);
      await db.insert(agentLogs).values(batch);
      inserted += batch.length;
    }
  } catch (err) {
    console.error(`[AgentLogs] Error batch inserting logs for device ${device.id}:`, err);
  }

  return c.json({ received: inserted }, 201);
});
