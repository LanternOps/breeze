import { Hono, type Context } from 'hono';
import { topologyChangesQuerySchema, topologyImpactQuerySchema } from '@breeze/shared';
import { getRecentTopologyChanges } from '../../services/topology/changes';
import { GraphReadError } from '../../services/topology/graphCursor';
import { getTopologyImpact } from '../../services/topology/impact';
import { requireTopologySiteCapability } from './middleware';
import { siteScopedQuery } from './query';

/**
 * M3 Task 10 investigation reads: cautious incident impact and recent change
 * history. Operation-specific extensions under the canonical site prefix, not
 * a second graph API. Both are passive evidence reads (`private, no-store`):
 * they never probe, poll, queue a command, run alert correlation, or touch an
 * alert's state, and per-view exclusions never change their inputs.
 */
export const topologyInvestigationRoutes = new Hono();
const invalid = (message = 'Invalid topology query') => new GraphReadError('invalid_topology_query', 400, message);
function read(handler: (c: Context) => Promise<object>) {
  return async (c: Context) => {
    c.header('Cache-Control', 'private, no-store');
    c.header('Vary', 'Authorization, Cookie');
    try {
      return c.json(await handler(c));
    } catch (error) {
      if (error instanceof GraphReadError) return c.json({ error: error.message, code: error.code }, error.status);
      throw error;
    }
  };
}
const integer = (value: string | undefined) => (value === undefined ? undefined : /^\d{1,5}$/.test(value) ? Number(value) : value);
const IMPACT_KEYS = new Set(['subjectKind', 'subjectId', 'graphRevision', 'windowMinutes']);
const CHANGE_KEYS = new Set(['since', 'until', 'limit', 'cursor']);
const base = '/sites/:siteId';
const authorized = requireTopologySiteCapability('read');

topologyInvestigationRoutes.get(`${base}/impact`, authorized, read((c) => {
  const query = siteScopedQuery(c, (message) => invalid(message));
  if (Object.keys(query).some((key) => !IMPACT_KEYS.has(key))) throw invalid();
  const parsed = topologyImpactQuerySchema.safeParse({
    subjectKind: query.subjectKind, subjectId: query.subjectId,
    ...(query.graphRevision === undefined ? {} : { graphRevision: query.graphRevision }),
    ...(query.windowMinutes === undefined ? {} : { windowMinutes: integer(query.windowMinutes) }),
  });
  if (!parsed.success) throw invalid('Invalid topology impact query');
  const { subjectKind, subjectId, graphRevision, windowMinutes } = parsed.data;
  return getTopologyImpact(c.get('topologyContext'), { kind: subjectKind, id: subjectId },
    { ...(graphRevision === undefined ? {} : { graphRevision }), windowMinutes });
}));

topologyInvestigationRoutes.get(`${base}/changes`, authorized, read((c) => {
  const query = siteScopedQuery(c, (message) => invalid(message));
  if (Object.keys(query).some((key) => !CHANGE_KEYS.has(key))) throw invalid();
  const parsed = topologyChangesQuerySchema.safeParse({
    since: query.since, until: query.until,
    ...(query.limit === undefined ? {} : { limit: integer(query.limit) }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  });
  if (!parsed.success) throw invalid('Invalid topology change query');
  return getRecentTopologyChanges(c.get('topologyContext'), parsed.data);
}));
