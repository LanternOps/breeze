import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ permissions: vi.fn(), access: vi.fn(), history: vi.fn(), link: vi.fn(), command: vi.fn(), impact: vi.fn(), changes: vi.fn(), status: vi.fn() }));
vi.mock('./permissions', async (original) => ({ ...await original<object>(), getUserPermissions: mocks.permissions }));
vi.mock('./topology/access', async (original) => ({ ...await original<object>(), requireTopologySiteAccess: mocks.access }));
vi.mock('./topology/interfaceHistory', () => ({ getTopologyInterfaceHistory: mocks.history }));
vi.mock('./topology/graph', () => ({ getTopologyLinkHealth: mocks.link }));
vi.mock('./topology/impact', () => ({ getTopologyImpact: mocks.impact }));
vi.mock('./topology/changes', () => ({ getRecentTopologyChanges: mocks.changes }));
vi.mock('./topology/monitoringStatus', () => ({ getTopologyMonitoringStatus: mocks.status }));
vi.mock('./commandQueue', () => ({ executeCommand: mocks.command, queueCommand: mocks.command, queueCommandForExecution: mocks.command }));
import type { AiTool } from './aiTools';
import { AI_INTERFACE_HISTORY_MAX_BUCKETS, AI_TOPOLOGY_CHANGES_MAX_LIMIT, registerTopologyTools, topologyMonitoringStatusTool } from './aiToolsTopology';
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
  it('registers five Tier-1 network reads', () => {
    for (const name of ['get_interface_history', 'get_link_health', 'get_topology_impact', 'get_recent_network_changes', 'get_topology_monitoring_status']) expect(tools.get(name)).toMatchObject({ tier: 1, domain: 'network' });
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

  it('reads impact for one authorized subject without dispatching, and bounds the projection', async () => {
    const NODE = '30000000-0000-4000-8000-0000000000aa';
    mocks.impact.mockResolvedValue({ siteId: SITE, graphRevision: '7', subject: { kind: 'node', id: NODE, measured: false }, window: {}, coverage: 'partial', reasons: ['result_limit'],
      assumptions: ['subject_failure_hypothetical'], measuredFailures: [], alternatives: Array(60).fill({ nodeId: NODE, relationshipIds: [], state: 'unverified', reasons: [] }),
      potentiallyAffected: Array(150).fill({ kind: 'node', id: NODE, label: 'n', basis: 'dependency_path', hops: 1, reasons: ['no_known_alternative_path'], evidenceIds: [REL] }),
      routedPaths: [], causeSuggestion: { state: 'not_suggested', corroboratingIds: [], reasons: [] }, counts: { potentiallyAffected: 150 }, evidence: Array(900).fill({ id: REL, kind: 'relationship' }) });
    const result = JSON.parse(await call('get_topology_impact', { site_id: SITE, subject_kind: 'node', subject_id: NODE, window_minutes: 99 }));
    expect(mocks.impact).toHaveBeenCalledWith(expect.anything(), { kind: 'node', id: NODE }, { windowMinutes: 30 });
    expect(result.potentiallyAffected).toHaveLength(100);
    expect(result.alternatives).toHaveLength(50);
    expect(result).not.toHaveProperty('evidence');
    expect(result.truncatedForModel).toBe(true);
    expect(JSON.parse(await call('get_topology_impact', { site_id: SITE, subject_kind: 'site', subject_id: NODE })).error).toMatch(/subject_kind/);
    mocks.access.mockRejectedValue(new TopologyError('topology_permission_denied', 403, 'Topology permission denied'));
    expect(JSON.parse(await call('get_topology_impact', { site_id: SITE, subject_kind: 'node', subject_id: NODE })).error).toBe('Topology permission denied');
    expect(mocks.command).not.toHaveBeenCalled();
  });

  it('reads recent topology changes with a model-sized page', async () => {
    mocks.changes.mockResolvedValue({ siteId: SITE, changes: [], cursor: null });
    await call('get_recent_network_changes', { site_id: SITE, since: '2026-09-26T00:00:00Z', until: '2026-09-26T01:00:00Z', limit: 500, cursor: 'a.b' });
    expect(mocks.changes).toHaveBeenCalledWith(expect.anything(), { since: '2026-09-26T00:00:00Z', until: '2026-09-26T01:00:00Z', limit: AI_TOPOLOGY_CHANGES_MAX_LIMIT, cursor: 'a.b' });
    expect(mocks.command).not.toHaveBeenCalled();
  });
});

describe('get_topology_monitoring_status', () => {
  const siteId = '22222222-2222-4222-8222-222222222222';
  beforeEach(() => { mocks.permissions.mockReset(); mocks.access.mockReset(); mocks.status.mockReset(); });

  it('rejects a malformed site id before any read', async () => {
    expect(JSON.parse(await topologyMonitoringStatusTool({ site_id: 'nope' }, auth))).toEqual({ error: 'site_id must be a site UUID' });
    expect(mocks.permissions).not.toHaveBeenCalled();
  });

  it('hides a site the caller cannot read, with one indistinguishable answer', async () => {
    mocks.permissions.mockResolvedValueOnce(null);
    const noPermissions = await topologyMonitoringStatusTool({ site_id: siteId }, auth);
    mocks.permissions.mockResolvedValueOnce({});
    mocks.access.mockRejectedValueOnce(new TopologyError('topology_site_not_found', 404, 'x'));
    const hidden = await topologyMonitoringStatusTool({ site_id: siteId }, auth);
    expect(hidden).toBe(noPermissions);
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it('returns the same status the read route serves, under the read capability', async () => {
    mocks.permissions.mockResolvedValueOnce({});
    mocks.access.mockResolvedValueOnce({ scope: { orgId: 'o', siteId } });
    mocks.status.mockResolvedValueOnce({ siteId, policies: [], telemetryArms: [] });
    expect(JSON.parse(await call('get_topology_monitoring_status', { site_id: siteId }))).toEqual({ siteId, policies: [], telemetryArms: [] });
    expect(mocks.access).toHaveBeenCalledWith(auth, {}, siteId, 'read');
    expect(mocks.command).not.toHaveBeenCalled();
  });
});
