import { describe, expect, it } from 'vitest';
import { topologyToolSchemas } from './aiToolSchemasTopology';
import { toolInputSchemas, validateToolInput } from './aiToolSchemas';
import { TOPOLOGY_AI_TOOL_NAMES } from './topology/aiToolGate';

const SITE = '11111111-1111-4111-8111-111111111111';
const REL = '22222222-2222-4222-8222-222222222222';

describe('topology AI tool input schemas', () => {
  it('defines a strict schema for every topology tool, merged into the central table', () => {
    const names = [...TOPOLOGY_AI_TOOL_NAMES, 'diagnose_connectivity'];
    expect(Object.keys(topologyToolSchemas).sort()).toEqual(names.sort());
    for (const name of names) expect(toolInputSchemas[name]).toBe(topologyToolSchemas[name]);
  });

  it('rejects scope and execution fields on a read tool', () => {
    const input = { site_id: SITE, relationship_id: REL, orgId: '33333333-3333-4333-8333-333333333333', rescan: true };
    expect(topologyToolSchemas.get_link_evidence!.safeParse(input).success).toBe(false);
    for (const name of TOPOLOGY_AI_TOOL_NAMES) {
      expect(validateToolInput(name, { site_id: SITE, org_id: SITE }).success, name).toBe(false);
    }
  });

  it('requires a site on every tool and bounds each read', () => {
    expect(topologyToolSchemas.get_topology!.safeParse({ view: 'overview' }).success).toBe(false);
    expect(topologyToolSchemas.get_topology!.safeParse({ site_id: SITE, view: 'overview', limit: 151 }).success).toBe(false);
    expect(topologyToolSchemas.get_topology!.safeParse({ site_id: SITE, view: 'overview', limit: 150, focus_node_id: REL, graph_revision: '12' }).success).toBe(true);
    expect(topologyToolSchemas.get_topology!.safeParse({ site_id: SITE, view: 'everything' }).success).toBe(false);
    expect(topologyToolSchemas.get_topology!.safeParse({ site_id: SITE, view: 'overview', focus_node_id: 'presentation:overview:x:y' }).success).toBe(false);
    expect(topologyToolSchemas.get_link_evidence!.safeParse({ site_id: SITE, relationship_id: REL, limit: 101 }).success).toBe(false);
    expect(topologyToolSchemas.get_link_evidence!.safeParse({ site_id: SITE, relationship_id: 'not-a-uuid' }).success).toBe(false);
    expect(topologyToolSchemas.get_diagnostic_run!.safeParse({ site_id: SITE, run_id: REL }).success).toBe(true);
    expect(topologyToolSchemas.get_diagnostic_run!.safeParse({ site_id: SITE }).success).toBe(false);
    expect(topologyToolSchemas.get_recent_network_changes!.safeParse({ site_id: SITE, since: '2026-09-26T00:00:00Z', until: '2026-09-26T01:00:00Z', limit: 101 }).success).toBe(false);
  });

  it('diagnose_connectivity accepts every fixed recipe and nothing that could name an arbitrary effect (M4 Task 4)', () => {
    const base = { site_id: SITE, subject: { kind: 'node', id: REL }, recipe_version: 1, graph_revision: '7' };
    for (const recipe_id of ['gateway_basic', 'dns_basic', 'internet_basic', 'target_connectivity', 'trace_route']) {
      expect(validateToolInput('diagnose_connectivity', { ...base, recipe_id }).success, recipe_id).toBe(true);
    }
    const schema = topologyToolSchemas.diagnose_connectivity!;
    expect(schema.safeParse({ ...base, recipe_id: 'gateway_basic', origin_device_id: REL, context_key: 'default', family: 'ipv6' }).success).toBe(true);
    expect(schema.safeParse({ ...base, recipe_id: 'shell' }).success).toBe(false);
    expect(schema.safeParse({ ...base, recipe_id: 'gateway_basic', recipe_version: 2 }).success).toBe(false);
    for (const extra of [{ action: 'run' }, { target: '8.8.8.8' }, { address: '10.0.0.1' }, { oid: '1.3.6' }, { command: 'ping' },
      { script: 'x' }, { body: 'x' }, { steps: [] }, { trace: { maxHops: 30 } }, { org_id: SITE }]) {
      expect(schema.safeParse({ ...base, recipe_id: 'gateway_basic', ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    expect(schema.safeParse({ ...base, recipe_id: 'gateway_basic', subject: { kind: 'address', id: REL } }).success).toBe(false);
  });
});
