/**
 * #5593 — the AI sidebar opened from a device page sends `pageContext` but no
 * `deviceId`/`orgId`. A partner-scoped caller (`auth.orgId` null) used to fall
 * through to `accessibleOrgIds[0]`, so the session bound to an unrelated org
 * and the device's org-level settings (approval mode, M365 connection) and
 * tool-audit rows all resolved against the wrong tenant.
 *
 * Mirrors the mock harness of aiAgent.deviceTask.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const resolveLlmConfigForOrgMock = vi.fn();

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    insert: (...args: unknown[]) => insertMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
  },
}));

vi.mock('../db/schema', () => ({
  aiSessions: { id: 'aiSessions.id', orgId: 'aiSessions.orgId' },
  aiMessages: { sessionId: 'aiMessages.sessionId', createdAt: 'aiMessages.createdAt' },
  aiToolExecutions: {
    id: 'aiToolExecutions.id',
    sessionId: 'aiToolExecutions.sessionId',
    status: 'aiToolExecutions.status',
  },
  delegantM365Connections: {
    id: 'delegantM365Connections.id',
    orgId: 'delegantM365Connections.orgId',
    status: 'delegantM365Connections.status',
  },
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
}));

vi.mock('./aiAgentSystemPrompt', () => ({ AI_SYSTEM_PROMPT_BASE: 'base' }));
vi.mock('./brainDeviceContext', () => ({ getActiveDeviceContext: vi.fn().mockResolvedValue([]) }));
vi.mock('./llm/llmConfigResolver', () => ({
  LlmUnavailableError: class LlmUnavailableError extends Error {},
  resolveLlmConfigForOrg: (...args: unknown[]) => resolveLlmConfigForOrgMock(...args),
}));

import { createSession } from './aiAgent';

const ORG_A = 'aaaaaaaa-1111-4222-8333-444455556666';
const ORG_B = 'bbbbbbbb-1111-4222-8333-444455556666';
const DEVICE_ID = 'dddddddd-1111-4222-8333-444455556666';

function devSelect(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
    }),
  };
}

/** Partner-scope login: no home org, accessibleOrgIds[0] is NOT the device org. */
function partnerAuth(overrides: Record<string, unknown> = {}): any {
  return {
    scope: 'partner',
    user: { id: 'user-1' },
    orgId: undefined,
    accessibleOrgIds: [ORG_A, ORG_B],
    canAccessOrg: (id: string) => id === ORG_A || id === ORG_B,
    orgCondition: () => undefined,
    ...overrides,
  };
}

/** Org-scope login: one org, the classic single-tenant technician. */
function orgAuth(overrides: Record<string, unknown> = {}): any {
  return {
    scope: 'organization',
    user: { id: 'user-2' },
    orgId: ORG_A,
    accessibleOrgIds: [ORG_A],
    canAccessOrg: (id: string) => id === ORG_A,
    orgCondition: () => undefined,
    ...overrides,
  };
}

const devicePageContext = { type: 'device' as const, id: DEVICE_ID, hostname: 'WS-01' };

function expectInsert() {
  const valuesSpy = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'sess-1' }]) });
  insertMock.mockReturnValueOnce({ values: valuesSpy });
  return valuesSpy;
}

describe('createSession page-context org anchoring (#5593)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveLlmConfigForOrgMock.mockResolvedValue({
      source: 'platform',
      apiKey: 'platform-key',
      model: 'claude-sonnet-4-6',
    });
  });

  it('anchors a partner-scoped session to the page-context device org, not accessibleOrgIds[0]', async () => {
    // 1st select = org anchor, 2nd = device-memory authorization in the prompt.
    selectMock
      .mockReturnValueOnce(devSelect([{ orgId: ORG_B, siteId: null }]))
      .mockReturnValueOnce(devSelect([{ orgId: ORG_B, siteId: null }]));
    const valuesSpy = expectInsert();

    const result = await createSession(partnerAuth(), { pageContext: devicePageContext });

    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_B }));
    expect(result.orgId).toBe(ORG_B);
    expect(resolveLlmConfigForOrgMock).toHaveBeenCalledWith(ORG_B);
  });

  it('falls back to accessibleOrgIds[0] when the page-context device is outside the caller org axis', async () => {
    selectMock.mockReturnValue(devSelect([{ orgId: 'cccccccc-1111-4222-8333-444455556666', siteId: null }]));
    const valuesSpy = expectInsert();

    await createSession(partnerAuth(), { pageContext: devicePageContext });

    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_A }));
  });

  it('does not anchor to a device whose site the caller cannot reach (#1047 site axis)', async () => {
    selectMock.mockReturnValue(devSelect([{ orgId: ORG_B, siteId: 'site-OTHER' }]));
    const valuesSpy = expectInsert();

    await createSession(
      partnerAuth({ canAccessSite: (s: string | null) => s === 'site-ALLOWED' }),
      { pageContext: devicePageContext },
    );

    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_A }));
  });

  it('never queries devices for a malformed page-context device id', async () => {
    const valuesSpy = expectInsert();

    await createSession(partnerAuth(), {
      pageContext: { type: 'device', id: 'not-a-uuid', hostname: 'WS-01' },
    });

    expect(selectMock).not.toHaveBeenCalled();
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_A }));
  });

  it('leaves the org-scoped path unchanged (session stays on the login org)', async () => {
    selectMock.mockReturnValue(devSelect([{ orgId: ORG_A, siteId: null }]));
    const valuesSpy = expectInsert();

    await createSession(orgAuth(), { pageContext: devicePageContext });

    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_A }));
  });

  it('leaves the device-bound path unchanged: options.deviceId still drives the org', async () => {
    // Single device lookup (the deviceId branch); the anchor branch is skipped.
    selectMock.mockReturnValue(devSelect([{ id: DEVICE_ID, orgId: ORG_B, siteId: null }]));
    const valuesSpy = expectInsert();

    await createSession(partnerAuth(), { deviceId: DEVICE_ID });

    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_B, deviceId: DEVICE_ID }));
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('leaves an explicit options.orgId authoritative over the page context', async () => {
    selectMock.mockReturnValue(devSelect([{ orgId: ORG_B, siteId: null }]));
    const valuesSpy = expectInsert();

    await createSession(partnerAuth(), { orgId: ORG_A, pageContext: devicePageContext });

    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_A }));
  });

  it('ignores a non-device page context (no device lookup, previous fallback stands)', async () => {
    const valuesSpy = expectInsert();

    await createSession(partnerAuth(), {
      pageContext: { type: 'dashboard', orgName: 'Mountain Capital' },
    });

    expect(selectMock).not.toHaveBeenCalled();
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_A }));
  });
});
