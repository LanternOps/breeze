import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), prepare: vi.fn(), createServer: vi.fn(() => ({ type: 'sdk' })) }));
vi.mock('../services/topology/aiToolGate', async (original) => ({ ...await original<object>(), authorizeTopologySessionSite: mocks.authorize }));
vi.mock('../services/topology/aiInvestigation', async (original) => ({ ...await original<object>(), prepareTopologyInvestigation: mocks.prepare }));
vi.mock('../services/aiAgentSdkTools', () => ({ createBreezeMcpServer: mocks.createServer }));

import { TopologyAiScopeChangedError, TopologyAiEvidenceError } from '../services/topology/aiEvidence';
import { TOPOLOGY_INVESTIGATION_TOOL_NAMES } from '../services/topology/aiInvestigation';
import { TopologyAiLimitError } from '../services/topology/aiLimits';
import { TopologyAiSessionError } from '../services/topology/aiToolGate';
import { prepareTopologyTurn, topologyMcpServerFactory } from './aiTopologyTurn';

const ORG = '10000000-0000-4000-8000-000000000001';
const SITE = '20000000-0000-4000-8000-000000000001';
const NODE = '30000000-0000-4000-8000-000000000001';
const session = (overrides: Record<string, unknown> = {}) => ({
  id: 'sess-1', orgId: ORG, type: 'topology', topologySiteId: SITE,
  contextSnapshot: { type: 'topology', siteId: SITE, subject: { kind: 'node', id: NODE }, view: 'overview', graphRevision: '3' }, ...overrides,
});
const auth = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue({ scope: { orgId: ORG, siteId: SITE } });
  mocks.prepare.mockResolvedValue({ kind: 'cached', explanation: {} });
});

describe('prepareTopologyTurn (M4 Task 3)', () => {
  it('prepares from the SERVER-stored selection of the pinned site', async () => {
    expect(await prepareTopologyTurn(auth, session(), 'q', 'rev')).toMatchObject({ ok: true });
    expect(mocks.authorize).toHaveBeenCalledWith(auth, SITE);
    expect(mocks.prepare).toHaveBeenCalledWith(expect.anything(), { siteId: SITE, subject: { kind: 'node', id: NODE }, view: 'overview', graphRevision: '3' }, 'q', 'sess-1', { providerRevision: 'rev' });
  });

  it('refuses a site that left the session org, a missing selection, and maps every typed failure to a fixed status', async () => {
    mocks.authorize.mockResolvedValueOnce({ scope: { orgId: '10000000-0000-4000-8000-0000000000ff', siteId: SITE } });
    expect(await prepareTopologyTurn(auth, session(), 'q', 'rev')).toMatchObject({ ok: false, status: 404 });
    expect(await prepareTopologyTurn(auth, session({ contextSnapshot: { type: 'dashboard' } }), 'q', 'rev')).toMatchObject({ ok: false, status: 409, body: { code: 'investigation_scope_changed' } });
    mocks.authorize.mockRejectedValueOnce(new TopologyAiSessionError('topology_ai_disabled', 403, 'Topology AI is disabled for this organization'));
    expect(await prepareTopologyTurn(auth, session(), 'q', 'rev')).toMatchObject({ ok: false, status: 403, body: { code: 'topology_ai_disabled' } });
    for (const [error, status, code] of [
      [new TopologyAiLimitError('topology_ai_concurrency'), 429, 'topology_ai_concurrency'],
      [new TopologyAiLimitError('topology_ai_limits_unavailable'), 503, 'topology_ai_limits_unavailable'],
      [new TopologyAiScopeChangedError(), 409, 'investigation_scope_changed'],
      [new TopologyAiEvidenceError('graph_revision_changed', 'x'), 409, 'graph_revision_changed'],
    ] as const) {
      mocks.prepare.mockRejectedValueOnce(error);
      expect(await prepareTopologyTurn(auth, session(), 'q', 'rev')).toMatchObject({ ok: false, status, body: { code } });
    }
  });
});

describe('topologyMcpServerFactory', () => {
  it('registers ONLY the topology tool definitions on the SDK server', () => {
    topologyMcpServerFactory(() => auth, vi.fn(), vi.fn(), () => ({}) as never);
    const onlyTools = (mocks.createServer.mock.calls[0] as unknown[])[5] as { onlyTools: Set<string> };
    expect([...onlyTools.onlyTools].sort()).toEqual([...TOPOLOGY_INVESTIGATION_TOOL_NAMES].sort());
  });
});
