import { Hono, type Context } from 'hono';
import { graphQuerySchema } from '@breeze/shared';
import { GraphReadError, nodeListQuerySchema } from '../../services/topology/graphCursor';
import {
  getTopologyGraph, listTopologyNodes, getTopologyNode, getTopologyRelationship,
  getTopologyRelationshipEvidence, getTopologyGroupMembers, expandTopologyGraph,
  getTopologyHealth, getTopologyReadEtag, evidenceQuerySchema, healthQuerySchema,
} from '../../services/topology/graph';
import { requireTopologySiteCapability } from './middleware';

export const topologyGraphRoutes = new Hono();
function read(handler: (c: Context) => Promise<object>, sensitive = false) {
  return async (c: Context) => {
    c.header('Cache-Control', sensitive ? 'private, no-store' : 'private, no-cache, max-age=0');
    c.header('Vary', 'Authorization, Cookie');
    try {
      const body = await handler(c);
      const etag = sensitive ? undefined : getTopologyReadEtag(body);
      if (etag) {
        c.header('ETag', etag);
        if (c.req.header('If-None-Match')?.split(',').map((value) => value.trim()).includes(etag)) return c.body(null, 304);
      }
      return c.json(body);
    } catch (error) {
      if (error instanceof GraphReadError) return c.json({ error: error.message, code: error.code }, error.status);
      throw error;
    }
  };
}
function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new GraphReadError('invalid_topology_query', 400, 'Invalid topology query');
  return result.data;
}
const base = '/sites/:siteId';
const authorized = requireTopologySiteCapability('read');
topologyGraphRoutes.get(`${base}/graph`, authorized, read((c) => getTopologyGraph(c.get('topologyContext'), parse(graphQuerySchema, c.req.query()))));
topologyGraphRoutes.get(`${base}/nodes`, authorized, read((c) => listTopologyNodes(c.get('topologyContext'), parse(nodeListQuerySchema, c.req.query()))));
topologyGraphRoutes.get(`${base}/nodes/:nodeId`, authorized, read((c) => getTopologyNode(c.get('topologyContext'), c.req.param('nodeId') ?? '')));
topologyGraphRoutes.get(`${base}/relationships/:relationshipId`, authorized, read((c) => getTopologyRelationship(c.get('topologyContext'), c.req.param('relationshipId') ?? '')));
topologyGraphRoutes.get(`${base}/relationships/:relationshipId/evidence`, authorized, read((c) => getTopologyRelationshipEvidence(c.get('topologyContext'), c.req.param('relationshipId') ?? '', parse(evidenceQuerySchema, c.req.query())), true));
topologyGraphRoutes.get(`${base}/groups/:nodeId/members`, authorized, read((c) => {
  const { cursor, ...query } = c.req.query();
  return getTopologyGroupMembers(c.get('topologyContext'), c.req.param('nodeId') ?? '', parse(graphQuerySchema, query), cursor);
}));
topologyGraphRoutes.get(`${base}/expansions/:token`, authorized, read((c) => expandTopologyGraph(c.get('topologyContext'), c.req.param('token') ?? '')));
topologyGraphRoutes.get(`${base}/health`, authorized, read((c) => {
  const query = c.req.query();
  const keys = Object.keys(query);
  if (keys.some((key) => !['nodeIds', 'relationshipIds', 'graphRevision'].includes(key))) throw new GraphReadError('invalid_topology_query', 400, 'Invalid topology query');
  return getTopologyHealth(c.get('topologyContext'), parse(healthQuerySchema, {
    nodeIds: query.nodeIds ? query.nodeIds.split(',') : [], relationshipIds: query.relationshipIds ? query.relationshipIds.split(',') : [],
    ...(query.graphRevision === undefined ? {} : { graphRevision: query.graphRevision }),
  }));
}));
