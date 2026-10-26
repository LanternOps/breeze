/**
 * `manage_topology_manual` (full-control W08, #6778): the AI twin of
 * routes/topology/manual.ts — manual (operator-asserted) nodes and
 * relationships at one site.
 *
 * Tier 2 on every action: a manual assertion is a tenant-internal row with a
 * revision compare-and-swap; nothing leaves the tenant and no device is
 * touched. Topology rule: a manual node carries no device binding and no tool
 * argument can bind a device or move one between sites — this tool only draws
 * what an operator asserts. Authorization is the route's `write` capability
 * (topology:write + devices:read) on the named site.
 */
import {
  createManualNodeSchema, createManualRelationshipSchema, createTopologyManualNode, createTopologyManualRelationship,
  deleteManualSchema, deleteTopologyManualNode, deleteTopologyManualRelationship, updateManualNodeSchema, updateTopologyManualNode,
} from './topology/manual';
import { parseWrite } from './topology/writes';
import type { AiTool } from './aiTools';
import {
  TOPOLOGY_MANUAL_ACTIONS, TOPOLOGY_MANUAL_ROLES, TOPOLOGY_RELATIONSHIP_KINDS_ENUM,
} from './aiToolSchemasTopologyOps';
import { agentRefusal, boundedJson, defined, isAgentPrincipal, jsonError, requireFields, topologySite, topologyThrown } from './aiToolsTopologyShared';

type Action = (typeof TOPOLOGY_MANUAL_ACTIONS)[number];

export function registerTopologyManualTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('manage_topology_manual', {
    tier: 2,
    domain: 'network',
    searchHint: 'add or remove a switch, router, AP or link on the network map by hand',
    deviceArgs: [],
    captureExempt: true,
    definition: {
      name: 'manage_topology_manual',
      description:
        'Manual topology assertions at a site. Actions: create_node (label,role),update_node,delete_node (nodeId,expectedRevision),create_relationship (sourceNodeId,targetNodeId,kind),delete_relationship (relationshipId,expectedRevision).',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...TOPOLOGY_MANUAL_ACTIONS], description: 'The action to perform' },
          siteId: { type: 'string', description: 'Site UUID' },
          nodeId: { type: 'string', description: 'update_node/delete_node: manual node UUID' },
          relationshipId: { type: 'string', description: 'delete_relationship: manual link UUID' },
          label: { type: 'string', description: 'create_node/update_node/create_relationship: display label (max 255)' },
          role: { type: 'string', enum: [...TOPOLOGY_MANUAL_ROLES], description: 'create_node/update_node: device role' },
          notes: { type: 'string', description: 'Free-text notes (max 8192)' },
          prefix: { type: 'string', description: 'create_node: optional network prefix in CIDR form' },
          expectedRevision: { type: 'string', description: 'update/delete: the revision you last read; a stale value is refused' },
          sourceNodeId: { type: 'string', description: 'create_relationship: source node UUID' },
          targetNodeId: { type: 'string', description: 'create_relationship: target node UUID' },
          kind: { type: 'string', enum: [...TOPOLOGY_RELATIONSHIP_KINDS_ENUM], description: 'create_relationship: link kind' },
          sourceInterfaceId: { type: 'string', description: 'create_relationship: optional source interface UUID' },
          targetInterfaceId: { type: 'string', description: 'create_relationship: optional target interface UUID' },
        },
        required: ['action', 'siteId'],
        additionalProperties: false,
      },
    },

    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!TOPOLOGY_MANUAL_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      if (isAgentPrincipal(auth)) return agentRefusal(action);
      const site = await topologySite(auth, input.siteId, 'write');
      if ('error' in site) return site.error;
      const ctx = site.ctx;
      try {
        switch (action) {
          case 'create_node': {
            const missing = requireFields(input, ['label', 'role'], action);
            if (missing) return missing;
            const body = parseWrite(createManualNodeSchema, defined({ label: input.label, role: input.role, notes: input.notes, prefix: input.prefix }));
            return boundedJson(await createTopologyManualNode(ctx, body));
          }
          case 'update_node': {
            const missing = requireFields(input, ['nodeId', 'expectedRevision'], action);
            if (missing) return missing;
            const body = parseWrite(updateManualNodeSchema, defined({ expectedRevision: input.expectedRevision, label: input.label, role: input.role, notes: input.notes }));
            return boundedJson(await updateTopologyManualNode(ctx, String(input.nodeId), body));
          }
          case 'delete_node': {
            const missing = requireFields(input, ['nodeId', 'expectedRevision'], action);
            if (missing) return missing;
            return boundedJson(await deleteTopologyManualNode(ctx, String(input.nodeId), parseWrite(deleteManualSchema, { expectedRevision: input.expectedRevision })));
          }
          case 'create_relationship': {
            const missing = requireFields(input, ['sourceNodeId', 'targetNodeId', 'kind'], action);
            if (missing) return missing;
            const body = parseWrite(createManualRelationshipSchema, defined({
              sourceNodeId: input.sourceNodeId, targetNodeId: input.targetNodeId, kind: input.kind,
              sourceInterfaceId: input.sourceInterfaceId, targetInterfaceId: input.targetInterfaceId,
              label: input.label, notes: input.notes,
            }));
            return boundedJson(await createTopologyManualRelationship(ctx, body));
          }
          case 'delete_relationship': {
            const missing = requireFields(input, ['relationshipId', 'expectedRevision'], action);
            if (missing) return missing;
            return boundedJson(await deleteTopologyManualRelationship(
              ctx, String(input.relationshipId), parseWrite(deleteManualSchema, { expectedRevision: input.expectedRevision }),
            ));
          }
        }
      } catch (error) {
        return topologyThrown('manage_topology_manual', error);
      }
    },
  });
}
