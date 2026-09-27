import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  executeCommandMock,
  getDeviceMock,
  authState,
  siteAccessDenied,
  requireDevicesExecuteMock,
} = vi.hoisted(() => ({
  executeCommandMock: vi.fn(),
  getDeviceMock: vi.fn(),
  requireDevicesExecuteMock: vi.fn(),
  authState: {
    current: {
      user: {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'reader@example.com',
      },
      scope: 'organization',
      orgId: '22222222-2222-4222-8222-222222222222',
      partnerId: null,
      accessibleOrgIds: ['22222222-2222-4222-8222-222222222222'],
      canAccessOrg: (orgId: string) => orgId === '22222222-2222-4222-8222-222222222222',
    },
  },
  siteAccessDenied: Symbol('SITE_ACCESS_DENIED'),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('auth', authState.current);
    await next();
  },
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../../services/commandQueue', () => ({
  executeCommand: executeCommandMock,
  CommandTypes: {
    EVENT_LOGS_LIST: 'EVENT_LOGS_LIST',
    EVENT_LOGS_QUERY: 'EVENT_LOGS_QUERY',
    EVENT_LOG_GET: 'EVENT_LOG_GET',
  },
}));

vi.mock('./helpers', async () => {
  const actual = await vi.importActual<typeof import('./helpers')>('./helpers');
  return {
    ...actual,
    getDeviceWithOrgAndSiteCheck: getDeviceMock,
    requireDevicesExecute: requireDevicesExecuteMock,
    SITE_ACCESS_DENIED: siteAccessDenied,
  };
});

import { eventLogsRoutes } from './eventLogs';

const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID = '22222222-2222-4222-8222-222222222222';

function app() {
  const instance = new Hono();
  instance.route('/', eventLogsRoutes);
  return instance;
}

describe('event log channel access tier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDeviceMock.mockResolvedValue({
      id: DEVICE_ID,
      orgId: ORG_ID,
      siteId: '44444444-4444-4444-8444-444444444444',
      hostname: 'device-1',
    });
    executeCommandMock.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({
        events: [
          {
            recordId: 1,
            timeCreated: '2026-01-01T00:00:00Z',
            level: 'information',
            source: 'test',
            eventId: 1,
            message: 'hello',
          },
        ],
        total: 1,
        page: 1,
        limit: 50,
        totalPages: 1,
      }),
    });
  });

  it('refuses a devices:read-only caller querying the Security channel', async () => {
    requireDevicesExecuteMock.mockResolvedValue(false); // no devices:execute

    const res = await app().request(`/devices/${DEVICE_ID}/eventlogs/Security/events`);

    expect(res.status).toBe(403);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('refuses a devices:read-only caller querying a PowerShell operational channel', async () => {
    requireDevicesExecuteMock.mockResolvedValue(false);

    const res = await app().request(
      `/devices/${DEVICE_ID}/eventlogs/${encodeURIComponent('Microsoft-Windows-PowerShell/Operational')}/events`
    );

    expect(res.status).toBe(403);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('allows a devices:execute caller to query the Security channel', async () => {
    requireDevicesExecuteMock.mockResolvedValue(true);

    const res = await app().request(`/devices/${DEVICE_ID}/eventlogs/Security/events`);

    expect(res.status).toBe(200);
    expect(executeCommandMock).toHaveBeenCalled();
  });

  it('allows a devices:read-only caller to query an ordinary channel', async () => {
    requireDevicesExecuteMock.mockResolvedValue(false);

    const res = await app().request(`/devices/${DEVICE_ID}/eventlogs/Application/events`);

    expect(res.status).toBe(200);
    expect(executeCommandMock).toHaveBeenCalled();
  });

  it('refuses a devices:read-only caller reading a single Security-channel event', async () => {
    requireDevicesExecuteMock.mockResolvedValue(false);
    executeCommandMock.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({
        recordId: 1,
        timeCreated: '2026-01-01T00:00:00Z',
        level: 'information',
        source: 'test',
        eventId: 4625,
        message: 'failed logon',
      }),
    });

    const res = await app().request(`/devices/${DEVICE_ID}/eventlogs/Security/events/1`);

    expect(res.status).toBe(403);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });
});
