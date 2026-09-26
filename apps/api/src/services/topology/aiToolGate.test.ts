import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessionRows: [] as unknown[],
  permissions: vi.fn(),
  access: vi.fn(),
  flags: vi.fn(),
  llm: vi.fn(),
  providerUsable: vi.fn(),
  budget: vi.fn(),
}));

/**
 * A connection-tracking fake of the DB context helpers (review R1): every
 * context that is not JOINED acquires a pooled connection, and an acquisition
 * made while another connection is still held on the same async chain is a
 * NESTED acquisition — the #6671 pool-exhaustion shape. `runOutsideDbContext`
 * exits the routing store but, exactly like production, does not release the
 * outer connection.
 */
vi.mock('../../db', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const ambient = new AsyncLocalStorage<string>();
  const held = new AsyncLocalStorage<number>();
  const pool = { acquisitions: [] as Array<{ scope: string; nested: boolean }> };
  const withDbAccessContext = (context: { scope: string }, fn: () => unknown) => {
    if (ambient.getStore()) return fn();
    const depth = held.getStore() ?? 0;
    pool.acquisitions.push({ scope: context.scope, nested: depth > 0 });
    return ambient.run(context.scope, () => held.run(depth + 1, fn));
  };
  return {
    __pool: pool,
    db: {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => mocks.sessionRows }) }) }),
    },
    withDbAccessContext,
    withSystemDbAccessContext: (fn: () => unknown) => withDbAccessContext({ scope: 'system' }, fn),
    runOutsideDbContext: (fn: () => unknown) => ambient.exit(fn),
    getCurrentDbAccessContext: () => (ambient.getStore() ? { scope: ambient.getStore() } : undefined),
    hasDbAccessContext: () => Boolean(ambient.getStore()),
  };
});
vi.mock('../permissions', () => ({ getUserPermissions: mocks.permissions }));
vi.mock('./access', async (original) => ({ ...await original<object>(), requireTopologySiteAccess: mocks.access }));
vi.mock('./flags', async (original) => ({ ...await original<object>(), loadTopologyFlags: mocks.flags }));
vi.mock('../llm/llmConfigResolver', () => ({ resolveLlmConfigForOrg: mocks.llm, isLlmProviderUsableForOrgInSystemContext: mocks.providerUsable }));
vi.mock('../effectiveSettings', () => ({ getEffectiveAiBudget: mocks.budget }));

import * as dbModule from '../../db';
import { TopologyError } from './access';
import {
  authorizeTopologyAiToolCall, isTopologyAiToolName, loadTopologyAiPreconditions, TOPOLOGY_AI_TOOL_NAMES, withTopologyAiPreconditions, withTopologyReleasePreconditions,
} from './aiToolGate';

const pool = (dbModule as unknown as { __pool: { acquisitions: Array<{ scope: string; nested: boolean }> } }).__pool;
const inRequestContext = <T>(scope: string, fn: () => Promise<T>): Promise<T> =>
  dbModule.withDbAccessContext({ scope } as never, fn) as Promise<T>;

const ORG = '10000000-0000-4000-8000-000000000001';
const SITE_A = '20000000-0000-4000-8000-00000000000a';
const SITE_B = '20000000-0000-4000-8000-00000000000b';
const SESSION = '30000000-0000-4000-8000-000000000001';
const auth = (overrides: Record<string, unknown> = {}) => ({
  user: { id: '50000000-0000-4000-8000-000000000001' }, scope: 'organization', orgId: ORG, partnerId: null,
  orgCondition: () => undefined, canAccessOrg: () => true, ...overrides,
}) as never;
const pinnedRow = (overrides: Record<string, unknown> = {}) => ({ orgId: ORG, siteId: SITE_A, type: 'topology', status: 'active', ...overrides });
const ALL_ON = { materialization: true, ai: true };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessionRows = [pinnedRow()];
  mocks.permissions.mockResolvedValue({ permissions: [] });
  mocks.access.mockImplementation(async (_auth, _perm, siteId: string) => ({ auth: _auth, permissions: _perm, scope: { orgId: ORG, siteId } }));
  mocks.flags.mockResolvedValue(ALL_ON);
  mocks.llm.mockResolvedValue({ source: 'platform' });
  mocks.providerUsable.mockImplementation(async () => {
    // Readiness reads only ever run on a SYSTEM connection.
    if (dbModule.getCurrentDbAccessContext()?.scope !== 'system') throw new Error('provider readiness outside a system context');
    return true;
  });
  mocks.budget.mockResolvedValue({ enabled: true });
  pool.acquisitions.length = 0;
});

describe('topology AI tool gate (M4-D1)', () => {
  it('covers every topology tool, including the five W04 reads', () => {
    for (const name of ['get_interface_history', 'get_link_health', 'get_topology_impact', 'get_recent_network_changes', 'get_topology_monitoring_status',
      'get_topology', 'get_link_evidence', 'get_diagnostic_run']) expect(isTopologyAiToolName(name)).toBe(true);
    expect(TOPOLOGY_AI_TOOL_NAMES).toHaveLength(8);
    expect(isTopologyAiToolName('get_network_changes')).toBe(false);
  });

  it('refuses an unbound call before any read', async () => {
    const result = await authorizeTopologyAiToolCall({ site_id: SITE_A }, auth(), undefined);
    expect(result).toMatchObject({ ok: false, code: 'topology_session_required' });
    expect(mocks.permissions).not.toHaveBeenCalled();
    expect(mocks.access).not.toHaveBeenCalled();
  });

  it('refuses a session that is not an active pinned topology session', async () => {
    for (const row of [pinnedRow({ type: 'general', siteId: null }), pinnedRow({ status: 'closed' }), pinnedRow({ siteId: null })]) {
      mocks.sessionRows = [row];
      expect(await authorizeTopologyAiToolCall({ site_id: SITE_A }, auth(), { kind: 'ai_session', sessionId: SESSION }))
        .toMatchObject({ ok: false, code: 'topology_session_required' });
    }
    mocks.sessionRows = []; // not the caller's session (owner-bound query) or RLS-hidden
    expect(await authorizeTopologyAiToolCall({ site_id: SITE_A }, auth(), { kind: 'ai_session', sessionId: SESSION }))
      .toMatchObject({ ok: false, code: 'topology_session_required' });
    expect(mocks.access).not.toHaveBeenCalled();
  });

  it('a session pinned to site A can never name site B — refused before site B is looked up', async () => {
    const result = await authorizeTopologyAiToolCall({ site_id: SITE_B }, auth(), { kind: 'ai_session', sessionId: SESSION });
    expect(result).toMatchObject({ ok: false, code: 'topology_site_mismatch' });
    expect(mocks.access).not.toHaveBeenCalled();
    expect(await authorizeTopologyAiToolCall({}, auth(), { kind: 'ai_session', sessionId: SESSION })).toMatchObject({ ok: false, code: 'topology_site_mismatch' });
  });

  it('authorizes the pinned site with live read permissions and returns its context', async () => {
    const result = await authorizeTopologyAiToolCall({ site_id: SITE_A }, auth(), { kind: 'ai_session', sessionId: SESSION });
    expect(result).toMatchObject({ ok: true, pinnedSiteId: SITE_A, sessionId: SESSION, ctx: { scope: { orgId: ORG, siteId: SITE_A } } });
    expect(mocks.access).toHaveBeenCalledWith(expect.anything(), expect.anything(), SITE_A, 'read');
  });

  it('hides a site the caller can no longer read, and a site that left the session org', async () => {
    mocks.access.mockRejectedValueOnce(new TopologyError('topology_permission_denied', 403, 'Topology permission denied'));
    expect(await authorizeTopologyAiToolCall({ site_id: SITE_A }, auth(), { kind: 'ai_session', sessionId: SESSION }))
      .toMatchObject({ ok: false, code: 'topology_site_unavailable' });
    mocks.permissions.mockResolvedValueOnce(null);
    expect(await authorizeTopologyAiToolCall({ site_id: SITE_A }, auth(), { kind: 'ai_session', sessionId: SESSION }))
      .toMatchObject({ ok: false, code: 'topology_site_unavailable' });
    mocks.access.mockResolvedValueOnce({ scope: { orgId: '10000000-0000-4000-8000-0000000000ff', siteId: SITE_A } });
    expect(await authorizeTopologyAiToolCall({ site_id: SITE_A }, auth(), { kind: 'ai_session', sessionId: SESSION }))
      .toMatchObject({ ok: false, code: 'topology_site_unavailable' });
  });

  it('refuses when flags.ai, materialization, the provider or the org AI policy is off', async () => {
    const bound = { kind: 'ai_session', sessionId: SESSION } as const;
    mocks.flags.mockResolvedValueOnce({ materialization: true, ai: false });
    expect(await authorizeTopologyAiToolCall({ site_id: SITE_A }, auth(), bound)).toMatchObject({ ok: false, code: 'topology_ai_disabled' });
    mocks.flags.mockResolvedValueOnce({ materialization: false, ai: true });
    expect(await authorizeTopologyAiToolCall({ site_id: SITE_A }, auth(), bound)).toMatchObject({ ok: false, code: 'topology_ai_disabled' });
    mocks.providerUsable.mockResolvedValueOnce(false);
    expect(await authorizeTopologyAiToolCall({ site_id: SITE_A }, auth(), bound)).toMatchObject({ ok: false, code: 'topology_ai_disabled' });
    mocks.budget.mockResolvedValueOnce({ enabled: false });
    expect(await authorizeTopologyAiToolCall({ site_id: SITE_A }, auth(), bound)).toMatchObject({ ok: false, code: 'topology_ai_disabled' });
    mocks.budget.mockRejectedValueOnce(new Error('db down'));
    expect(await authorizeTopologyAiToolCall({ site_id: SITE_A }, auth(), bound)).toMatchObject({ ok: false, code: 'topology_ai_disabled' });
  });

  it('confines MCP to a key restricted to exactly one site', async () => {
    const mcp = { kind: 'mcp_site_key' } as const;
    expect(await authorizeTopologyAiToolCall({ site_id: SITE_A }, auth({ allowedSiteIds: undefined }), mcp))
      .toMatchObject({ ok: false, code: 'topology_session_required' });
    expect(await authorizeTopologyAiToolCall({ site_id: SITE_A }, auth({ allowedSiteIds: [SITE_A, SITE_B] }), mcp))
      .toMatchObject({ ok: false, code: 'topology_session_required' });
    expect(await authorizeTopologyAiToolCall({ site_id: SITE_A }, auth({ allowedSiteIds: [] }), mcp))
      .toMatchObject({ ok: false, code: 'topology_session_required' });
    expect(await authorizeTopologyAiToolCall({ site_id: SITE_B }, auth({ allowedSiteIds: [SITE_A] }), mcp))
      .toMatchObject({ ok: false, code: 'topology_site_mismatch' });
    expect(await authorizeTopologyAiToolCall({ site_id: SITE_A }, auth({ allowedSiteIds: [SITE_A] }), mcp))
      .toMatchObject({ ok: true, pinnedSiteId: SITE_A, sessionId: null });
  });
});

describe('topology AI readiness never double-holds the pool (review R1)', () => {
  const bound = { kind: 'ai_session', sessionId: SESSION } as const;

  it('a gate check inside a held context acquires NO second connection when its preconditions were resolved first', async () => {
    const pre = await loadTopologyAiPreconditions(ORG);
    expect(pool.acquisitions).toEqual([{ scope: 'system', nested: false }]);
    pool.acquisitions.length = 0;
    const result = await inRequestContext('organization', () => withTopologyAiPreconditions(pre, () => authorizeTopologyAiToolCall({ site_id: SITE_A }, auth(), bound)));
    expect(result).toMatchObject({ ok: true, pinnedSiteId: SITE_A });
    expect(pool.acquisitions).toEqual([{ scope: 'organization', nested: false }]);
    expect(mocks.providerUsable).toHaveBeenCalledTimes(1);
    expect(mocks.llm).not.toHaveBeenCalled();
  });

  it('never runs the full LLM resolver (its unconditional escapes) for readiness; an uncarried held check takes at most ONE escape, none when system-scoped', async () => {
    expect(await inRequestContext('organization', () => authorizeTopologyAiToolCall({ site_id: SITE_A }, auth(), bound))).toMatchObject({ ok: true });
    expect(mocks.llm).not.toHaveBeenCalled();
    expect(pool.acquisitions.filter((a) => a.nested)).toHaveLength(1);
    pool.acquisitions.length = 0;
    expect(await inRequestContext('system', () => authorizeTopologyAiToolCall({ site_id: SITE_A }, auth(), bound))).toMatchObject({ ok: true });
    expect(pool.acquisitions.filter((a) => a.nested)).toHaveLength(0);
  });

  it('carried preconditions for another org fail closed without any read', async () => {
    const pre = await loadTopologyAiPreconditions('10000000-0000-4000-8000-0000000000ff');
    pool.acquisitions.length = 0;
    mocks.providerUsable.mockClear();
    const result = await inRequestContext('organization', () => withTopologyAiPreconditions(pre, () => authorizeTopologyAiToolCall({ site_id: SITE_A }, auth(), bound)));
    expect(result).toMatchObject({ ok: false, code: 'topology_ai_disabled' });
    expect(pool.acquisitions.filter((a) => a.nested)).toHaveLength(0);
    expect(mocks.providerUsable).not.toHaveBeenCalled();
  });

  it('resolves preconditions fail-closed', async () => {
    mocks.providerUsable.mockRejectedValueOnce(new Error('db down'));
    expect((await loadTopologyAiPreconditions(ORG)).readiness).toEqual({ provider: false, orgPolicy: true });
    mocks.budget.mockRejectedValueOnce(new Error('db down'));
    expect((await loadTopologyAiPreconditions(ORG)).readiness).toEqual({ provider: true, orgPolicy: false });
  });

  it('the release hook resolves diagnose_connectivity preconditions before its context opens; any other action is untouched', async () => {
    const result = await withTopologyReleasePreconditions('diagnose_connectivity', ORG, () =>
      inRequestContext('organization', () => authorizeTopologyAiToolCall({ site_id: SITE_A }, auth(), bound)));
    expect(result).toMatchObject({ ok: true });
    expect(pool.acquisitions.filter((a) => a.nested)).toHaveLength(0);
    mocks.providerUsable.mockClear();
    expect(await withTopologyReleasePreconditions('run_script', ORG, async () => 'ran')).toBe('ran');
    expect(mocks.providerUsable).not.toHaveBeenCalled();
  });
});
