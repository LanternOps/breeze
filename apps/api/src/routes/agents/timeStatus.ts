import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { and, eq } from 'drizzle-orm';
import { timeStatusSnapshotSchema } from '@breeze/shared';
import { db } from '../../db';
import { devices } from '../../db/schema';
import { zValidator } from '../../lib/validation';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import { ingestTimeStatusSnapshot } from '../../services/timeSync/ingest';
export const timeStatusRoutes = new Hono();
timeStatusRoutes.use('*', requireAgentRole);
timeStatusRoutes.put(
  '/:id/time-status',
  bodyLimit({
    maxSize: 512 * 1024,
    onError: (c) => c.json({ error: 'Request body too large' }, 413),
  }),
  zValidator('json', timeStatusSnapshotSchema),
  async (c) => {
    const agent = c.get('agent');
    if (c.req.param('id') !== agent.agentId)
      return c.json({ error: 'Agent identity mismatch' }, 403);
    const [device] = await db
      .select({ agentVersion: devices.agentVersion })
      .from(devices)
      .where(
        and(eq(devices.id, agent.deviceId), eq(devices.orgId, agent.orgId)),
      )
      .limit(1);
    if (!device) return c.json({ error: 'Device not found' }, 404);
    const result = await ingestTimeStatusSnapshot({
      deviceId: agent.deviceId,
      orgId: agent.orgId,
      agentVersion: device.agentVersion ?? null,
      snapshot: c.req.valid('json'),
      receivedAt: new Date(),
    });
    return c.json({
      accepted: result.accepted,
      ...(result.health ? { health: result.health } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
    });
  },
);
