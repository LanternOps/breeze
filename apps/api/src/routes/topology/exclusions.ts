import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { createViewExclusion, revokeViewExclusion, listViewExclusions, createViewExclusionSchema, listViewExclusionsQuerySchema } from '../../services/topology/exclusions';
import { GraphReadError } from '../../services/topology/graphCursor';
import { parseWrite } from '../../services/topology/writes';
import { requireTopologySiteCapability } from './middleware';
import { topologyMutation } from './mutations';
import { siteScopedQuery } from './query';

/**
 * M2 D17 reversible view exclusions. Hiding/restoring needs topology write on
 * the exact site; listing hidden connections needs topology read + device
 * read. Path ids are validated here so a malformed or `presentation:` id never
 * reaches a service; a cross-scope id is a 404 from the scoped service.
 */
export const topologyExclusionRoutes = new Hono();
const base = '/sites/:siteId';
const uuid = z.string().uuid();
const write = requireTopologySiteCapability('write');
const param = (c: Context, name: string) => parseWrite(uuid, c.req.param(name) ?? '');

topologyExclusionRoutes.post(`${base}/relationships/:relationshipId/exclusions`, write, topologyMutation((c, body) =>
  createViewExclusion(c.get('topologyContext'), param(c, 'relationshipId'), parseWrite(createViewExclusionSchema, body)), 201));
topologyExclusionRoutes.delete(`${base}/relationships/:relationshipId/exclusions/:exclusionId`, write, topologyMutation((c) =>
  revokeViewExclusion(c.get('topologyContext'), param(c, 'relationshipId'), param(c, 'exclusionId')), 200, { body: false }));
topologyExclusionRoutes.get(`${base}/exclusions`, requireTopologySiteCapability('read'), async (c) => {
  // Hidden-connection reasons are user text tied to one authority: never cache.
  c.header('Cache-Control', 'private, no-store');
  c.header('Vary', 'Authorization, Cookie');
  try {
    const parsed = listViewExclusionsQuerySchema.safeParse(siteScopedQuery(c, (message) => new GraphReadError('invalid_topology_query', 400, message)));
    if (!parsed.success) throw new GraphReadError('invalid_topology_query', 400, 'Invalid topology query');
    return c.json(await listViewExclusions(c.get('topologyContext'), parsed.data));
  } catch (error) {
    if (error instanceof GraphReadError) return c.json({ error: error.message, code: error.code }, error.status);
    throw error;
  }
});
