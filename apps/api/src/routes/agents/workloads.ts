import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { and, eq } from 'drizzle-orm';
import { WORKLOADS_REPORT_MAX_BYTES, workloadsReportSchema } from '@breeze/shared';
import { db } from '../../db';
import { devices } from '../../db/schema';
import { zValidator } from '../../lib/validation';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import { ingestWorkloadsReport } from '../../services/workloads/ingest';

export const workloadsRoutes = new Hono();
workloadsRoutes.use('*', requireAgentRole);
workloadsRoutes.put(
  '/:id/workloads',
  bodyLimit({
    maxSize: WORKLOADS_REPORT_MAX_BYTES,
    onError: (c) => c.json({ error: 'Request body too large' }, 413),
  }),
  zValidator('json', workloadsReportSchema),
  async (c) => {
    const agent = c.get('agent');
    if (c.req.param('id') !== agent.agentId) return c.json({ error: 'Agent identity mismatch' }, 403);
    const [device] = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.id, agent.deviceId), eq(devices.orgId, agent.orgId)))
      .limit(1);
    if (!device) return c.json({ error: 'Device not found' }, 404);
    const result = await ingestWorkloadsReport({
      deviceId: agent.deviceId,
      orgId: agent.orgId,
      report: c.req.valid('json'),
      receivedAt: new Date(),
    });
    return c.json(result);
  },
);
