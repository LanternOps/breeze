import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessionRows: [] as unknown[],
  permissions: vi.fn(),
  access: vi.fn(),
  flags: vi.fn(),
  llm: vi.fn(),
  budget: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => mocks.sessionRows }) }) }),
  },
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../permissions', () => ({ getUserPermissions: mocks.permissions }));
vi.mock('./access', async (original) => ({ ...await original<object>(), requireTopologySiteAccess: mocks.access }));
vi.mock('./flags', () => ({ loadTopologyFlags: mocks.flags }));
vi.mock('../llm/llmConfigResolver', () => ({ resolveLlmConfigForOrg: mocks.llm }));
vi.mock('../effectiveSettings', () => ({ getEffectiveAiBudget: mocks.budget }));

import { TopologyError } from './access';
import { authorizeTopologyAiToolCall, isTopologyAiToolName, TOPOLOGY_AI_TOOL_NAMES } from './aiToolGate';

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
  mocks.budget.mockResolvedValue({ enabled: true });
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
    mocks.llm.mockResolvedValueOnce({ source: 'unavailable' });
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
