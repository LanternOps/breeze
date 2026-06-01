import { beforeEach, describe, expect, it, vi } from 'vitest';

// Drive createSession through the real service logic (device binding) without a
// live DB. Mirrors aiAgent.m365.test.ts.
const selectMock = vi.fn();
const insertMock = vi.fn();

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    insert: (...args: unknown[]) => insertMock(...args),
  },
}));

vi.mock('../db/schema', () => ({
  aiSessions: { id: 'aiSessions.id', orgId: 'aiSessions.orgId' },
  aiMessages: { sessionId: 'aiMessages.sessionId', createdAt: 'aiMessages.createdAt' },
  aiToolExecutions: {},
  delegantM365Connections: { id: 'delegantM365Connections.id', orgId: 'delegantM365Connections.orgId', status: 'delegantM365Connections.status' },
  devices: { id: 'devices.id', orgId: 'devices.orgId' },
}));

vi.mock('./aiAgentSystemPrompt', () => ({ AI_SYSTEM_PROMPT_BASE: 'base' }));
vi.mock('./brainDeviceContext', () => ({ getActiveDeviceContext: vi.fn().mockResolvedValue(null) }));

import { createSession } from './aiAgent';

const DEVICE_ID = '44444444-4444-4444-4444-444444444444';

function devSelect(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
    }),
  };
}

const auth: any = {
  user: { id: 'user-1' },
  orgId: 'org-111',
  accessibleOrgIds: ['org-111'],
  canAccessOrg: (id: string) => id === 'org-111',
  orgCondition: () => undefined,
};

describe('createSession device binding', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a device belonging to a different org', async () => {
    selectMock.mockReturnValueOnce(devSelect([{ id: DEVICE_ID, orgId: 'org-OTHER' }]));
    await expect(createSession(auth, { deviceId: DEVICE_ID })).rejects.toThrow('Invalid device');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown device', async () => {
    selectMock.mockReturnValueOnce(devSelect([]));
    await expect(createSession(auth, { deviceId: DEVICE_ID })).rejects.toThrow('Invalid device');
  });

  it('rejects a same-org device in a site the caller cannot access (#1047 site-axis)', async () => {
    selectMock.mockReturnValueOnce(devSelect([{ id: DEVICE_ID, orgId: 'org-111', siteId: 'site-OTHER' }]));
    const siteRestricted: any = { ...auth, canAccessSite: (s: string | null) => s === 'site-ALLOWED' };
    await expect(createSession(siteRestricted, { deviceId: DEVICE_ID })).rejects.toThrow('Invalid device');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('allows a same-org device whose site IS accessible (site-restricted caller)', async () => {
    selectMock.mockReturnValueOnce(devSelect([{ id: DEVICE_ID, orgId: 'org-111', siteId: 'site-ALLOWED' }]));
    const siteRestricted: any = { ...auth, canAccessSite: (s: string | null) => s === 'site-ALLOWED' };
    const valuesSpy = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'sess-1' }]) });
    insertMock.mockReturnValueOnce({ values: valuesSpy });
    await createSession(siteRestricted, { deviceId: DEVICE_ID });
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ deviceId: DEVICE_ID }));
  });

  it('persists deviceId + approvalMode for a valid same-org device', async () => {
    selectMock.mockReturnValueOnce(devSelect([{ id: DEVICE_ID, orgId: 'org-111' }]));
    const valuesSpy = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'sess-1' }]) });
    insertMock.mockReturnValueOnce({ values: valuesSpy });

    await createSession(auth, { deviceId: DEVICE_ID, approvalMode: 'hybrid_plan' });

    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: DEVICE_ID, approvalMode: 'hybrid_plan' }),
    );
  });

  it('persists a null deviceId when none is supplied (no device lookup)', async () => {
    const valuesSpy = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'sess-1' }]) });
    insertMock.mockReturnValueOnce({ values: valuesSpy });

    await createSession(auth, {});

    expect(selectMock).not.toHaveBeenCalled();
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ deviceId: null }));
  });
});
