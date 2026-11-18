/**
 * Input schemas for the W08 network-topology tools (full-control W08, #6778):
 * `get_topology_graph`, `run_topology_diagnostic`, `manage_topology_manual`,
 * `manage_topology_monitoring`, `manage_topology_templates`,
 * `apply_topology_template`.
 *
 * Plain strict `z.object`s with an `action` enum (no unions or refinements) so
 * `toolActionEnum` can read `.shape.action.options` and the chat SDK `tool()`
 * declarations can take `.shape` directly. Per-action required fields and the
 * deep payload shapes (policy/target definitions, template payloads) are
 * validated in the handlers by the SAME Zod schemas the REST routes use, so a
 * payload is `z.record(...)` here. No `z.undefined()` anywhere: it empties the
 * model's tool list.
 *
 * Keys and enums mirror each tool's registry `input_schema` one-for-one;
 * aiToolSchemas.topologyOps.test.ts pins that.
 */
import { z } from 'zod';

export const TOPOLOGY_GRAPH_ACTIONS = [
  'graph', 'nodes', 'node', 'relationship', 'evidence', 'group_members', 'expansion', 'health',
] as const;
export const TOPOLOGY_DIAGNOSTIC_ACTIONS = ['collectors', 'start', 'get', 'cancel'] as const;
export const TOPOLOGY_MANUAL_ACTIONS = [
  'create_node', 'update_node', 'delete_node', 'create_relationship', 'delete_relationship',
] as const;
export const TOPOLOGY_MONITORING_ACTIONS = [
  'list_policies', 'upsert_policy', 'delete_policy',
  'list_targets', 'upsert_target', 'delete_target',
  'get_settings', 'patch_settings',
] as const;
export const TOPOLOGY_TEMPLATE_ACTIONS = [
  'list_templates', 'create_template', 'update_template', 'revoke_template',
  'list_versions', 'create_version', 'publish_version', 'site_options',
] as const;
export const TOPOLOGY_APPLY_ACTIONS = ['preview', 'apply', 'status'] as const;

export const TOPOLOGY_RECIPES = ['gateway_basic', 'dns_basic', 'internet_basic', 'target_connectivity', 'trace_route'] as const;
export const TOPOLOGY_VIEWS_ENUM = ['overview', 'physical', 'logical'] as const;
export const TOPOLOGY_NODE_KINDS_ENUM = ['endpoint', 'network', 'gateway', 'internet', 'manual'] as const;
export const TOPOLOGY_MANUAL_ROLES = ['switch', 'router', 'ap', 'firewall', 'patch_panel', 'other'] as const;
export const TOPOLOGY_RELATIONSHIP_KINDS_ENUM = [
  'network_member', 'default_route', 'egress_path', 'physical_link', 'attachment',
] as const;

const uuid = z.string().guid();
const revision = z.string().regex(/^(0|[1-9]\d*)$/).max(19);
const payload = z.record(z.string(), z.unknown());

export const topologyOpsToolShapes = {
  get_topology_graph: {
    action: z.enum(TOPOLOGY_GRAPH_ACTIONS),
    siteId: uuid,
    view: z.enum(TOPOLOGY_VIEWS_ENUM).optional(),
    focusNodeId: uuid.optional(),
    hops: z.number().int().min(0).max(2).optional(),
    includeHealth: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().max(2048).optional(),
    q: z.string().trim().max(200).optional(),
    kind: z.enum(TOPOLOGY_NODE_KINDS_ENUM).optional(),
    deviceId: uuid.optional(),
    lifecycle: z.enum(['active', 'withdrawn', 'archived']).optional(),
    health: z.enum(['unknown', 'healthy', 'degraded', 'failed_check']).optional(),
    nodeId: uuid.optional(),
    relationshipId: uuid.optional(),
    token: z.string().max(4096).optional(),
    nodeIds: z.array(uuid).max(200).optional(),
    relationshipIds: z.array(uuid).max(400).optional(),
    graphRevision: revision.optional(),
  },
  run_topology_diagnostic: {
    action: z.enum(TOPOLOGY_DIAGNOSTIC_ACTIONS),
    siteId: uuid,
    recipeId: z.enum(TOPOLOGY_RECIPES).optional(),
    subjectKind: z.enum(['node', 'relationship', 'destination']).optional(),
    subjectId: uuid.optional(),
    graphRevision: revision.optional(),
    originDeviceId: uuid.optional(),
    contextKey: z.string().max(255).optional(),
    family: z.enum(['ipv4', 'ipv6']).optional(),
    maxHops: z.number().int().min(1).max(30).optional(),
    probesPerHop: z.number().int().min(1).max(2).optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
    runId: uuid.optional(),
  },
  manage_topology_manual: {
    action: z.enum(TOPOLOGY_MANUAL_ACTIONS),
    siteId: uuid,
    nodeId: uuid.optional(),
    relationshipId: uuid.optional(),
    label: z.string().trim().max(255).optional(),
    role: z.enum(TOPOLOGY_MANUAL_ROLES).optional(),
    notes: z.string().max(8192).optional(),
    prefix: z.string().max(128).optional(),
    expectedRevision: revision.optional(),
    sourceNodeId: uuid.optional(),
    targetNodeId: uuid.optional(),
    kind: z.enum(TOPOLOGY_RELATIONSHIP_KINDS_ENUM).optional(),
    sourceInterfaceId: uuid.optional(),
    targetInterfaceId: uuid.optional(),
  },
  manage_topology_monitoring: {
    action: z.enum(TOPOLOGY_MONITORING_ACTIONS),
    siteId: uuid,
    id: uuid.optional(),
    key: z.string().max(64).optional(),
    definition: payload.optional(),
    overrides: payload.optional(),
    expectedRevision: revision.optional(),
    cursor: z.string().max(64).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
  manage_topology_templates: {
    action: z.enum(TOPOLOGY_TEMPLATE_ACTIONS),
    siteId: uuid.optional(),
    ownerScope: z.enum(['partner', 'organization']).optional(),
    orgId: uuid.optional(),
    templateId: uuid.optional(),
    versionId: uuid.optional(),
    key: z.string().max(64).optional(),
    name: z.string().trim().max(255).optional(),
    description: z.string().max(2048).nullable().optional(),
    lifecycle: z.enum(['active', 'archived']).optional(),
    payload: payload.optional(),
    expectedRevision: revision.optional(),
    expectedTemplateRevision: revision.optional(),
    expectedVersionRevision: revision.optional(),
    cursor: z.string().max(64).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
  apply_topology_template: {
    action: z.enum(TOPOLOGY_APPLY_ACTIONS),
    partnerVersionId: uuid.nullable().optional(),
    orgVersionId: uuid.nullable().optional(),
    sites: z.array(z.object({
      siteId: uuid,
      expectedBindingRevision: revision,
      overrides: payload.optional(),
    }).strict()).min(1).max(100).optional(),
    token: z.string().max(4096).optional(),
    operationId: uuid.optional(),
  },
} as const;

export const topologyOpsToolSchemas: Record<string, z.ZodType> = Object.fromEntries(
  Object.entries(topologyOpsToolShapes).map(([name, shape]) => [name, z.object(shape).strict()]),
);
