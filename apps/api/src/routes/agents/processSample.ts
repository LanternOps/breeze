import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { bodyLimit } from 'hono/body-limit';
import { db } from '../../db';
import { deviceProcessSamples } from '../../db/schema';
import { type AgentAuthContext } from '../../middleware/agentAuth';
import { processSampleSchema } from './schemas';

export const processSampleRoutes = new Hono();

processSampleRoutes.post(
  '/:id/process-sample',
  bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: 'Request body too large' }, 413) }),
  zValidator('json', processSampleSchema),
  async (c) => {
    const deviceId = c.req.param('id');
    const data = c.req.valid('json');
    const agent = c.get('agent') as AgentAuthContext | undefined;

    // Tenancy is derived server-side from the authenticated device — the agent
    // payload is never trusted for org_id, and the path id must match the token.
    if (!agent || agent.deviceId !== deviceId) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    await db.insert(deviceProcessSamples).values({
      deviceId: agent.deviceId,
      orgId: agent.orgId,
      timestamp: new Date(),                       // server receive time
      agentTimestamp: new Date(data.timestamp),    // agent-reported, forensic
      topProcesses: data.processes
    });

    return c.json({ success: true }, 201);
  }
);
