import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ permissions: vi.fn(), access: vi.fn(), history: vi.fn(), link: vi.fn(), command: vi.fn() }));
vi.mock('./permissions', async (original) => ({ ...await original<object>(), getUserPermissions: mocks.permissions }));
vi.mock('./topology/access', async (original) => ({ ...await original<object>(), requireTopologySiteAccess: mocks.access }));
vi.mock('./topology/interfaceHistory', () => ({ getTopologyInterfaceHistory: mocks.history }));
vi.mock('./topology/graph', () => ({ getTopologyLinkHealth: mocks.link }));
vi.mock('./commandQueue', () => ({ executeCommand: mocks.command, queueCommand: mocks.command, queueCommandForExecution: mocks.command }));
import type { AiTool } from './aiTools';
import { AI_INTERFACE_HISTORY_MAX_BUCKETS, registerTopologyTools } from './aiToolsTopology';
import { TopologyError } from './topology/access';

const SITE = '20000000-0000-4000-8000-000000000001';
const IF = '30000000-0000-4000-8000-000000000001';
const REL = '40000000-0000-4000-8000-000000000001';
const auth = { user: { id: '50000000-0000-4000-8000-000000000001' }, scope: 'organization', orgId: '10000000-0000-4000-8000-000000000001', partnerId: null } as never;
const tools = new Map<string, AiTool>();
registerTopologyTools(tools);
const call = (name: string, input: Record<string, unknown>) => tools.get(name)!.handler(input, auth);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.permissions.mockResolvedValue({ permissions: [] });
  mocks.access.mockResolvedValue({ scope: { orgId: 'o', siteId: SITE } });
  mocks.history.mockResolvedValue({ interfaceId: IF, interfaceEpoch: 'gen:1', resolution: 'raw', interval: {}, coverage: 'partial', reasons: [], epochs: [],
    series: [{ name: 'in_bps', unit: 'bits_per_second', interfaceEpoch: 'gen:1', sourceKind: 'snmp', producerEpoch: 'p', coverage: 'partial', gaps: [],
      points: [{ at: 'a', value: 1, min: 1, max: 1, validDurationMs: 1, sampleCount: 1, gapDurationMs: 0, reasons: [] }] }] });
  mocks.link.mockResolvedValue({ relationshipId: REL });
});

describe('topology AI tools', () => {
  it('registers two Tier-1 network reads', () => {
    for (const name of ['get_interface_history', 'get_link_health']) expect(tools.get(name)).toMatchObject({ tier: 1, domain: 'network' });
  });

  it('authorizes the exact site before reading, and never dispatches', async () => {
    mocks.access.mockRejectedValue(new TopologyError('topology_site_not_found', 404, 'Topology site not found'));
    expect(JSON.parse(await call('get_link_health', { site_id: SITE, relationship_id: REL }))).toEqual({ error: 'Topology site not found' });
    expect(mocks.link).not.toHaveBeenCalled();
    expect(mocks.access).toHaveBeenCalledWith(auth, expect.anything(), SITE, 'read');
    mocks.permissions.mockResolvedValue(null);
    expect(JSON.parse(await call('get_interface_history', { site_id: SITE, interface_id: IF, series: ['in_bps'], from: 'a', to: 'b' }))).toEqual({ error: 'Topology permission denied' });
    expect(mocks.history).not.toHaveBeenCalled();
    expect(mocks.command).not.toHaveBeenCalled();
  });

  it('bounds history for the model and returns a compact projection', async () => {
    expect(JSON.parse(await call('get_interface_history', { site_id: SITE, interface_id: IF, series: ['in_bps', 'out_bps', 'in_utilization_pct', 'out_utilization_pct', 'in_errors_per_second'], from: 'a', to: 'b' })).error).toMatch(/series/);
    const result = JSON.parse(await call('get_interface_history', { site_id: SITE, interface_id: IF, series: ['in_bps'], from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z', max_buckets: 5000 }));
    expect(mocks.history).toHaveBeenCalledWith(expect.anything(), IF, expect.objectContaining({ maxBuckets: AI_INTERFACE_HISTORY_MAX_BUCKETS, resolution: 'auto' }));
    expect(result.series[0].points[0]).toEqual({ at: 'a', value: 1 });
  });
});
