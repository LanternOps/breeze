/**
 * Topology M4-D2 (#6000): a topology "Explain this" session is pinned to the
 * ONE site its page context names — after the server authorizes that site —
 * and anchored to the SITE's org, never the caller's first accessible org. The
 * client page context is not authority afterwards (see aiToolGate).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectMock = vi.fn();
const insertMock = vi.fn();
const resolveLlmConfigForOrgMock = vi.fn();
const { authorizeSiteMock } = vi.hoisted(() => ({ authorizeSiteMock: vi.fn() }));

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    insert: (...args: unknown[]) => insertMock(...args),
    update: vi.fn(),
  },
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('./effectiveSettings', () => ({ getEffectiveAiBudget: vi.fn().mockResolvedValue({ maxTurnsPerSession: 50 }) }));
vi.mock('../db/schema', () => ({
  aiSessions: { id: 'aiSessions.id', orgId: 'aiSessions.orgId' },
  aiMessages: { sessionId: 'aiMessages.sessionId', createdAt: 'aiMessages.createdAt' },
  aiToolExecutions: { id: 'aiToolExecutions.id', sessionId: 'aiToolExecutions.sessionId', status: 'aiToolExecutions.status' },
  delegantM365Connections: { id: 'd.id', orgId: 'd.orgId', status: 'd.status' },
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
}));
vi.mock('./aiAgentSystemPrompt', () => ({ AI_SYSTEM_PROMPT_BASE: 'base', AI_SYSTEM_PROMPT_TAIL: 'tail' }));
vi.mock('./aiToolIndex', () => ({ composeStaticSystemPrompt: () => 'base\nindex\ntail' }));
vi.mock('./aiAgentSdkTools', () => ({ listChatSurfaceToolNames: () => [] }));
vi.mock('./brainDeviceContext', () => ({ getActiveDeviceContext: vi.fn().mockResolvedValue([]) }));
vi.mock('./llm/llmConfigResolver', () => ({
  LlmUnavailableError: class LlmUnavailableError extends Error {},
  resolveLlmConfigForOrg: (...args: unknown[]) => resolveLlmConfigForOrgMock(...args),
}));
vi.mock('./topology/aiToolGate', async (original) => ({ ...await original<object>(), authorizeTopologySessionSite: authorizeSiteMock }));

import { createSession } from './aiAgent';
import { TopologyAiSessionError } from './topology/aiToolGate';

const ORG_A = 'aaaaaaaa-1111-4222-8333-444455556666';
const ORG_B = 'bbbbbbbb-1111-4222-8333-444455556666';
const SITE = '20000000-0000-4000-8000-000000000001';
const NODE = '30000000-0000-4000-8000-000000000001';
const topologyContext = { type: 'topology' as const, siteId: SITE, subject: { kind: 'node' as const, id: NODE }, view: 'physical' as const, graphRevision: '7' };
const partnerAuth = (): any => ({
  scope: 'partner', user: { id: 'user-1' }, orgId: undefined, accessibleOrgIds: [ORG_A, ORG_B],
  canAccessOrg: (id: string) => id === ORG_A || id === ORG_B, orgCondition: () => undefined,
});
function expectInsert() {
  const valuesSpy = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'sess-1' }]) });
  insertMock.mockReturnValueOnce({ values: valuesSpy });
  return valuesSpy;
}

describe('createSession topology pinning (M4-D2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveLlmConfigForOrgMock.mockResolvedValue({ source: 'platform', apiKey: 'k', model: 'claude-sonnet-4-6' });
    authorizeSiteMock.mockResolvedValue({ scope: { orgId: ORG_B, siteId: SITE } });
  });

  it('pins the session to the authorized site and anchors it to the site org', async () => {
    const valuesSpy = expectInsert();
    const result = await createSession(partnerAuth(), { pageContext: topologyContext });
    expect(authorizeSiteMock).toHaveBeenCalledWith(expect.anything(), SITE);
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_B, type: 'topology', topologySiteId: SITE, deviceId: null }));
    expect(result.orgId).toBe(ORG_B);
    expect(resolveLlmConfigForOrgMock).toHaveBeenCalledWith(ORG_B);
  });

  it('refuses a site the caller cannot read, or where topology AI is unavailable, without inserting', async () => {
    authorizeSiteMock.mockRejectedValueOnce(new TopologyAiSessionError('topology_site_unavailable', 404, 'Topology site not found or access denied'));
    await expect(createSession(partnerAuth(), { pageContext: topologyContext })).rejects.toBeInstanceOf(TopologyAiSessionError);
    authorizeSiteMock.mockRejectedValueOnce(new TopologyAiSessionError('topology_ai_disabled', 403, 'Topology AI is disabled for this organization'));
    await expect(createSession(partnerAuth(), { pageContext: topologyContext })).rejects.toBeInstanceOf(TopologyAiSessionError);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('never combines a topology pin with a device, M365 binding or a different explicit org', async () => {
    for (const extra of [{ deviceId: NODE }, { delegantM365ConnectionId: NODE }, { orgId: ORG_A }]) {
      await expect(createSession(partnerAuth(), { pageContext: topologyContext, ...extra })).rejects.toThrow('Invalid topology context');
    }
    expect(insertMock).not.toHaveBeenCalled();
    // The SAME org stated explicitly is fine.
    const valuesSpy = expectInsert();
    await createSession(partnerAuth(), { pageContext: topologyContext, orgId: ORG_B });
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_B, topologySiteId: SITE }));
  });

  it('keeps an ordinary session unpinned', async () => {
    const valuesSpy = expectInsert();
    await createSession(partnerAuth(), { pageContext: { type: 'dashboard' } });
    expect(valuesSpy.mock.calls[0]![0]).not.toHaveProperty('topologySiteId');
    expect(authorizeSiteMock).not.toHaveBeenCalled();
  });
});
