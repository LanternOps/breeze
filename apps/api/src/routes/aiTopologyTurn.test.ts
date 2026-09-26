import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), prepare: vi.fn(), preconditions: vi.fn(), createServer: vi.fn(() => ({ type: 'sdk' })) }));
vi.mock('../services/topology/aiToolGate', async (original) => ({
  ...await original<object>(), authorizeTopologySessionSite: mocks.authorize, loadTopologyAiPreconditions: mocks.preconditions,
}));
vi.mock('../services/topology/aiInvestigation', async (original) => ({ ...await original<object>(), prepareTopologyInvestigation: mocks.prepare }));
vi.mock('../services/aiAgentSdkTools', () => ({ createBreezeMcpServer: mocks.createServer }));

import { TopologyAiScopeChangedError, TopologyAiEvidenceError } from '../services/topology/aiEvidence';
import { TOPOLOGY_INVESTIGATION_TOOL_NAMES } from '../services/topology/aiInvestigation';
import { TopologyAiLimitError } from '../services/topology/aiLimits';
import { loadTopologyAiReadiness, TopologyAiSessionError } from '../services/topology/aiToolGate';
import { prepareTopologyTurn, topologyMcpServerFactory } from './aiTopologyTurn';

const ORG = '10000000-0000-4000-8000-000000000001';
const SITE = '20000000-0000-4000-8000-000000000001';
const NODE = '30000000-0000-4000-8000-000000000001';
const session = (overrides: Record<string, unknown> = {}) => ({
  id: 'sess-1', orgId: ORG, type: 'topology', topologySiteId: SITE,
  contextSnapshot: { type: 'topology', siteId: SITE, subject: { kind: 'node', id: NODE }, view: 'overview', graphRevision: '3' }, ...overrides,
});
const auth = {} as never;
/** A short caller-scoped DB context (the route's `inRequestDb`), tracked by depth. */
const dbCtx = { depth: 0, opened: 0 };
const inDb = async <T>(fn: () => Promise<T>): Promise<T> => {
  dbCtx.depth += 1;
  dbCtx.opened += 1;
  try {
    return await fn();
  } finally {
    dbCtx.depth -= 1;
  }
};
const READY = { orgId: ORG, flags: { materialization: true, ai: true }, readiness: { provider: true, orgPolicy: true } };

beforeEach(() => {
  vi.clearAllMocks();
  dbCtx.depth = 0;
  dbCtx.opened = 0;
  mocks.preconditions.mockResolvedValue(READY);
  mocks.authorize.mockResolvedValue({ scope: { orgId: ORG, siteId: SITE } });
  mocks.prepare.mockResolvedValue({ kind: 'cached', explanation: {} });
});

describe('prepareTopologyTurn (M4 Task 3)', () => {
  it('prepares from the SERVER-stored selection of the pinned site', async () => {
    expect(await prepareTopologyTurn(auth, session(), 'q', 'rev', inDb)).toMatchObject({ ok: true });
    expect(mocks.authorize).toHaveBeenCalledWith(auth, SITE, { sessionOrgId: ORG });
    expect(mocks.prepare).toHaveBeenCalledWith(expect.anything(), { siteId: SITE, subject: { kind: 'node', id: NODE }, view: 'overview', graphRevision: '3' }, 'q', 'sess-1', { providerRevision: 'rev' });
  });

  it('refuses a site that left the session org, a missing selection, and maps every typed failure to a fixed status', async () => {
    mocks.authorize.mockResolvedValueOnce({ scope: { orgId: '10000000-0000-4000-8000-0000000000ff', siteId: SITE } });
    expect(await prepareTopologyTurn(auth, session(), 'q', 'rev', inDb)).toMatchObject({ ok: false, status: 404 });
    expect(await prepareTopologyTurn(auth, session({ contextSnapshot: { type: 'dashboard' } }), 'q', 'rev', inDb)).toMatchObject({ ok: false, status: 409, body: { code: 'investigation_scope_changed' } });
    mocks.authorize.mockRejectedValueOnce(new TopologyAiSessionError('topology_ai_disabled', 403, 'Topology AI is disabled for this organization'));
    expect(await prepareTopologyTurn(auth, session(), 'q', 'rev', inDb)).toMatchObject({ ok: false, status: 403, body: { code: 'topology_ai_disabled' } });
    for (const [error, status, code] of [
      [new TopologyAiLimitError('topology_ai_concurrency'), 429, 'topology_ai_concurrency'],
      [new TopologyAiLimitError('topology_ai_limits_unavailable'), 503, 'topology_ai_limits_unavailable'],
      [new TopologyAiScopeChangedError(), 409, 'investigation_scope_changed'],
      [new TopologyAiEvidenceError('graph_revision_changed', 'x'), 409, 'graph_revision_changed'],
    ] as const) {
      mocks.prepare.mockRejectedValueOnce(error);
      expect(await prepareTopologyTurn(auth, session(), 'q', 'rev', inDb)).toMatchObject({ ok: false, status, body: { code } });
    }
  });
});

describe('prepareTopologyTurn on the self-managed message route (#3127)', () => {
  it('resolves the session org preconditions with NO context held, then prepares inside ONE short caller context carrying them', async () => {
    const seen: Record<string, unknown> = {};
    mocks.preconditions.mockImplementation(async (orgId: string) => {
      seen.preconditionsDepth = dbCtx.depth;
      seen.preconditionsOrg = orgId;
      return { ...READY, readiness: { provider: true, orgPolicy: false } };
    });
    mocks.authorize.mockImplementation(async () => {
      seen.authorizeDepth = dbCtx.depth;
      // Carried, not re-read: this marker readiness only exists in the preconditions above.
      seen.readiness = await loadTopologyAiReadiness(ORG);
      return { scope: { orgId: ORG, siteId: SITE } };
    });
    mocks.prepare.mockImplementation(async () => {
      seen.prepareDepth = dbCtx.depth;
      return { kind: 'cached', explanation: {} };
    });

    expect(await prepareTopologyTurn(auth, session(), 'q', 'rev', inDb)).toMatchObject({ ok: true });

    expect(seen).toEqual({
      preconditionsDepth: 0, preconditionsOrg: ORG, authorizeDepth: 1, prepareDepth: 1,
      readiness: { provider: true, orgPolicy: false },
    });
    expect(dbCtx.opened).toBe(1);
    expect(dbCtx.depth).toBe(0);
  });

  it('a session with no pinned site is refused before any precondition read or context', async () => {
    expect(await prepareTopologyTurn(auth, session({ topologySiteId: null }), 'q', 'rev', inDb))
      .toMatchObject({ ok: false, status: 404, body: { code: 'topology_session_required' } });
    expect(mocks.preconditions).not.toHaveBeenCalled();
    expect(dbCtx.opened).toBe(0);
  });
});

describe('topologyMcpServerFactory', () => {
  it('registers ONLY the topology tool definitions on the SDK server', () => {
    topologyMcpServerFactory(() => auth, vi.fn(), vi.fn(), () => ({}) as never);
    const onlyTools = (mocks.createServer.mock.calls[0] as unknown[])[5] as { onlyTools: Set<string> };
    expect([...onlyTools.onlyTools].sort()).toEqual([...TOPOLOGY_INVESTIGATION_TOOL_NAMES].sort());
  });
});
