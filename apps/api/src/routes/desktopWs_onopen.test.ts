import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  persistDesktopFinalizationIntentMock,
  finalizeDesktopSessionOnceMock,
} = vi.hoisted(() => ({
  persistDesktopFinalizationIntentMock: vi.fn(async ({ finalization }: any) => ({
    input: finalization,
    canonicalPayload: JSON.stringify(finalization),
    payloadSha256: 'b'.repeat(64),
  })),
  finalizeDesktopSessionOnceMock: vi.fn(async () => 'finalized' as const),
}));

vi.mock('../services/desktopSessionFinalization', () => ({
  persistDesktopFinalizationIntent: persistDesktopFinalizationIntentMock,
  finalizeDesktopSessionOnce: finalizeDesktopSessionOnceMock,
}));

vi.mock('../jobs/desktopSessionFinalizationWorker', () => ({
  enqueueDesktopSessionFinalization: vi.fn(async ({ sessionId, finalizationId }: any) => ({
    acknowledged: true as const,
    jobId: `desktop-finalize-${sessionId}-${finalizationId}`,
  })),
}));

vi.mock('../services/desktopSessionStop', () => ({
  ensureDesktopStreamStopped: vi.fn(async ({ finalizationId }: any) => ({
    state: 'pending',
    commandId: finalizationId,
    reason: 'delivery_unacknowledged',
  })),
}));

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

vi.mock('../services/viewerTokenRevocation', () => ({
  isViewerJtiRevoked: vi.fn(async () => false),
  isViewerSessionRevoked: vi.fn(async () => false),
  revokeViewerSession: vi.fn(async () => undefined),
}));

vi.mock('./agentWs', () => ({
  sendCommandToAgent: vi.fn(() => true),
  isAgentConnected: vi.fn(() => true)
}));

vi.mock('../services/remoteAccessPolicy', () => ({
  checkRemoteAccess: vi.fn().mockResolvedValue({ allowed: true }),
  resolveRemoteAccessForDevice: vi.fn().mockResolvedValue({
    settings: { webrtcDesktop: true, vncRelay: true, remoteTools: true, enableProxy: true, defaultAllowedPorts: [], autoEnableProxy: false, maxConcurrentTunnels: 5, idleTimeoutMinutes: 5, maxSessionDurationHours: 8 },
    policyName: null,
    policyId: null,
  }),
}));

// E1: WS connection rate limiter now goes through Redis/rate-limit.
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
import { consumeWsTicket, consumeDesktopConnectCode, getViewerAccessTokenExpirySeconds } from '../services/remoteSessionAuth';
import { createAccessToken } from '../services/jwt';
import { revokeViewerSession } from '../services/viewerTokenRevocation';
import { sendCommandToAgent, isAgentConnected } from './agentWs';
import {
  handleDesktopFrame,
  registerDesktopFrameCallback,
  unregisterDesktopFrameCallback,
  createDesktopWsRoutes,
  isDesktopSessionOwnedByAgent,
  getActiveDesktopSessionCount,
  __createDesktopSharedLeasesForTest,
  __resetDesktopWsForTest,
} from './desktopWs';

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

const SESSION_ID = 'session-desktop-001';
const DEVICE_ID = 'device-xyz';
const AGENT_ID = 'agent-xyz';

// Use a unique user ID per successful onOpen to avoid the in-memory
// rate limiter (10 connections per user per 60s) blocking later tests.
let userIdCounter = 0;
function nextUserId(): string {
  return `user-desk-${++userIdCounter}`;
}

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

function mockUpdateNoReturn() {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: SESSION_ID }]),
      }),
    })
  } as any;
}

/**
 * Capture the WS handler factory returned by createDesktopWsRoutes.
 */
function captureWsHandlers(
  sessionId: string,
  ticket?: string,
  sharedLeases = __createDesktopSharedLeasesForTest(),
) {
  let capturedFactory: any;

  const upgradeWebSocket = vi.fn((factory: any) => {
    capturedFactory = factory;
    return (_c: any, _next: any) => {};
  });

  createDesktopWsRoutes(upgradeWebSocket, {
    sharedLeases,
  });

  const fakeContext = {
    req: {
      param: vi.fn((key: string) => (key === 'id' ? sessionId : undefined)),
      query: vi.fn((key: string) => (key === 'ticket' ? ticket : undefined)),
      header: vi.fn(() => undefined)
    }
  };

  return capturedFactory(fakeContext);
}

/**
 * Set up database + auth mocks so that onOpen succeeds.
 * Uses a unique user ID each time to avoid the in-memory rate limiter.
 */
function setupSuccessfulValidation() {
  const userId = nextUserId();

  const ticketRecord = {
    ok: true as const,
    sessionId: SESSION_ID,
    sessionType: 'desktop' as const,
    userId,
    expiresAt: Date.now() + 60_000
  };

  vi.mocked(consumeWsTicket).mockResolvedValue(ticketRecord);

  const user = { id: userId, status: 'active' };
  const session = {
    id: SESSION_ID,
    type: 'desktop',
    userId,
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

  vi.mocked(isAgentConnected).mockReturnValue(true);
  vi.mocked(sendCommandToAgent).mockReturnValue(true);
  vi.mocked(db.update).mockReturnValue(mockUpdateNoReturn() as any);

  return { userId };
}

/**
 * Build the Hono app with the desktop WS routes mounted (for HTTP endpoint tests)
 */
function buildApp() {
  const upgradeWebSocket = vi.fn((_factory: any) => {
    return (_c: any, _next: any) => {};
  });
  return createDesktopWsRoutes(upgradeWebSocket);
}

// -------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------


describe('desktopWs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetDesktopWsForTest();
  });

  // ==========================================
  // WebSocket handler — onOpen
  // ==========================================

  describe('onOpen', () => {
    it('rejects connection when ticket is missing', async () => {
      const handlers = captureWsHandlers(SESSION_ID, undefined);
      const ws = wsMock();

      await handlers.onOpen({}, ws);

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"AUTH_FAILED"')
      );
      expect(ws.close).toHaveBeenCalledWith(4001, 'Authentication failed');
    });

    it('rejects connection when ticket is invalid', async () => {
      vi.mocked(consumeWsTicket).mockResolvedValue({ ok: false, reason: 'not_found' });

      const handlers = captureWsHandlers(SESSION_ID, 'bad-ticket');
      const ws = wsMock();

      await handlers.onOpen({}, ws);

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"AUTH_FAILED"')
      );
      expect(ws.close).toHaveBeenCalledWith(4001, 'Authentication failed');
    });

    it('rejects connection when ticket session type is not desktop', async () => {
      vi.mocked(consumeWsTicket).mockResolvedValue({
        ok: true,
        sessionId: SESSION_ID,
        sessionType: 'terminal', // wrong type
        userId: 'user-mismatch',
        expiresAt: Date.now() + 60_000
      });

      const handlers = captureWsHandlers(SESSION_ID, 'ticket-wrong-type');
      const ws = wsMock();

      await handlers.onOpen({}, ws);

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"AUTH_FAILED"')
      );
      expect(ws.close).toHaveBeenCalledWith(4001, 'Authentication failed');
    });

    it('rejects connection when user is not active', async () => {
      const userId = 'user-suspended';
      vi.mocked(consumeWsTicket).mockResolvedValue({
        ok: true,
        sessionId: SESSION_ID,
        sessionType: 'desktop',
        userId,
        expiresAt: Date.now() + 60_000
      });

      vi.mocked(db.select).mockReturnValueOnce(
        mockSelectChain([{ id: userId, status: 'suspended' }])
      );

      const handlers = captureWsHandlers(SESSION_ID, 'ticket-suspended-user');
      const ws = wsMock();

      await handlers.onOpen({}, ws);

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"AUTH_FAILED"')
      );
      expect(ws.close).toHaveBeenCalledWith(4001, 'Authentication failed');
    });

    it('rejects connection when user is not found', async () => {
      const userId = 'user-not-found';
      vi.mocked(consumeWsTicket).mockResolvedValue({
        ok: true,
        sessionId: SESSION_ID,
        sessionType: 'desktop',
        userId,
        expiresAt: Date.now() + 60_000
      });

      vi.mocked(db.select).mockReturnValueOnce(mockSelectChain([]));

      const handlers = captureWsHandlers(SESSION_ID, 'ticket-no-user');
      const ws = wsMock();

      await handlers.onOpen({}, ws);

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"AUTH_FAILED"')
      );
      expect(ws.close).toHaveBeenCalledWith(4001, 'Authentication failed');
    });

    it('rejects connection when session has wrong type', async () => {
      const userId = 'user-wrong-sess-type';
      vi.mocked(consumeWsTicket).mockResolvedValue({
        ok: true,
        sessionId: SESSION_ID,
        sessionType: 'desktop',
        userId,
        expiresAt: Date.now() + 60_000
      });

      const user = { id: userId, status: 'active' };
      const session = { id: SESSION_ID, type: 'terminal', userId, status: 'pending', deviceId: DEVICE_ID };
      const device = { id: DEVICE_ID, agentId: AGENT_ID, hostname: 'host', osType: 'linux', status: 'online' };

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

      const handlers = captureWsHandlers(SESSION_ID, 'ticket-session-type-mismatch');
      const ws = wsMock();

      await handlers.onOpen({}, ws);

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"AUTH_FAILED"')
      );
      expect(ws.close).toHaveBeenCalledWith(4001, 'Authentication failed');
    });

    it('rejects connection when session is disconnected', async () => {
      const userId = 'user-disconnected-sess';
      vi.mocked(consumeWsTicket).mockResolvedValue({
        ok: true,
        sessionId: SESSION_ID,
        sessionType: 'desktop',
        userId,
        expiresAt: Date.now() + 60_000
      });

      const user = { id: userId, status: 'active' };
      const session = { id: SESSION_ID, type: 'desktop', userId, status: 'disconnected', deviceId: DEVICE_ID };
      const device = { id: DEVICE_ID, agentId: AGENT_ID, hostname: 'host', osType: 'linux', status: 'online' };

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

      const handlers = captureWsHandlers(SESSION_ID, 'ticket-disconnected');
      const ws = wsMock();

      await handlers.onOpen({}, ws);

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"AUTH_FAILED"')
      );
      expect(ws.close).toHaveBeenCalledWith(4001, 'Authentication failed');
    });

    it('rejects connection when device is offline', async () => {
      const userId = 'user-offline-device';
      vi.mocked(consumeWsTicket).mockResolvedValue({
        ok: true,
        sessionId: SESSION_ID,
        sessionType: 'desktop',
        userId,
        expiresAt: Date.now() + 60_000
      });

      const user = { id: userId, status: 'active' };
      const session = { id: SESSION_ID, type: 'desktop', userId, status: 'pending', deviceId: DEVICE_ID };
      const device = { id: DEVICE_ID, agentId: AGENT_ID, hostname: 'host', osType: 'linux', status: 'offline' };

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

      const handlers = captureWsHandlers(SESSION_ID, 'ticket-device-offline');
      const ws = wsMock();

      await handlers.onOpen({}, ws);

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"AUTH_FAILED"')
      );
      expect(ws.close).toHaveBeenCalledWith(4001, 'Authentication failed');
    });

    it('rejects connection when agent is not connected via WebSocket', async () => {
      const userId = 'user-agent-off';
      vi.mocked(consumeWsTicket).mockResolvedValue({
        ok: true,
        sessionId: SESSION_ID,
        sessionType: 'desktop',
        userId,
        expiresAt: Date.now() + 60_000
      });

      const user = { id: userId, status: 'active' };
      const session = { id: SESSION_ID, type: 'desktop', userId, status: 'pending', deviceId: DEVICE_ID };
      const device = { id: DEVICE_ID, agentId: AGENT_ID, hostname: 'host', osType: 'linux', status: 'online' };

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

      vi.mocked(isAgentConnected).mockReturnValue(false);

      const handlers = captureWsHandlers(SESSION_ID, 'ticket-agent-off');
      const ws = wsMock();

      await handlers.onOpen({}, ws);

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"AGENT_OFFLINE"')
      );
      expect(ws.close).toHaveBeenCalledWith(4002, 'Agent offline');
    });

    it('successfully opens a desktop session', async () => {
      setupSuccessfulValidation();

      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();

      await handlers.onOpen({}, ws);

      // Should send 'connected' message
      const sentCalls = ws.send.mock.calls.map((c: any[]) => c[0]);
      const connectedMsg = sentCalls.find(
        (s: any) => typeof s === 'string' && s.includes('"connected"')
      );
      expect(connectedMsg).toBeDefined();
      const parsed = JSON.parse(connectedMsg);
      expect(parsed.type).toBe('connected');
      expect(parsed.sessionId).toBe(SESSION_ID);
      expect(parsed.device.hostname).toBe('test-host');
      expect(parsed.device.osType).toBe('windows');

      // Should update session status to 'active'
      expect(db.update).toHaveBeenCalled();

      // Should send desktop_stream_start command to agent
      expect(sendCommandToAgent).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({
          type: 'desktop_stream_start',
          payload: expect.objectContaining({
            sessionId: SESSION_ID,
            quality: 60,
            scaleFactor: 1.0,
            maxFps: 15
          })
        })
      );

      // Session should show as owned by the agent
      expect(isDesktopSessionOwnedByAgent(SESSION_ID, AGENT_ID)).toBe(true);
      expect(isDesktopSessionOwnedByAgent(SESSION_ID, 'wrong-agent')).toBe(false);
      expect(getActiveDesktopSessionCount()).toBeGreaterThanOrEqual(1);
    });

    it('sends AGENT_SEND_FAILED when sendCommandToAgent fails', async () => {
      setupSuccessfulValidation();
      vi.mocked(sendCommandToAgent).mockReturnValue(false);

      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();

      await handlers.onOpen({}, ws);

      const sentCalls = ws.send.mock.calls.map((c: any[]) => c[0]);
      const errorMsg = sentCalls.find(
        (s: any) => typeof s === 'string' && s.includes('"AGENT_SEND_FAILED"')
      );
      expect(errorMsg).toBeDefined();
      expect(isDesktopSessionOwnedByAgent(SESSION_ID, AGENT_ID)).toBe(false);
      expect(finalizeDesktopSessionOnceMock).toHaveBeenCalledTimes(1);
      expect(ws.close).toHaveBeenCalledWith(4003, 'Agent send failed');
    });

    it('starts renewal while activation is pending and never resurrects after lease loss', async () => {
      vi.useFakeTimers();
      setupSuccessfulValidation();
      let resolveActivation!: (rows: Array<{ id: string }>) => void;
      const activation = new Promise<Array<{ id: string }>>((resolve) => {
        resolveActivation = resolve;
      });
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(() => activation),
          })),
        })),
      } as any);
      const sharedLeases = __createDesktopSharedLeasesForTest();
      sharedLeases.renew = vi.fn(async () => {
        throw new Error('lease lost');
      });
      const handlers = captureWsHandlers(
        SESSION_ID,
        'valid-ticket',
        sharedLeases,
      );
      const ws = wsMock();

      const opening = handlers.onOpen({}, ws);
      for (let i = 0; i < 10 && !vi.mocked(db.update).mock.calls.length; i += 1) {
        await Promise.resolve();
      }
      await vi.advanceTimersByTimeAsync(5_000);
      resolveActivation([{ id: SESSION_ID }]);
      await opening;

      expect(sharedLeases.renew).toHaveBeenCalledTimes(1);
      expect(sendCommandToAgent).not.toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({ type: 'desktop_stream_start' }),
      );
      expect(ws.send).not.toHaveBeenCalledWith(expect.stringContaining('"connected"'));
      vi.useRealTimers();
    });
  });

});
