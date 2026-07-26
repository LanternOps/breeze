import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  persistDesktopFinalizationIntentMock,
  finalizeDesktopSessionOnceMock,
  enqueueDesktopSessionFinalizationMock,
  ensureDesktopStreamStoppedMock,
} = vi.hoisted(() => ({
  persistDesktopFinalizationIntentMock: vi.fn(async ({ finalization }: any) => ({
    input: finalization,
    canonicalPayload: JSON.stringify(finalization),
    payloadSha256: 'a'.repeat(64),
  })),
  finalizeDesktopSessionOnceMock: vi.fn(async () => 'finalized' as const),
  enqueueDesktopSessionFinalizationMock: vi.fn(async ({ sessionId, finalizationId }: any) => ({
    acknowledged: true as const,
    jobId: `desktop-finalize-${sessionId}-${finalizationId}`,
  })),
  ensureDesktopStreamStoppedMock: vi.fn(async ({ finalizationId }: any) => ({
    state: 'pending',
    commandId: finalizationId,
    reason: 'delivery_unacknowledged',
  })),
}));

vi.mock('../services/desktopSessionFinalization', () => ({
  persistDesktopFinalizationIntent: persistDesktopFinalizationIntentMock,
  finalizeDesktopSessionOnce: finalizeDesktopSessionOnceMock,
}));

vi.mock('../jobs/desktopSessionFinalizationWorker', () => ({
  enqueueDesktopSessionFinalization: enqueueDesktopSessionFinalizationMock,
}));

vi.mock('../services/desktopSessionStop', () => ({
  ensureDesktopStreamStopped: ensureDesktopStreamStoppedMock,
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
import { isViewerSessionRevoked } from '../services/viewerTokenRevocation';
import { consumeWsTicket, consumeDesktopConnectCode, getViewerAccessTokenExpirySeconds } from '../services/remoteSessionAuth';
import { createAccessToken } from '../services/jwt';
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
  closeDesktopSessionLifecycle,
} from './desktopWs';

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

const SESSION_ID = 'session-desktop-001';
const DEVICE_ID = 'device-xyz';
const AGENT_ID = 'agent-xyz';
// Mirror PING_INTERVAL_MS in desktopWs.ts (30s).
const PING_INTERVAL_MS = 30_000;

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
function captureWsHandlers(sessionId: string, ticket?: string) {
  let capturedFactory: any;

  const upgradeWebSocket = vi.fn((factory: any) => {
    capturedFactory = factory;
    return (_c: any, _next: any) => {};
  });

  createDesktopWsRoutes(upgradeWebSocket, {
    sharedLeases: __createDesktopSharedLeasesForTest(),
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

  const mockIsViewerSessionRevoked = vi.mocked(isViewerSessionRevoked);
  mockIsViewerSessionRevoked.mockResolvedValue(false);

  return { userId, mockIsViewerSessionRevoked };
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
  // WebSocket handler — onClose
  // ==========================================

  describe('onClose', () => {
    it('publishes one cleanup promise and removes the local owner only after finalization', async () => {
      setupSuccessfulValidation();
      let finishFinalization!: (result: 'finalized') => void;
      finalizeDesktopSessionOnceMock.mockImplementationOnce(
        () => new Promise((resolve) => {
          finishFinalization = resolve;
        }),
      );

      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();
      await handlers.onOpen({}, ws);

      const options = {
        expectedWs: ws as never,
        connection: {
          connectionId: '33333333-3333-4333-8333-333333333333',
          generation: 1,
          instanceId: '44444444-4444-4444-8444-444444444444',
          leaseToken: '55555555-5555-4555-8555-555555555555',
        },
        reason: 'client_close' as const,
        terminalStatus: 'disconnected' as const,
        notifyAgent: true,
      };
      const first = closeDesktopSessionLifecycle(SESSION_ID, options);
      const duplicate = closeDesktopSessionLifecycle(SESSION_ID, options);

      expect(duplicate).toBe(first);
      await vi.waitFor(() => {
        expect(finalizeDesktopSessionOnceMock).toHaveBeenCalledTimes(1);
      });
      expect(getActiveDesktopSessionCount()).toBe(1);

      finishFinalization('finalized');
      await first;

      expect(persistDesktopFinalizationIntentMock).toHaveBeenCalledTimes(1);
      expect(finalizeDesktopSessionOnceMock).toHaveBeenCalledTimes(1);
      expect(getActiveDesktopSessionCount()).toBe(0);
    });

    it('persists write-ahead intent before detaching the exact viewer socket', async () => {
      setupSuccessfulValidation();
      let acknowledgeIntent!: () => void;
      let finishFinalization!: (result: 'finalized') => void;
      persistDesktopFinalizationIntentMock.mockImplementationOnce(
        ({ finalization }: any) => new Promise((resolve) => {
          acknowledgeIntent = () => resolve({
            input: finalization,
            canonicalPayload: JSON.stringify(finalization),
            payloadSha256: 'a'.repeat(64),
          });
        }),
      );
      finalizeDesktopSessionOnceMock.mockImplementationOnce(
        () => new Promise((resolve) => {
          finishFinalization = resolve;
        }),
      );

      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();
      await handlers.onOpen({}, ws);
      ws.close.mockClear();

      const cleanup = closeDesktopSessionLifecycle(SESSION_ID, {
        expectedWs: ws as never,
        connection: {
          connectionId: '33333333-3333-4333-8333-333333333333',
          generation: 1,
          instanceId: '44444444-4444-4444-8444-444444444444',
          leaseToken: '55555555-5555-4555-8555-555555555555',
        },
        reason: 'revoked',
        terminalStatus: 'failed',
        notifyAgent: true,
      });

      await Promise.resolve();
      expect(persistDesktopFinalizationIntentMock).toHaveBeenCalledTimes(1);
      expect(ws.close).not.toHaveBeenCalled();
      expect(finalizeDesktopSessionOnceMock).not.toHaveBeenCalled();

      acknowledgeIntent();
      await vi.waitFor(() => {
        expect(finalizeDesktopSessionOnceMock).toHaveBeenCalledTimes(1);
      });
      expect(ws.close).toHaveBeenCalledWith(4003, 'Session revoked');

      finishFinalization('finalized');
      await cleanup;
    });

    it('retries the frozen cleanup identity while a write-ahead failure remains closing', async () => {
      vi.useFakeTimers();
      setupSuccessfulValidation();
      persistDesktopFinalizationIntentMock.mockRejectedValueOnce(
        new Error('redis intent unavailable'),
      );
      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();
      await handlers.onOpen({}, ws);

      await expect(closeDesktopSessionLifecycle(SESSION_ID, {
        expectedWs: ws as never,
        connection: {
          connectionId: '33333333-3333-4333-8333-333333333333',
          generation: 1,
          instanceId: '44444444-4444-4444-8444-444444444444',
          leaseToken: '55555555-5555-4555-8555-555555555555',
        },
        reason: 'socket_error',
        terminalStatus: 'failed',
        notifyAgent: true,
      })).rejects.toThrow('redis intent unavailable');

      expect(getActiveDesktopSessionCount()).toBe(1);
      expect(persistDesktopFinalizationIntentMock).toHaveBeenCalledTimes(1);
      expect(finalizeDesktopSessionOnceMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(persistDesktopFinalizationIntentMock).toHaveBeenCalledTimes(2);
      });
      expect(finalizeDesktopSessionOnceMock).toHaveBeenCalledTimes(1);
      expect(getActiveDesktopSessionCount()).toBe(0);
    });

    it('cleans up session and sends stop command to agent', async () => {
      setupSuccessfulValidation();

      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();

      await handlers.onOpen({}, ws);
      expect(isDesktopSessionOwnedByAgent(SESSION_ID, AGENT_ID)).toBe(true);

      vi.mocked(db.update).mockClear();
      vi.mocked(db.update).mockReturnValue(mockUpdateNoReturn() as any);
      vi.mocked(sendCommandToAgent).mockClear();

      await handlers.onClose({}, ws);

      // Session should be removed
      expect(isDesktopSessionOwnedByAgent(SESSION_ID, AGENT_ID)).toBe(false);

      expect(persistDesktopFinalizationIntentMock).toHaveBeenCalledTimes(1);
      expect(finalizeDesktopSessionOnceMock).toHaveBeenCalledTimes(1);
    });

    it('handles close for non-existent session gracefully', async () => {
      const handlers = captureWsHandlers('never-opened-desk', undefined);
      const ws = wsMock();

      await handlers.onClose({}, ws);

      expect(sendCommandToAgent).not.toHaveBeenCalled();
    });
  });

  // ==========================================
  // WebSocket handler — onError
  // ==========================================

  describe('onError', () => {
    it('cleans up session on error', async () => {
      setupSuccessfulValidation();

      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();

      await handlers.onOpen({}, ws);

      vi.mocked(db.update).mockClear();
      vi.mocked(db.update).mockReturnValue(mockUpdateNoReturn() as any);
      vi.mocked(sendCommandToAgent).mockClear();

      await handlers.onError(new Error('connection reset'), ws);

      expect(isDesktopSessionOwnedByAgent(SESSION_ID, AGENT_ID)).toBe(false);

      expect(persistDesktopFinalizationIntentMock).toHaveBeenCalledTimes(1);
      expect(finalizeDesktopSessionOnceMock).toHaveBeenCalledTimes(1);
    });

    it('handles error for non-existent session gracefully', async () => {
      const handlers = captureWsHandlers('never-opened-desk', undefined);
      const ws = wsMock();

      await handlers.onError(new Error('ws error'), ws);
      // Should not throw
    });

    it('catches database errors during error cleanup', async () => {
      setupSuccessfulValidation();

      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();

      await handlers.onOpen({}, ws);

      finalizeDesktopSessionOnceMock.mockRejectedValueOnce(new Error('DB down'));

      // Should not throw even when DB fails
      await handlers.onError(new Error('ws error'), ws);

      // A durable queue acknowledgement permits exact ownership release while
      // the persisted intent remains the admission barrier.
      expect(isDesktopSessionOwnedByAgent(SESSION_ID, AGENT_ID)).toBe(false);
      expect(enqueueDesktopSessionFinalizationMock).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================
  // Route creation
  // ==========================================

  describe('createDesktopWsRoutes', () => {
    it('calls upgradeWebSocket with a factory function', () => {
      const upgradeWebSocket = vi.fn(() => (_c: any, _next: any) => {});
      const app = createDesktopWsRoutes(upgradeWebSocket);

      expect(upgradeWebSocket).toHaveBeenCalledTimes(1);
      expect(typeof (upgradeWebSocket.mock.calls[0] as unknown[])[0]).toBe('function');
      expect(app).toBeDefined();
    });

    it('registers /health and WS routes', async () => {
      const app = buildApp();
      const res = await app.request('/health', { method: 'GET' });
      expect(res.status).toBe(200);
    });
  });

  // ==========================================
  // #4: mid-session revocation via the ping loop
  // ==========================================

  describe('mid-session revocation (ping loop)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('closes the socket (4003) and removes the session within one ping interval once revoked', async () => {
      // Install fake timers BEFORE onOpen so the ping setInterval is captured.
      vi.useFakeTimers();

      // Open a real, fully-validated session.
      const { mockIsViewerSessionRevoked } = setupSuccessfulValidation();
      // Stay un-revoked through onOpen so setup completes.
      mockIsViewerSessionRevoked.mockResolvedValue(false);

      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();
      await handlers.onOpen({}, ws);
      expect(getActiveDesktopSessionCount()).toBe(1);

      // Now flip to revoked and let the ping interval fire.
      mockIsViewerSessionRevoked.mockResolvedValue(true);

      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
      // Flush the microtask queue for the .then() chain.
      await Promise.resolve();
      await Promise.resolve();

      expect(ws.close).toHaveBeenCalledWith(4003, 'Session revoked');
      expect(getActiveDesktopSessionCount()).toBe(0);
    });

    it('negative control: stays open and pings while not revoked', async () => {
      vi.useFakeTimers();

      const { mockIsViewerSessionRevoked } = setupSuccessfulValidation();
      mockIsViewerSessionRevoked.mockResolvedValue(false);

      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();
      await handlers.onOpen({}, ws);
      expect(getActiveDesktopSessionCount()).toBe(1);

      ws.send.mockClear();
      ws.close.mockClear();

      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
      await Promise.resolve();
      await Promise.resolve();

      // Not revoked: socket stays open and a server ping is sent this tick.
      expect(ws.close).not.toHaveBeenCalled();
      expect(getActiveDesktopSessionCount()).toBe(1);
      const pingSent = ws.send.mock.calls.some((args: unknown[]) => {
        try {
          return JSON.parse(args[0] as string)?.type === 'ping';
        } catch {
          return false;
        }
      });
      expect(pingSent).toBe(true);

      // Clean up so the count doesn't leak into other tests.
      vi.useRealTimers();
      await handlers.onClose({}, ws);
      expect(getActiveDesktopSessionCount()).toBe(0);
    });

    it('I3: fails CLOSED (4003) when the revocation check rejects', async () => {
      vi.useFakeTimers();

      const { mockIsViewerSessionRevoked } = setupSuccessfulValidation();
      mockIsViewerSessionRevoked.mockResolvedValue(false);

      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();
      await handlers.onOpen({}, ws);
      expect(getActiveDesktopSessionCount()).toBe(1);

      // A thrown rejection (distinct from the Redis-down fail-closed `true`
      // path) must still tear down the socket via the new `.catch`.
      mockIsViewerSessionRevoked.mockRejectedValue(new Error('redis rejected'));

      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
      await Promise.resolve();
      await Promise.resolve();

      expect(ws.close).toHaveBeenCalledWith(4003, 'Session revocation check failed');
      expect(getActiveDesktopSessionCount()).toBe(0);
    });

    it('safely detaches and attempts the stable stop when write-ahead persistence fails', async () => {
      vi.useFakeTimers();
      const { mockIsViewerSessionRevoked } = setupSuccessfulValidation();
      mockIsViewerSessionRevoked.mockResolvedValue(false);
      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();
      await handlers.onOpen({}, ws);
      ws.close.mockClear();

      persistDesktopFinalizationIntentMock.mockRejectedValueOnce(
        new Error('redis intent unavailable'),
      );
      mockIsViewerSessionRevoked.mockResolvedValue(true);

      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
      await Promise.resolve();
      await Promise.resolve();

      expect(ws.close).toHaveBeenCalledWith(4003, 'Session revoked');
      expect(ensureDesktopStreamStoppedMock).toHaveBeenCalledTimes(1);
      expect(finalizeDesktopSessionOnceMock).not.toHaveBeenCalled();
      expect(getActiveDesktopSessionCount()).toBe(1);
    });
  });

});
