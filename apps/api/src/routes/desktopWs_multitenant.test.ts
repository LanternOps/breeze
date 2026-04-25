import { beforeEach, describe, expect, it, vi } from 'vitest';

// -------------------------------------------------------------------
// Mocks — must be declared before any import that triggers the modules
// -------------------------------------------------------------------

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({
  remoteSessions: { id: 'remoteSessions.id', deviceId: 'remoteSessions.deviceId', status: 'remoteSessions.status' },
  devices: { id: 'devices.id' },
  users: { id: 'users.id', status: 'users.status' },
  patchPolicies: {},
  alertRules: {},
  backupConfigs: {},
  securityPolicies: {},
  automationPolicies: {},
  maintenanceWindows: {},
  softwarePolicies: {},
  sensitiveDataPolicies: {},
  peripheralPolicies: {}
}));

vi.mock('../services/remoteSessionAuth', () => ({
  consumeWsTicket: vi.fn(),
  consumeDesktopConnectCode: vi.fn(),
  getViewerAccessTokenExpirySeconds: vi.fn(() => 900)
}));

vi.mock('../services/jwt', () => ({
  createAccessToken: vi.fn(async () => 'mock-access-token-xyz')
}));

vi.mock('./agentWs', () => ({
  sendCommandToAgent: vi.fn(() => true),
  isAgentConnected: vi.fn(() => true)
}));

vi.mock('../services/remoteAccessPolicy', () => ({
  checkRemoteAccess: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('../services/redis', () => ({
  getRedis: vi.fn(() => ({})),
}));

vi.mock('../services/rate-limit', () => ({
  rateLimiter: vi.fn(async () => ({
    allowed: true,
    remaining: 9,
    resetAt: new Date(Date.now() + 60_000),
  })),
}));

vi.mock('./remote/helpers', () => ({
  logSessionAudit: vi.fn(async () => undefined),
  getIceServers: vi.fn(() => []),
}));

vi.mock('../services/clientIp', () => ({
  getTrustedClientIp: vi.fn(() => '127.0.0.1'),
}));

// -------------------------------------------------------------------
// Imports (after mocks)
// -------------------------------------------------------------------
import { db } from '../db';
import { consumeWsTicket } from '../services/remoteSessionAuth';
import {
  createDesktopWsRoutes,
} from './desktopWs';

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

const SESSION_ID = 'session-desktop-001';
const DEVICE_ID = 'device-xyz';
const AGENT_ID = 'agent-xyz';

function wsMock() {
  return {
    send: vi.fn(),
    close: vi.fn()
  };
}

function mockSelectChain(result: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(result)
      }),
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(result)
        })
      })
    })
  } as any;
}

function captureWsHandlers(sessionId: string, ticket?: string) {
  let capturedFactory: any;

  const upgradeWebSocket = vi.fn((factory: any) => {
    capturedFactory = factory;
    return (_c: any, _next: any) => {};
  });

  createDesktopWsRoutes(upgradeWebSocket);

  const fakeContext = {
    req: {
      param: vi.fn((key: string) => (key === 'id' ? sessionId : undefined)),
      query: vi.fn((key: string) => (key === 'ticket' ? ticket : undefined))
    }
  };

  return capturedFactory(fakeContext);
}

// -------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------

describe('desktopWs — multi-tenant isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects connection when session belongs to a different user', async () => {
    const ticketUserId = 'user-org-a';

    vi.mocked(consumeWsTicket).mockResolvedValue({
      sessionId: SESSION_ID,
      sessionType: 'desktop',
      userId: ticketUserId,
      expiresAt: Date.now() + 60_000
    });

    const user = { id: ticketUserId, status: 'active' };
    // Session belongs to a different user — the DB query filters by
    // both sessionId AND userId, so it returns empty when they don't match
    vi.mocked(db.select)
      .mockReturnValueOnce(mockSelectChain([user]))
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]) // no match — session belongs to different user
            })
          })
        })
      } as any);

    const handlers = captureWsHandlers(SESSION_ID, 'ticket-cross-org');
    const ws = wsMock();

    await handlers.onOpen({}, ws);

    expect(ws.send).toHaveBeenCalledWith(
      expect.stringContaining('"AUTH_FAILED"')
    );
    expect(ws.close).toHaveBeenCalledWith(4001, 'Authentication failed');
  });

  it('rejects connection when ticket userId does not match session userId', async () => {
    const ticketUserId = 'user-attacker';
    const realSessionUserId = 'user-victim';

    vi.mocked(consumeWsTicket).mockResolvedValue({
      sessionId: SESSION_ID,
      sessionType: 'desktop',
      userId: ticketUserId,
      expiresAt: Date.now() + 60_000
    });

    const user = { id: ticketUserId, status: 'active' };
    const session = {
      id: SESSION_ID,
      type: 'desktop',
      userId: realSessionUserId, // different from ticket user
      status: 'pending',
      deviceId: DEVICE_ID
    };
    const device = {
      id: DEVICE_ID,
      agentId: AGENT_ID,
      hostname: 'test-host',
      osType: 'windows',
      status: 'online',
      orgId: 'org-test-1'
    };

    vi.mocked(db.select)
      .mockReturnValueOnce(mockSelectChain([user]))
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ session, device }])
            })
          })
        })
      } as any);

    const handlers = captureWsHandlers(SESSION_ID, 'ticket-wrong-user');
    const ws = wsMock();

    await handlers.onOpen({}, ws);

    // Should reject because the session's userId does not match the ticket's userId
    expect(ws.send).toHaveBeenCalledWith(
      expect.stringContaining('"AUTH_FAILED"')
    );
    expect(ws.close).toHaveBeenCalledWith(4001, 'Authentication failed');
  });
});
