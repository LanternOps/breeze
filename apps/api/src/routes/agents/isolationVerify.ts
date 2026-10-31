import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { ACTIVE_STATES } from '@breeze/shared';
import { db } from '../../db';
import { deviceNetworkIsolations } from '../../db/schema';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import { withEpisodeLock, type EpisodeTx } from '../../services/networkIsolation/episodeStore';
import { PG_UUID_REGEX } from '../../utils/uuid';

export const isolationVerifyRoutes = new Hono();
isolationVerifyRoutes.use('*', requireAgentRole);
// Inherits agentAuthMiddleware from agentRoutes' /:id/* mount (including install fencing).
isolationVerifyRoutes.post('/:id/isolation/:isolationId/verify', async c => {
  const agent = c.get('agent');
  if (!agent?.deviceId || !agent.orgId) return c.json({ error: 'Agent context missing' }, 401);
  if (agent.agentId !== c.req.param('id')) return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('isolationId');
  if (!PG_UUID_REGEX.test(id)) return c.json({ error: 'Invalid isolation id' }, 400);
  const result = await withEpisodeLock(db as unknown as EpisodeTx, id, async row => {
    if (row.deviceId !== agent.deviceId || row.orgId !== agent.orgId) return false;
    if (row.desiredState !== 'isolated' || !ACTIVE_STATES.includes(row.state as never)) return false;
    const now = new Date();
    // This round trip is only the positive probe. The agent must still observe a drop before it
    // reports verified; never synthesize a journal sequence or the agent's verified state here.
    await db.update(deviceNetworkIsolations).set({ verifiedAt: now, updatedAt: now }).where(eq(deviceNetworkIsolations.id, row.id));
    return now;
  });
  if (!result.found) return c.json({ error: 'Isolation not found' }, 404);
  if (!result.value) return c.json({ error: 'Isolation not active for this device' }, 409);
  c.header('Date', result.value.toUTCString());
  return c.json({ verifiedAt: result.value.toISOString() });
});
