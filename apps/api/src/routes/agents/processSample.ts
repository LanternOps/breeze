import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { bodyLimit } from 'hono/body-limit';
import { db } from '../../db';
import { deviceProcessSamples } from '../../db/schema';
import { type AgentAuthContext } from '../../middleware/agentAuth';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import { processSampleSchema } from './schemas';

export const processSampleRoutes = new Hono();
// Process-sample ingest is the main agent's job; reject watchdog-role tokens so
// a weaker credential can't falsify operator-facing process posture (F8).
processSampleRoutes.use('*', requireAgentRole);

processSampleRoutes.post(
  '/:id/process-sample',
  bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: 'Request body too large' }, 413) }),
  zValidator('json', processSampleSchema),
  async (c) => {
    const agentId = c.req.param('id');
    const data = c.req.valid('json');
    const agent = c.get('agent') as AgentAuthContext | undefined;

    // Tenancy is derived server-side from the authenticated device — the agent
    // payload is never trusted for org_id, and the path id must match the token.
    // `:id` is the AGENT id here, matching every sibling agent ingest route
    // (inventory, connections, heartbeat) and what the agent actually sends.
    if (!agent || agent.agentId !== agentId) {
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
