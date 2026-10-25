import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../toolSources/resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../toolSources/resolver')>();
  return { ...actual, resolveTenantToolsForOwner: vi.fn() };
});

import { resolveTenantToolsForOwner, type TenantToolDescriptor } from '../toolSources/resolver';
import { FLOW_EXCLUDED_CORE_TOOLS, isRegisteredCoreTool, listFlowEligibleCoreTools, loadFlowCatalog } from './catalog';
import { m365ToolTiers } from '../aiToolsM365';
import { listAgentReachableTools } from '../aiAgents/agentToolCatalog';

const OWNER = { orgId: '11111111-1111-4111-8111-111111111111', partnerId: '22222222-2222-4222-8222-222222222222' };

function tenantTool(qualifiedName: string): TenantToolDescriptor {
  return {
    id: 't1', sourceId: 's1', sourceName: 'Halo', sourceKind: 'mcp', ownerRef: { orgId: OWNER.orgId, partnerId: null },
    qualifiedName, name: qualifiedName.split('__')[1]!, description: '', tier: 3, revision: 'r',
    rateLimitPerMinute: 60, inputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
    validate: () => ({ success: true }), definition: { name: qualifiedName, description: '', input_schema: {} },
  };
}

describe('loadFlowCatalog', () => {
  beforeEach(() => {
    vi.mocked(resolveTenantToolsForOwner).mockResolvedValue([tenantTool('halo__create_ticket')]);
  });

  it('includes built-ins as builtin entries', async () => {
    const cat = await loadFlowCatalog(OWNER);
    expect(cat.get('wait')).toEqual({ source: 'builtin', name: 'wait' });
    expect(cat.get('set')).toEqual({ source: 'builtin', name: 'set' });
    expect(cat.has('notify')).toBe(false);
  });

  it('excludes agent human-only, session-only M365 and the flow tools themselves', async () => {
    const cat = await loadFlowCatalog(OWNER);
    expect(isRegisteredCoreTool('manage_ai_agents')).toBe(true);
    expect(cat.has('manage_ai_agents')).toBe(false);
    const m365 = Object.keys(m365ToolTiers)[0]!;
    expect(cat.has(m365)).toBe(false);
    for (const name of FLOW_EXCLUDED_CORE_TOOLS) expect(cat.has(name)).toBe(false);
    expect(listFlowEligibleCoreTools()).not.toContain('manage_ai_agents');
  });

  it('excludes the Wisp memory tools: agent-reachable, but a flow step never carries a Wisp grant', async () => {
    const reachable = listAgentReachableTools();
    const eligible = listFlowEligibleCoreTools();
    for (const name of ['remember', 'recall']) {
      expect(isRegisteredCoreTool(name), name).toBe(true);
      expect(reachable, name).toContain(name);
      expect(eligible, name).not.toContain(name);
      expect(FLOW_EXCLUDED_CORE_TOOLS.has(name), name).toBe(true);
    }
    // confirm_memory / retract_memory are human-only, so already unreachable
    // (and therefore never flow-eligible) without an explicit exclusion.
    for (const name of ['confirm_memory', 'retract_memory']) {
      expect(isRegisteredCoreTool(name), name).toBe(true);
      expect(reachable, name).not.toContain(name);
      expect(eligible, name).not.toContain(name);
    }
    const cat = await loadFlowCatalog(OWNER);
    expect(cat.has('remember')).toBe(false);
    expect(cat.has('recall')).toBe(false);
  });

  it('excludes the Wisp W05a concern chat tools for the same reason (grant-required, never in a flow)', () => {
    // Registered by W05a (#9911); listed here so the exclusion is in place
    // whichever of the two PRs lands first.
    for (const name of ['list_concerns', 'raise_concern', 'snooze_concern', 'resolve_concern', 'create_watch']) {
      expect(FLOW_EXCLUDED_CORE_TOOLS.has(name), name).toBe(true);
      expect(listFlowEligibleCoreTools(), name).not.toContain(name);
    }
  });

  it('includes a reachable core tool with its deviceArgs', async () => {
    const cat = await loadFlowCatalog(OWNER);
    const entry = cat.get('get_device_details');
    expect(entry).toMatchObject({ source: 'core', name: 'get_device_details' });
    expect(entry && entry.source === 'core' ? entry.deviceArgs : []).toContain('deviceId');
  });

  it('includes the owner tenant tools with a structured-error validator, resolved for the owner', async () => {
    const cat = await loadFlowCatalog(OWNER);
    const entry = cat.get('halo__create_ticket');
    expect(entry?.source).toBe('tenant');
    expect(resolveTenantToolsForOwner).toHaveBeenCalledWith(OWNER);
    if (entry?.source === 'tenant') {
      expect(entry.validate({ summary: 1 })).toBe(false);
      expect(entry.validate.errors?.[0]?.instancePath).toBe('/summary');
    }
  });
});
