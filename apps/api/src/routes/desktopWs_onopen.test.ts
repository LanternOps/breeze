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
  },
  // remoteDesktopStartIntent.ts (real impl, not mocked in this file) throws
  // unless this reports an open db access context.
  hasDbAccessContext: vi.fn(() => true)
}));

vi.mock('../db/schema', () => ({
  remoteSessions: {
    id: 'remoteSessions.id',
    deviceId: 'remoteSessions.deviceId',
    status: 'remoteSessions.status',
    desktopStartGeneration: 'remoteSessions.desktopStartGeneration',
    terminalGeneration: 'remoteSessions.terminalGeneration',
    terminationPhase: 'remoteSessions.terminationPhase',
  },
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
  createDesktopStartCommandId: vi.fn((id: string) => `desk-start-${id}-${crypto.randomUUID()}`),
  logSessionAudit: vi.fn(async () => undefined),
  getIceServers: vi.fn(() => []),
  // Default: no consent/notify policy configured — matches the pre-existing
  // fixture's implicit behavior (this route sent no prompt block at all
  // before the fix). Individual tests override with mockResolvedValueOnce.
  buildRemoteSessionPromptPayload: vi.fn(async () => undefined),
  CONSENT_PROMPT_PROTOCOL_VERSION: 1,
  isConsentPromptCapable: vi.fn((v: number) => v === 1),
}));

vi.mock('../services/clientIp', () => ({
  getTrustedClientIp: vi.fn(() => '127.0.0.1'),
}));

// The relay reads the device's consent prompt capability itself: the device
// record it is handed on the upgrade path carries no capability fields.
const { loadDeviceConsentPromptProtocolVersionMock } = vi.hoisted(() => ({
  loadDeviceConsentPromptProtocolVersionMock: vi.fn(async (_deviceId: string) => 1),
}));
vi.mock('../services/deviceConsentPromptCapability', () => ({
  loadDeviceConsentPromptProtocolVersion: loadDeviceConsentPromptProtocolVersionMock,
}));

vi.mock('../services/remoteRevocationLease', () => ({
  AGENT_UPGRADE_REQUIRED_CODE: 'agent_upgrade_required',
  AGENT_UPGRADE_REQUIRED_MESSAGE: 'agent update required',
  prepareRevocationLeaseForStart: vi.fn(async () => ({
    ok: true,
    lease: {
      token: 'lease-token',
      expiresAt: 1_000_060_000,
      hardDeadline: 1_000_600_000,
      renewEverySec: 25,
      graceSec: 90,
    },
  })),
  renewRevocationLease: vi.fn(async () => ({
    status: 'renewed',
    expiresAt: 1_000_060_000,
    hardDeadline: 1_000_600_000,
    renewEverySec: 25,
    graceSec: 90,
  })),
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
  settleDesktopStreamStart,
  closeDesktopRelayForStop,
  __createDesktopSharedLeasesForTest,
  __resetDesktopWsForTest,
} from './desktopWs';
import { prepareRevocationLeaseForStart } from '../services/remoteRevocationLease';

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
        returning: vi.fn().mockResolvedValue([{ id: SESSION_ID, generation: 1n }]),
      }),
    })
  } as any;
}

// select().from().where().limit().for('update') — the row-locked read
// commitDesktopStreamStartIntent issues (real impl in
// remoteDesktopStartIntent.ts, not mocked in this file).
function mockSelectLimitForChain(result: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          for: vi.fn().mockResolvedValue(result)
        })
      })
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
function setupSuccessfulValidation(options: {
  /** Phase the row-locked start-intent read reports. */
  lockedPhase?: 'none' | 'pending' | 'confirmed';
  /** Phase the pre-publication re-read reports. */
  recheckPhase?: 'none' | 'pending' | 'confirmed';
  /** Generation the pre-publication re-read reports, to force a supersession. */
  recheckGeneration?: bigint;
  /**
   * Device-reported consent/notify prompt protocol version. Defaults to 1
   * (capable) so tests that don't care about this capability keep exercising
   * the normal successful-start path.
   */
  consentPromptProtocolVersion?: number;
  /**
   * False reproduces the upgrade path's device record, built from the
   * authorization context: identity only, no capability fields.
   */
  deviceCapabilityFields?: boolean;
} = {}) {
  const {
    lockedPhase = 'none',
    recheckPhase = 'none',
    recheckGeneration = 1n,
    consentPromptProtocolVersion = 1,
    deviceCapabilityFields = true,
  } = options;
  loadDeviceConsentPromptProtocolVersionMock.mockReset();
  loadDeviceConsentPromptProtocolVersionMock.mockResolvedValue(consentPromptProtocolVersion);
  const userId = nextUserId();

  // A test that exits the onOpen flow early (a refused start intent) leaves
  // this file's FIFO `mockReturnValueOnce` queue partly unconsumed, which the
  // NEXT test would then dequeue out of order. Start from empty.
  vi.mocked(db.select).mockReset();
  vi.mocked(db.update).mockReset();

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
    orgId: 'org-test-1',
    ...(deviceCapabilityFields ? { consentPromptProtocolVersion } : {}),
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
    } as any)
    // commitDesktopStreamStartIntent: row-locked read
    .mockReturnValueOnce(mockSelectLimitForChain([{
      status: session.status,
      terminationPhase: lockedPhase,
      // A terminal row carries the generation it was declared terminal at, so
      // the fixture stays coherent with the DB CHECK constraint.
      generation: lockedPhase === 'none' ? 0n : 7n
    }]))
    // assertDesktopStartIntentCurrent: pre-send re-read
    .mockReturnValueOnce(mockSelectChain([{
      terminationPhase: recheckPhase,
      generation: recheckGeneration
    }]));

  vi.mocked(isAgentConnected).mockReturnValue(true);
  vi.mocked(sendCommandToAgent).mockReturnValue(true);
  vi.mocked(db.update).mockReturnValue(mockUpdateNoReturn() as any);

  return { userId };
}

/** The desktop_stream_start command the relay published for SESSION_ID. */
function publishedStart(): { id: string; payload: Record<string, unknown> } {
  const call = vi.mocked(sendCommandToAgent).mock.calls.find(
    ([, cmd]) => (cmd as { type?: string }).type === 'desktop_stream_start',
  );
  if (!call) throw new Error('no desktop_stream_start was published');
  return call[1] as { id: string; payload: Record<string, unknown> };
}

/** Play the agent's accepted result for the published start. */
function acceptStart(): string {
  const { id } = publishedStart();
  settleDesktopStreamStart(SESSION_ID, AGENT_ID, id, { outcome: 'accepted' });
  return id;
}

function sentText(ws: ReturnType<typeof wsMock>): string[] {
  return ws.send.mock.calls.map((c: any[]) => c[0]).filter((v: unknown): v is string => typeof v === 'string');
}

function sentBinaryCount(ws: ReturnType<typeof wsMock>): number {
  return ws.send.mock.calls.filter((c: any[]) => c[0] instanceof ArrayBuffer).length;
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
      acceptStart();

      // Should send 'connected' message once the agent accepted the start
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

    // This WS-fallback transport previously started streaming with no
    // consent/notify prompt block at all — the agent's consent gate (the
    // ONLY place consent is actually enforced; the server's job is just to
    // resolve and ship the policy) had nothing to gate on regardless of the
    // device's configured policy. Ships the block exactly as the two WebRTC
    // start paths already do (buildRemoteSessionPromptPayload).
    it('resolves and ships the consent/notify prompt block in the desktop_stream_start payload', async () => {
      setupSuccessfulValidation();
      const { buildRemoteSessionPromptPayload } = await import('./remote/helpers');
      const prompt = {
        mode: 'consent' as const,
        technicianName: 'A Technician',
        consentUnavailableBehavior: 'block' as const,
      };
      vi.mocked(buildRemoteSessionPromptPayload).mockResolvedValueOnce(prompt);

      const handlers = captureWsHandlers(SESSION_ID, 'prompt-ticket');
      const ws = wsMock();
      await handlers.onOpen({}, ws);

      expect(sendCommandToAgent).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({
          type: 'desktop_stream_start',
          payload: expect.objectContaining({ prompt }),
        }),
      );
    });

    it('omits the prompt field entirely when the resolved policy is off (undefined)', async () => {
      setupSuccessfulValidation();
      const { buildRemoteSessionPromptPayload } = await import('./remote/helpers');
      vi.mocked(buildRemoteSessionPromptPayload).mockResolvedValueOnce(undefined);

      const handlers = captureWsHandlers(SESSION_ID, 'no-prompt-ticket');
      const ws = wsMock();
      await handlers.onOpen({}, ws);

      const call = vi.mocked(sendCommandToAgent).mock.calls.find(
        ([, cmd]: any[]) => cmd.type === 'desktop_stream_start',
      );
      expect(call).toBeDefined();
      expect(call![1].payload).not.toHaveProperty('prompt');
    });

    // An agent build that predates the consent-gate feature silently ignores
    // an unfamiliar `prompt` key (Go's JSON unmarshal into a known struct
    // drops unknown fields) and streams unconditionally. When the resolved
    // policy requires consent or notification, the server must refuse to
    // start on such an agent rather than dispatch a prompt block it will not
    // honor — unattended devices (policy mode 'off', no prompt block) are
    // unaffected.
    it('refuses to start when the device is not consent-prompt capable and the policy requires a prompt', async () => {
      setupSuccessfulValidation({ consentPromptProtocolVersion: 0 });
      const { buildRemoteSessionPromptPayload } = await import('./remote/helpers');
      vi.mocked(buildRemoteSessionPromptPayload).mockResolvedValueOnce({
        mode: 'consent' as const,
        technicianName: 'A Technician',
        consentUnavailableBehavior: 'block' as const,
      });

      const handlers = captureWsHandlers(SESSION_ID, 'old-agent-consent-required-ticket');
      const ws = wsMock();
      await handlers.onOpen({}, ws);

      expect(sendCommandToAgent).not.toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({ type: 'desktop_stream_start' }),
      );
      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"CONSENT_UPGRADE_REQUIRED"'),
      );
      expect(ws.close).toHaveBeenCalled();
    });

    it('refuses to start, telling the viewer why, when the prompt policy cannot be resolved', async () => {
      setupSuccessfulValidation();
      const { buildRemoteSessionPromptPayload } = await import('./remote/helpers');
      const { RemoteSessionPromptPolicyError } = await import('./remote/consentGate');
      vi.mocked(buildRemoteSessionPromptPayload).mockRejectedValueOnce(
        new RemoteSessionPromptPolicyError('device-1', 'statement timeout'),
      );

      const handlers = captureWsHandlers(SESSION_ID, 'policy-unavailable-ticket');
      const ws = wsMock();
      await handlers.onOpen({}, ws);

      expect(sendCommandToAgent).not.toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({ type: 'desktop_stream_start' }),
      );
      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"REMOTE_PROMPT_POLICY_UNAVAILABLE"'),
      );
      expect(ws.close).toHaveBeenCalledWith(4003, expect.any(String));
    });

    // The upgrade path hands onOpen a device record without capability
    // fields. A current agent must still get its notify (the default) or
    // consent prompt, not a blanket CONSENT_UPGRADE_REQUIRED.
    it.each([
      ['notify', { mode: 'notify' as const, technicianName: 'A Technician' }],
      ['consent', { mode: 'consent' as const, technicianName: 'A Technician', consentUnavailableBehavior: 'block' as const }],
    ])('starts a prompt-capable agent under a %s policy even when the device record carries no capability fields', async (_mode, prompt) => {
      setupSuccessfulValidation({ consentPromptProtocolVersion: 2, deviceCapabilityFields: false });
      const { buildRemoteSessionPromptPayload } = await import('./remote/helpers');
      vi.mocked(buildRemoteSessionPromptPayload).mockResolvedValueOnce(prompt);

      const handlers = captureWsHandlers(SESSION_ID, 'upgrade-path-ticket');
      const ws = wsMock();
      await handlers.onOpen({}, ws);

      expect(ws.send).not.toHaveBeenCalledWith(expect.stringContaining('"CONSENT_UPGRADE_REQUIRED"'));
      expect(sendCommandToAgent).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({ type: 'desktop_stream_start', payload: expect.objectContaining({ prompt }) }),
      );
      expect(loadDeviceConsentPromptProtocolVersionMock).toHaveBeenCalledWith(DEVICE_ID);
    });

    it('still starts on a non-consent-prompt-capable agent when the resolved policy is off', async () => {
      setupSuccessfulValidation({ consentPromptProtocolVersion: 0 });
      const { buildRemoteSessionPromptPayload } = await import('./remote/helpers');
      vi.mocked(buildRemoteSessionPromptPayload).mockResolvedValueOnce(undefined);

      const handlers = captureWsHandlers(SESSION_ID, 'old-agent-no-policy-ticket');
      const ws = wsMock();
      await handlers.onOpen({}, ws);

      expect(sendCommandToAgent).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({ type: 'desktop_stream_start' }),
      );
    });

    // A start refused by the fence must TELL the viewer why: a
    // socket that just drops is indistinguishable from a network blip, leaving
    // the client with nothing to render and nothing to branch on.
    it('tells the viewer the reason when the start intent is refused as terminal', async () => {
      setupSuccessfulValidation({ lockedPhase: 'pending' });

      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();

      await handlers.onOpen({}, ws);

      const sent = ws.send.mock.calls.map((c: any[]) => c[0]);
      expect(sent.some((s: any) => typeof s === 'string' && s.includes('"SESSION_TERMINAL"'))).toBe(true);
      expect(ws.close).toHaveBeenCalledWith(4003, 'Session not startable');
      expect(sendCommandToAgent).not.toHaveBeenCalled();
    });

    it('reports the pre-publication re-read denial with its own reason, not a blanket supersession', async () => {
      setupSuccessfulValidation({ recheckPhase: 'pending' });

      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();

      await handlers.onOpen({}, ws);

      const sent = ws.send.mock.calls.map((c: any[]) => c[0]);
      expect(sent.some((s: any) => typeof s === 'string' && s.includes('"SESSION_TERMINAL"'))).toBe(true);
      expect(sent.some((s: any) => typeof s === 'string' && s.includes('"SESSION_SUPERSEDED"'))).toBe(false);
      expect(sendCommandToAgent).not.toHaveBeenCalled();
    });

    it('refuses to publish a start whose generation was superseded during setup', async () => {
      setupSuccessfulValidation({ recheckGeneration: 9n });

      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();

      await handlers.onOpen({}, ws);

      const sent = ws.send.mock.calls.map((c: any[]) => c[0]);
      expect(sent.some((s: any) => typeof s === 'string' && s.includes('"SESSION_SUPERSEDED"'))).toBe(true);
      expect(sendCommandToAgent).not.toHaveBeenCalled();
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

  // The WebSocket fallback's start is a handshake, like WebRTC's: the agent
  // answers the exact start it was sent (after its consent prompt, where one
  // applies), and the relay forwards nothing — no frames, no input — until
  // that answer accepted it. A denial or failure is told to the viewer.
  describe('WebSocket fallback start handshake', () => {
    it('binds the start to a one-off command identity and forwards nothing before the agent accepts', async () => {
      setupSuccessfulValidation();
      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();
      await handlers.onOpen({}, ws);

      const start = publishedStart();
      expect(start.id).toMatch(
        new RegExp(`^desk-start-${SESSION_ID}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`),
      );
      expect(sentText(ws).some((m) => m.includes('"connected"'))).toBe(false);

      handleDesktopFrame(SESSION_ID, new Uint8Array([1, 2, 3]));
      handleDesktopFrame(SESSION_ID, new Uint8Array([4, 5, 6, 7]));
      expect(sentBinaryCount(ws)).toBe(0);

      vi.mocked(sendCommandToAgent).mockClear();
      await handlers.onMessage({ data: JSON.stringify({ type: 'input', event: { type: 'mouse_move', x: 1, y: 1 } }) } as any, ws);
      expect(sendCommandToAgent).not.toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({ type: 'desktop_input' }),
      );

      settleDesktopStreamStart(SESSION_ID, AGENT_ID, start.id, { outcome: 'accepted' });
      expect(sentText(ws).some((m) => m.includes('"connected"'))).toBe(true);
      // The latest frame captured before the accept is delivered, so a still
      // desktop (unchanged frames are not re-sent) is not left blank.
      const binaries = ws.send.mock.calls.filter((c: any[]) => c[0] instanceof ArrayBuffer);
      expect(binaries).toHaveLength(1);
      expect(new Uint8Array(binaries[0]![0] as ArrayBuffer)).toEqual(new Uint8Array([4, 5, 6, 7]));

      handleDesktopFrame(SESSION_ID, new Uint8Array([8]));
      expect(sentBinaryCount(ws)).toBe(2);
      await handlers.onMessage({ data: JSON.stringify({ type: 'input', event: { type: 'mouse_move', x: 2, y: 2 } }) } as any, ws);
      expect(sendCommandToAgent).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({ type: 'desktop_input' }),
      );
    });

    it('ignores an answer for a different start or from a different agent', async () => {
      setupSuccessfulValidation();
      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();
      await handlers.onOpen({}, ws);
      const start = publishedStart();

      settleDesktopStreamStart(SESSION_ID, AGENT_ID, `${start.id}-other`, { outcome: 'accepted' });
      settleDesktopStreamStart(SESSION_ID, 'another-agent', start.id, { outcome: 'accepted' });
      settleDesktopStreamStart(SESSION_ID, AGENT_ID, `desk-start-${SESSION_ID}-00000000-0000-4000-8000-000000000000`, { outcome: 'denied', reason: 'user' });

      expect(sentText(ws).some((m) => m.includes('"connected"'))).toBe(false);
      expect(ws.close).not.toHaveBeenCalled();
    });

    it('tells the viewer the end user declined, and closes the relay', async () => {
      setupSuccessfulValidation();
      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();
      await handlers.onOpen({}, ws);

      settleDesktopStreamStart(SESSION_ID, AGENT_ID, publishedStart().id, { outcome: 'denied', reason: 'user' });
      await vi.waitFor(() => expect(finalizeDesktopSessionOnceMock).toHaveBeenCalled());

      const error = sentText(ws).map((m) => JSON.parse(m)).find((m) => m.type === 'error');
      expect(error).toMatchObject({
        code: 'CONSENT_DENIED',
        message: 'The user on the remote device declined the connection.',
      });
      expect(ws.close).toHaveBeenCalledWith(4003, 'Consent denied');
      handleDesktopFrame(SESSION_ID, new Uint8Array([1]));
      expect(sentBinaryCount(ws)).toBe(0);
    });

    it('tells the viewer the specific consent refusal when the agent reports a detail', async () => {
      setupSuccessfulValidation();
      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();
      await handlers.onOpen({}, ws);

      settleDesktopStreamStart(SESSION_ID, AGENT_ID, publishedStart().id, {
        outcome: 'denied',
        reason: 'helper_unreachable',
        detail: 'prompt_in_progress',
      });
      await vi.waitFor(() => expect(finalizeDesktopSessionOnceMock).toHaveBeenCalled());

      const error = sentText(ws).map((m) => JSON.parse(m)).find((m) => m.type === 'error');
      expect(error).toMatchObject({ code: 'CONSENT_DENIED', message: expect.stringMatching(/already waiting/) });
    });

    it('tells the viewer why the agent could not start, and closes the relay', async () => {
      setupSuccessfulValidation();
      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();
      await handlers.onOpen({}, ws);

      settleDesktopStreamStart(SESSION_ID, AGENT_ID, publishedStart().id, {
        outcome: 'failed',
        error: 'failed to create screen capturer',
      });
      await vi.waitFor(() => expect(finalizeDesktopSessionOnceMock).toHaveBeenCalled());

      const error = sentText(ws).map((m) => JSON.parse(m)).find((m) => m.type === 'error');
      expect(error).toMatchObject({ code: 'AGENT_START_FAILED' });
      expect(error.message).toContain('failed to create screen capturer');
      expect(ws.close).toHaveBeenCalledWith(4003, 'Start failed');
    });

    it('closes the relay when the agent never answers within the start budget', async () => {
      vi.useFakeTimers();
      try {
        setupSuccessfulValidation();
        const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
        const ws = wsMock();
        await handlers.onOpen({}, ws);

        // No prompt: 15 s answer budget + margin. Nothing before it...
        await vi.advanceTimersByTimeAsync(20_000);
        expect(sentText(ws).some((m) => m.includes('START_TIMEOUT'))).toBe(false);
        // ...and a refusal after it.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(sentText(ws).some((m) => m.includes('"START_TIMEOUT"'))).toBe(true);
        expect(ws.close).toHaveBeenCalledWith(4003, 'Start timed out');
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops forwarding the moment the session is stopped, and tells the viewer', async () => {
      setupSuccessfulValidation();
      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();
      await handlers.onOpen({}, ws);
      acceptStart();
      handleDesktopFrame(SESSION_ID, new Uint8Array([1]));
      expect(sentBinaryCount(ws)).toBe(1);

      closeDesktopRelayForStop(SESSION_ID);

      // Synchronous: no frame after the stop, even before cleanup completes.
      handleDesktopFrame(SESSION_ID, new Uint8Array([2]));
      expect(sentBinaryCount(ws)).toBe(1);
      const error = sentText(ws).map((m) => JSON.parse(m)).find((m) => m.type === 'error');
      expect(error).toMatchObject({ code: 'SESSION_ENDED' });
      await vi.waitFor(() => expect(finalizeDesktopSessionOnceMock).toHaveBeenCalled());
      // Unknown session: a no-op.
      expect(() => closeDesktopRelayForStop('no-such-session')).not.toThrow();
    });

    // stop_desktop is usually dispatched from inside a request's db
    // transaction (End, teardown). The relay's durable close must not run on
    // that transaction: it is escaped with runOutsideDbContext.
    it('runs the durable close outside the caller\'s db context', async () => {
      const { runOutsideDbContext } = await import('../db');
      setupSuccessfulValidation();
      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();
      await handlers.onOpen({}, ws);
      acceptStart();
      vi.mocked(runOutsideDbContext).mockClear();

      closeDesktopRelayForStop(SESSION_ID);
      expect(runOutsideDbContext).toHaveBeenCalled();
      await vi.waitFor(() => expect(finalizeDesktopSessionOnceMock).toHaveBeenCalled());
    });

    it('still closes the viewer socket when the durable close cannot even begin, and logs why', async () => {
      const sharedLeases = __createDesktopSharedLeasesForTest();
      sharedLeases.beginClose = vi.fn(async () => { throw new Error('redis down'); });
      setupSuccessfulValidation();
      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket', sharedLeases);
      const ws = wsMock();
      await handlers.onOpen({}, ws);
      acceptStart();
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});

      closeDesktopRelayForStop(SESSION_ID);

      await vi.waitFor(() => expect(ws.close).toHaveBeenCalledWith(4003, 'Session ended'));
      await vi.waitFor(() => expect(err).toHaveBeenCalledWith(
        '[DesktopWs] cleanup retained for durable recovery',
        expect.objectContaining({ trigger: 'stop_requested', error: 'redis down' }),
      ));
      err.mockRestore();
    });

    it('logs a refused start\'s cleanup failure under its own reason', async () => {
      const sharedLeases = __createDesktopSharedLeasesForTest();
      sharedLeases.beginClose = vi.fn(async () => { throw new Error('redis down'); });
      setupSuccessfulValidation();
      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket', sharedLeases);
      const ws = wsMock();
      await handlers.onOpen({}, ws);
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});

      settleDesktopStreamStart(SESSION_ID, AGENT_ID, publishedStart().id, { outcome: 'refused' });

      await vi.waitFor(() => expect(err).toHaveBeenCalledWith(
        '[DesktopWs] cleanup retained for durable recovery',
        expect.objectContaining({ trigger: 'start_not_streaming', error: 'redis down' }),
      ));
      err.mockRestore();
    });

    it('refuses an agent without the start fence with the agent-update message and publishes nothing', async () => {
      setupSuccessfulValidation();
      vi.mocked(prepareRevocationLeaseForStart).mockResolvedValueOnce({ ok: false, reason: 'agent_upgrade_required' });
      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();
      await handlers.onOpen({}, ws);

      const error = sentText(ws).map((m) => JSON.parse(m)).find((m) => m.type === 'error');
      expect(error).toMatchObject({ code: 'AGENT_UPGRADE_REQUIRED', message: 'agent update required' });
      expect(sendCommandToAgent).not.toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({ type: 'desktop_stream_start' }),
      );
      expect(ws.close).toHaveBeenCalledWith(4003, 'Agent update required');
    });
  });

});
