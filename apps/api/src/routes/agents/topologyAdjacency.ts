import { Hono } from 'hono';
import { z } from 'zod';
import { parseAdjacencyV2Report } from '@breeze/shared';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import { ensureDiscoveryTopologyAuthority } from '../../services/topology/discoveryDispatch';
import { admitDiscoveryAdjacencyReport, type DiscoveryAdjacencyOutcome } from '../../services/topology/discoveryTransport';
import { loadTopologyFlags, withResolvedTopologyFlags } from '../../services/topology/flags';
import { captureException } from '../../services/sentry';
import { pgErrorCode } from '../../utils/pgErrors';

/**
 * M2 D14: `POST /agents/:id/topology/adjacency` — one AdjacencyV2 report for
 * one authorized discovery target per request (no chunks). Authority comes
 * from the token-resolved device and the stored dispatch snapshot of the named
 * parent job, never from the payload. The response carries synchronous M1
 * ingest receipts per section.
 *
 * Self-manages its DB context (agentAuth SELF_MANAGED_DB_CONTEXT_TWO_SEGMENT_ACTIONS):
 * the 4 MiB body is parsed and validated with no connection held, flags are
 * resolved before the lock-holding transaction (heartbeat #6671 lesson), and
 * the admission runs in one short org-scoped transaction.
 */
export const topologyAdjacencyRoutes = new Hono();
topologyAdjacencyRoutes.use('/:id/topology/adjacency', requireAgentRole);

const bodySchema = z.object({ parentJobId: z.uuid(), report: z.unknown() }).strict();
class RollbackOutcome extends Error {
  constructor(readonly outcome: DiscoveryAdjacencyOutcome) { super('rollback'); }
}

topologyAdjacencyRoutes.post('/:id/topology/adjacency', async (c) => {
  const agent = c.get('agent') as { deviceId?: string; orgId?: string; siteId?: string; partnerId?: string | null } | undefined;
  if (!agent?.deviceId || !agent.orgId || !agent.siteId) return c.json({ error: 'agent device context missing' }, 403);
  let raw: unknown;
  try { raw = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const body = bodySchema.safeParse(raw);
  if (!body.success) return c.json({ error: 'invalid_report' }, 400);
  const parsed = parseAdjacencyV2Report(body.data.report);
  if (!parsed.accepted) return c.json({ error: parsed.reason }, 400);
  const report = parsed.report;
  if (report.parentJobId !== body.data.parentJobId || report.parentCommandId !== body.data.parentJobId) return c.json({ error: 'parent_mismatch' }, 400);

  ensureDiscoveryTopologyAuthority();
  const orgId = agent.orgId, deviceId = agent.deviceId;
  let flags;
  try {
    flags = await withSystemDbAccessContext(() => loadTopologyFlags({ scope: { orgId, siteId: agent.siteId! } }));
  } catch (error) {
    captureException(error);
    return c.json({ error: 'collection_unavailable' }, 503);
  }
  if (!flags.materialization) return c.json({ error: 'materialization_disabled' }, 409);
  let outcome: DiscoveryAdjacencyOutcome;
  try {
    outcome = await withResolvedTopologyFlags({ orgId, flags }, () => withDbAccessContext({
      scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], currentPartnerId: agent.partnerId ?? null,
    }, () => db.transaction(async () => {
      const result = await admitDiscoveryAdjacencyReport({ deviceId, orgId, report });
      // A rejected report leaves no trace: roll back anything a section wrote.
      if (result.status !== 200) throw new RollbackOutcome(result);
      return result;
    })));
  } catch (error) {
    if (error instanceof RollbackOutcome) outcome = error.outcome;
    else if (pgErrorCode(error) === '55P03') return c.json({ error: 'producer_busy' }, 503);
    else throw error;
  }
  return c.json(outcome.body, outcome.status);
});
