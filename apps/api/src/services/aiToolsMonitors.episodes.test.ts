import { describe, expect, it, vi, beforeEach } from 'vitest';

// Same rationale as aiToolsMonitors.test.ts: the module only needs to exist —
// none of these handlers should ever reach a real pooled connection, because
// every DB-touching function they call (getMonitorDefinition,
// listMonitorDeviceActivity, listMonitorEpisodes, resetMonitorEscalation) is
// mocked directly below. importOriginal keeps the DB-context helpers the
// import graph captures at load time.
vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(async () => {
      throw new Error('transaction should not be reached in these cases');
    }),
  },
}));

const { getMonitorDefinitionMock } = vi.hoisted(() => ({
  getMonitorDefinitionMock: vi.fn(),
}));
vi.mock('./monitors/monitorService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./monitors/monitorService')>()),
  getMonitorDefinition: getMonitorDefinitionMock,
}));

const { listMonitorDeviceActivityMock, listMonitorEpisodesMock } = vi.hoisted(() => ({
  listMonitorDeviceActivityMock: vi.fn(),
  listMonitorEpisodesMock: vi.fn(),
}));
vi.mock('./monitors/episodeQueries', () => ({
  listMonitorDeviceActivity: listMonitorDeviceActivityMock,
  listMonitorEpisodes: listMonitorEpisodesMock,
}));

const { resetMonitorEscalationMock } = vi.hoisted(() => ({
  resetMonitorEscalationMock: vi.fn(),
}));
vi.mock('./monitors/episodeReset', () => ({
  resetMonitorEscalation: resetMonitorEscalationMock,
}));

const { writeAuditEventMock } = vi.hoisted(() => ({
  writeAuditEventMock: vi.fn(),
}));
vi.mock('./auditEvents', () => ({
  writeAuditEvent: writeAuditEventMock,
  requestLikeFromSnapshot: vi.fn(() => ({})),
}));

import { registerMonitorTools } from './aiToolsMonitors';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

function registry(): Map<string, AiTool> {
  const reg = new Map<string, AiTool>();
  registerMonitorTools(reg);
  return reg;
}

function handlerFor(name: string): AiTool['handler'] {
  const tool = registry().get(name);
  if (!tool) throw new Error(`${name} not registered`);
  return tool.handler;
}

const ORG = '11111111-1111-4111-8111-111111111111';
const MONITOR_ID = 'm1';
const DEVICE_ID = 'd1';

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: 'user',
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: null,
    partnerId: null,
    orgId: ORG,
    scope: 'organization',
    accessibleOrgIds: [ORG],
    partnerOrgAccess: null,
    orgCondition: () => undefined,
    canAccessOrg: (orgId: string) => orgId === ORG,
    ...overrides,
  } as unknown as AuthContext;
}

async function call(name: string, input: Record<string, unknown>, as: AuthContext = auth()) {
  return JSON.parse(await handlerFor(name)(input, as));
}

function monitorRow(overrides: Record<string, unknown> = {}) {
  return { id: MONITOR_ID, orgId: ORG, partnerId: null, name: 'CPU high', ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('aiToolsMonitors episode tools registration (#5290 W03)', () => {
  it('registers get_monitor_activity and reset_monitor_escalation at tier 2', () => {
    const reg = registry();
    expect(reg.get('get_monitor_activity')?.tier).toBe(2);
    expect(reg.get('reset_monitor_escalation')?.tier).toBe(2);
  });
});

describe('get_monitor_activity', () => {
  it('returns per-device state and recent episodes', async () => {
    getMonitorDefinitionMock.mockResolvedValue(monitorRow());
    listMonitorDeviceActivityMock.mockResolvedValue([
      {
        deviceId: DEVICE_ID,
        deviceName: 'web-01',
        orgId: ORG,
        lastState: 'breach',
        lastEvaluatedAt: '2026-09-13T00:00:00.000Z',
        currentEpisodeId: 'ep1',
        openSince: '2026-09-12T23:00:00.000Z',
        episodesInWindow: 2,
        windowStartedAt: '2026-09-12T00:00:00.000Z',
        escalatedAt: '2026-09-12T23:30:00.000Z',
        escalationAlertId: 'alert1',
        responsesPaused: true,
        resetAt: null,
        resetBy: null,
      },
    ]);
    listMonitorEpisodesMock.mockResolvedValue({
      episodes: [
        {
          id: 'ep1',
          deviceId: DEVICE_ID,
          deviceName: 'web-01',
          orgId: ORG,
          startedAt: '2026-09-12T23:00:00.000Z',
          endedAt: null,
          endReason: null,
          alertId: 'alert1',
          responseRunId: null,
          responseOutcome: null,
        },
      ],
      nextCursor: null,
    });

    const result = await call('get_monitor_activity', { monitorId: MONITOR_ID });

    expect(getMonitorDefinitionMock).toHaveBeenCalledWith(MONITOR_ID, expect.anything());
    expect(listMonitorDeviceActivityMock).toHaveBeenCalledWith(MONITOR_ID, expect.anything());
    expect(listMonitorEpisodesMock).toHaveBeenCalledWith(
      MONITOR_ID,
      expect.anything(),
      expect.objectContaining({ limit: expect.any(Number) }),
    );
    expect(result.devices).toEqual([
      expect.objectContaining({ deviceId: DEVICE_ID, lastState: 'breach', responsesPaused: true }),
    ]);
    expect(result.episodes).toEqual([expect.objectContaining({ id: 'ep1', deviceId: DEVICE_ID })]);
    expect(result.nextCursor).toBeNull();
  });

  it('refuses a monitor outside the caller org', async () => {
    getMonitorDefinitionMock.mockResolvedValue(null);

    const result = await call('get_monitor_activity', { monitorId: 'ghost' });

    expect(result.error).toMatch(/not found/i);
    expect(listMonitorDeviceActivityMock).not.toHaveBeenCalled();
    expect(listMonitorEpisodesMock).not.toHaveBeenCalled();
  });

  it('requires monitorId', async () => {
    const result = await call('get_monitor_activity', {});
    expect(result.error).toMatch(/monitorId/);
    expect(getMonitorDefinitionMock).not.toHaveBeenCalled();
  });
});

describe('reset_monitor_escalation', () => {
  it('clears the latch and reports it', async () => {
    getMonitorDefinitionMock.mockResolvedValue(monitorRow());
    resetMonitorEscalationMock.mockResolvedValue({ reset: true });

    const result = await call('reset_monitor_escalation', { monitorId: MONITOR_ID, deviceId: DEVICE_ID });

    expect(resetMonitorEscalationMock).toHaveBeenCalledWith({
      monitorId: MONITOR_ID,
      deviceId: DEVICE_ID,
      auth: expect.anything(),
    });
    expect(result).toEqual({ reset: true });
  });

  it('refuses a monitor outside the caller org', async () => {
    getMonitorDefinitionMock.mockResolvedValue(null);

    const result = await call('reset_monitor_escalation', { monitorId: 'ghost', deviceId: DEVICE_ID });

    expect(result.error).toMatch(/not found/i);
    expect(resetMonitorEscalationMock).not.toHaveBeenCalled();
  });

  it('writes an audit entry', async () => {
    getMonitorDefinitionMock.mockResolvedValue(monitorRow());
    resetMonitorEscalationMock.mockResolvedValue({ reset: true });

    await call('reset_monitor_escalation', { monitorId: MONITOR_ID, deviceId: DEVICE_ID });

    expect(writeAuditEventMock).toHaveBeenCalledTimes(1);
    const [, event] = writeAuditEventMock.mock.calls[0]!;
    expect(event).toMatchObject({
      action: 'monitor.escalation.reset',
      resourceType: 'monitor_definition',
      resourceId: MONITOR_ID,
      details: expect.objectContaining({ monitorId: MONITOR_ID, deviceId: DEVICE_ID }),
    });
  });
});
