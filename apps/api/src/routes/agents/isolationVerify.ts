import { Hono } from 'hono';
import { isActiveIsolationState } from '@breeze/shared';
import { db, withDbTransaction } from '../../db';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import type { EpisodeTx } from '../../services/networkIsolation/episodeStore';
import { applyEpisodeEvent } from '../../services/networkIsolation/stateMachine';
import { captureException } from '../../services/sentry';
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
  const { withEpisodeLock, toEpisodeSnapshot, writeEpisodeSnapshot } = await import('../../services/networkIsolation/episodeStore');
  const result = await withDbTransaction(() => withEpisodeLock(db as unknown as EpisodeTx, id, async row => {
    if (row.deviceId !== agent.deviceId || row.orgId !== agent.orgId) {
      console.warn('[isolation] verify ownership mismatch', { agentId: agent.agentId, isolationId: id });
      captureException(new Error('Isolation verify ownership mismatch'), undefined, { phase: 'isolation_verify_tamper', agentId: agent.agentId, isolationId: id });
      return { status: 404 as const };
    }
    if (row.desiredState !== 'isolated' || !isActiveIsolationState(row.state)) return { status: 409 as const };
    const now = new Date();
    // This round trip is only the positive probe. The agent must still observe a drop before it
    // reports verified; never synthesize a journal sequence or the agent's verified state here.
    const previous = toEpisodeSnapshot(row);
    const transition = applyEpisodeEvent(previous, { type: 'server_probe_verified', generation: row.generation, at: now });
    if (!('next' in transition) || !await writeEpisodeSnapshot(db as unknown as EpisodeTx, row.id, previous, transition.next, now)) return { status: 409 as const };
    return { status: 200 as const, at: now };
  }));
  if (!result.found) return c.json({ error: 'Isolation not found' }, 404);
  if (result.value.status === 404) return c.json({ error: 'Isolation not found' }, 404);
  if (result.value.status !== 200) return c.json({ error: 'Isolation not active for this device' }, 409);
  c.header('Date', result.value.at.toUTCString());
  return c.json({ verifiedAt: result.value.at.toISOString() });
});
