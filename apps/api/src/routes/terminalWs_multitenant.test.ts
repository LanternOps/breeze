import { beforeEach, describe, expect, it, vi } from 'vitest';

// -------------------------------------------------------------------
// Mocks — must be declared before any import that triggers the modules
// -------------------------------------------------------------------

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
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
  consumeWsTicket: vi.fn()
}));

vi.mock('./agentWs', () => ({
  sendCommandToAgent: vi.fn(() => true),
  isAgentConnected: vi.fn(() => true)
}));

// -------------------------------------------------------------------
// Imports (after mocks)
// -------------------------------------------------------------------
import { db } from '../db';
import { consumeWsTicket } from '../services/remoteSessionAuth';
import {
  createTerminalWsRoutes,
} from './terminalWs';

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

const SESSION_ID = 'session-terminal-001';
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

  createTerminalWsRoutes(upgradeWebSocket);

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

describe('terminalWs — multi-tenant isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects connection when session belongs to a different user', async () => {
    const ticketUserId = 'user-org-a';

    vi.mocked(consumeWsTicket).mockResolvedValue({
      sessionId: SESSION_ID,
      sessionType: 'terminal',
      userId: ticketUserId,
      expiresAt: Date.now() + 60_000
    });

    const user = { id: ticketUserId, status: 'active' };
    // Session lookup returns empty because the DB query filters by
    // both sessionId AND userId — mismatch means empty result
    vi.mocked(db.select)
      .mockReturnValueOnce(mockSelectChain([user]))
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]) // no match
            })
          })
        })
      } as any);

    const handlers = captureWsHandlers(SESSION_ID, 'ticket-cross-user');
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
      sessionType: 'terminal',
      userId: ticketUserId,
      expiresAt: Date.now() + 60_000
    });

    const user = { id: ticketUserId, status: 'active' };
    const session = {
      id: SESSION_ID,
      type: 'terminal',
      userId: realSessionUserId, // different from ticket user
      status: 'pending',
      deviceId: DEVICE_ID
    };
    const device = {
      id: DEVICE_ID,
      agentId: AGENT_ID,
      hostname: 'test-host',
      osType: 'linux',
      status: 'online'
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
