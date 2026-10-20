import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../toolSources/resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../toolSources/resolver')>();
  return { ...actual, resolveTenantToolsForOwner: vi.fn() };
});

import { resolveTenantToolsForOwner, type TenantToolDescriptor } from '../toolSources/resolver';
import { FLOW_EXCLUDED_CORE_TOOLS, isRegisteredCoreTool, listFlowEligibleCoreTools, loadFlowCatalog } from './catalog';
import { m365ToolTiers } from '../aiToolsM365';

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
