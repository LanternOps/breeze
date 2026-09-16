import { Hono } from 'hono';
import { createTopologyManualNode, updateTopologyManualNode, deleteTopologyManualNode, createTopologyManualRelationship, deleteTopologyManualRelationship,
  createManualNodeSchema, updateManualNodeSchema, deleteManualSchema, createManualRelationshipSchema } from '../../services/topology/manual';
import { parseWrite } from '../../services/topology/writes';
import { requireTopologySiteCapability } from './middleware';
import { topologyMutation } from './mutations';

export const topologyManualRoutes = new Hono();
const base = '/sites/:siteId';
const write = requireTopologySiteCapability('write');
topologyManualRoutes.post(`${base}/manual-nodes`, write, topologyMutation((c, body) => createTopologyManualNode(c.get('topologyContext'), parseWrite(createManualNodeSchema, body)), 201));
topologyManualRoutes.patch(`${base}/manual-nodes/:nodeId`, write, topologyMutation((c, body) => updateTopologyManualNode(c.get('topologyContext'), c.req.param('nodeId') ?? '', parseWrite(updateManualNodeSchema, body))));
topologyManualRoutes.delete(`${base}/manual-nodes/:nodeId`, write, topologyMutation((c, body) => deleteTopologyManualNode(c.get('topologyContext'), c.req.param('nodeId') ?? '', parseWrite(deleteManualSchema, body))));
topologyManualRoutes.post(`${base}/manual-relationships`, write, topologyMutation((c, body) => createTopologyManualRelationship(c.get('topologyContext'), parseWrite(createManualRelationshipSchema, body)), 201));
topologyManualRoutes.delete(`${base}/manual-relationships/:relationshipId`, write, topologyMutation((c, body) => deleteTopologyManualRelationship(c.get('topologyContext'), c.req.param('relationshipId') ?? '', parseWrite(deleteManualSchema, body))));
