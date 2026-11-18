import { describe, expect, it } from 'vitest';
import { aiTools } from './aiToolNames';
import { toolInputSchemas, validateToolInput } from './aiToolSchemas';
import { topologyOpsToolShapes } from './aiToolSchemasTopologyOps';
import { toolActionEnum } from './aiToolActions';

// W08 (#6778): the registry input_schema, the toolInputSchemas entry and the SDK shape must agree
// (inputShape() takes the Zod .shape directly, so Zod IS the SDK surface).
const W08_TOOLS = Object.keys(topologyOpsToolShapes);
const UUID = '11111111-1111-4111-8111-111111111111';
const shapeOf = (name: string) => (toolInputSchemas[name] as unknown as { shape: Record<string, { isOptional: () => boolean }> }).shape;

describe('W08 topology tool input schemas', () => {
  it('covers exactly the six new W08 tools', () => {
    expect([...W08_TOOLS].sort()).toEqual([
      'apply_topology_template', 'get_topology_graph', 'manage_topology_manual',
      'manage_topology_monitoring', 'manage_topology_templates', 'run_topology_diagnostic',
    ]);
  });

  it.each(W08_TOOLS)('%s: registry properties and Zod keys agree, strict', (name) => {
    const schema = aiTools.get(name)!.definition.input_schema as { properties: Record<string, unknown>; additionalProperties?: boolean };
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(shapeOf(name)).sort());
    expect(schema.additionalProperties).toBe(false);
  });

  it.each(W08_TOOLS)('%s: every registry-required key is required by Zod too', (name) => {
    const required = (aiTools.get(name)!.definition.input_schema as { required?: string[] }).required ?? [];
    expect(required.length).toBeGreaterThan(0);
    for (const key of required) {
      expect(shapeOf(name)[key]!.isOptional(), `${name}.${key} is required in the registry but optional in Zod`).toBe(false);
    }
  });

  it.each(W08_TOOLS)('%s: action enum agrees with the registry', (name) => {
    const schema = aiTools.get(name)!.definition.input_schema as { properties: { action: { enum: string[] } } };
    expect([...schema.properties.action.enum].sort()).toEqual([...(toolActionEnum(name) ?? [])].sort());
  });

  it('the new tools live in the network domain at the expected registry tiers', () => {
    expect(aiTools.get('get_topology_graph')).toMatchObject({ domain: 'network', tier: 1 });
    expect(aiTools.get('run_topology_diagnostic')).toMatchObject({ domain: 'network', tier: 1 });
    expect(aiTools.get('manage_topology_manual')).toMatchObject({ domain: 'network', tier: 2 });
    expect(aiTools.get('manage_topology_monitoring')).toMatchObject({ domain: 'network', tier: 1 });
    expect(aiTools.get('manage_topology_templates')).toMatchObject({ domain: 'network', tier: 1 });
    expect(aiTools.get('apply_topology_template')).toMatchObject({ domain: 'network', tier: 1 });
  });

  it('only the diagnostic origin and the node device filter carry a device arg, and no tool can name a device to move between sites', () => {
    expect(aiTools.get('run_topology_diagnostic')!.deviceArgs).toEqual(['originDeviceId']);
    expect(aiTools.get('get_topology_graph')!.deviceArgs).toEqual(['deviceId']);
    for (const name of W08_TOOLS.filter((n) => n !== 'run_topology_diagnostic' && n !== 'get_topology_graph')) {
      expect(aiTools.get(name)!.deviceArgs ?? [], name).toEqual([]);
    }
    // Topology rule: no argument anywhere sets a site for a device.
    for (const name of W08_TOOLS) {
      for (const key of Object.keys(shapeOf(name))) {
        expect(key, `${name}.${key}`).not.toMatch(/^(newSiteId|targetSiteId|moveToSite|destinationSiteId)$/);
      }
    }
  });

  it.each(W08_TOOLS)('%s rejects an unknown key (strict)', (name) => {
    const base = name === 'manage_topology_templates' ? { action: 'list_templates' }
      : name === 'apply_topology_template' ? { action: 'status' }
        : { action: name === 'get_topology_graph' ? 'graph' : name === 'run_topology_diagnostic' ? 'get' : name === 'manage_topology_manual' ? 'create_node' : 'get_settings', siteId: UUID };
    expect(validateToolInput(name, base).success).toBe(true);
    expect(validateToolInput(name, { ...base, surprise: true }).success).toBe(false);
  });

  it('accepts representative valid inputs', () => {
    expect(validateToolInput('get_topology_graph', { action: 'nodes', siteId: UUID, q: 'core', kind: 'gateway', limit: 50 }).success).toBe(true);
    expect(validateToolInput('get_topology_graph', { action: 'health', siteId: UUID, nodeIds: [UUID], relationshipIds: [UUID] }).success).toBe(true);
    expect(validateToolInput('run_topology_diagnostic', { action: 'start', siteId: UUID, recipeId: 'gateway_basic', subjectKind: 'node', subjectId: UUID, graphRevision: '12' }).success).toBe(true);
    expect(validateToolInput('manage_topology_manual', { action: 'create_node', siteId: UUID, label: 'Core switch', role: 'switch' }).success).toBe(true);
    expect(validateToolInput('manage_topology_monitoring', { action: 'upsert_target', siteId: UUID, key: 'dns_ext', definition: { kind: 'tcp' }, expectedRevision: '3' }).success).toBe(true);
    expect(validateToolInput('manage_topology_templates', { action: 'publish_version', templateId: UUID, versionId: UUID, expectedTemplateRevision: '1', expectedVersionRevision: '2' }).success).toBe(true);
    expect(validateToolInput('apply_topology_template', { action: 'preview', partnerVersionId: null, orgVersionId: UUID, sites: [{ siteId: UUID, expectedBindingRevision: '0' }] }).success).toBe(true);
    expect(validateToolInput('apply_topology_template', { action: 'apply', token: 'abc' }).success).toBe(true);
  });

  it('rejects malformed ids, out-of-range numbers and unknown enum values', () => {
    expect(validateToolInput('get_topology_graph', { action: 'node', siteId: 'nope' }).success).toBe(false);
    expect(validateToolInput('get_topology_graph', { action: 'graph', siteId: UUID, hops: 3 }).success).toBe(false);
    expect(validateToolInput('get_topology_graph', { action: 'delete', siteId: UUID }).success).toBe(false);
    expect(validateToolInput('get_topology_graph', { siteId: UUID }).success).toBe(false); // action is required
    expect(validateToolInput('run_topology_diagnostic', { action: 'start', siteId: UUID, recipeId: 'rm_rf' }).success).toBe(false);
    expect(validateToolInput('run_topology_diagnostic', { action: 'start', siteId: UUID, maxHops: 31 }).success).toBe(false);
    expect(validateToolInput('manage_topology_manual', { action: 'create_node', siteId: UUID, role: 'toaster' }).success).toBe(false);
    expect(validateToolInput('manage_topology_manual', { action: 'delete_node', siteId: UUID, expectedRevision: '-1' }).success).toBe(false);
    expect(validateToolInput('manage_topology_templates', { action: 'update_template', templateId: UUID, lifecycle: 'revoked' }).success).toBe(false); // revoke_template is its own supervised action
    expect(validateToolInput('apply_topology_template', { action: 'preview', sites: [] }).success).toBe(false);
  });
});
