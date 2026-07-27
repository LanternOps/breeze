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
  consumeWsTicket: vi.fn()
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
// Mock both so existing tests stay allow-by-default.
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

// -------------------------------------------------------------------
// Imports (after mocks)
// -------------------------------------------------------------------
import { db } from '../db';
import { consumeWsTicket } from '../services/remoteSessionAuth';
import { sendCommandToAgent, isAgentConnected } from './agentWs';
import {
  handleTerminalOutput,
  registerTerminalOutputCallback,
  unregisterTerminalOutputCallback,
  getActiveTerminalSession,
  createTerminalWsRoutes,
  __createTerminalSharedLeasesForTest,
  __resetTerminalWsForTest,
  getActiveTerminalSessionCount,
  getActiveTerminalSessionIds
} from './terminalWs';

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

const SESSION_ID = 'session-terminal-001';
const DEVICE_ID = 'device-xyz';
const AGENT_ID = 'agent-xyz';

// Use a unique user ID per successful onOpen to avoid the in-memory
// rate limiter (10 connections per user per 60s) blocking later tests.
let userIdCounter = 0;
function nextUserId(): string {
  return `user-term-${++userIdCounter}`;
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
      where: vi.fn().mockResolvedValue(undefined)
    })
  } as any;
}

/**
 * Capture the WS handler factory returned by createTerminalWsRoutes.
 * The route calls upgradeWebSocket(factory), so we intercept that call
 * and invoke the factory with a fake Hono context to get { onOpen, onMessage, onClose, onError }.
 */
function captureWsHandlers(sessionId: string, ticket?: string) {
  let capturedFactory: any;

  const upgradeWebSocket = vi.fn((factory: any) => {
    capturedFactory = factory;
    // Return a no-op middleware so the Hono route registers
    return (_c: any, _next: any) => {};
  });

  // Every capture gets its own lease manager, but generations are globally
  // monotonic — a replaced generation can never reuse a prior identity.
  const testSharedLeases = __createTerminalSharedLeasesForTest();
  createTerminalWsRoutes(upgradeWebSocket, { sharedLeases: testSharedLeases });

  // Simulate the Hono context the factory expects
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
function setupSuccessfulValidation(overrides?: { osType?: string }) {
  const userId = nextUserId();

  const ticketRecord = {
    ok: true as const,
    sessionId: SESSION_ID,
    sessionType: 'terminal' as const,
    userId,
    expiresAt: Date.now() + 60_000
  };

  vi.mocked(consumeWsTicket).mockResolvedValue(ticketRecord);

  const user = { id: userId, status: 'active' };
  const session = {
    id: SESSION_ID,
    type: 'terminal',
    userId,
    status: 'pending',
    deviceId: DEVICE_ID
  };
  const device = {
    id: DEVICE_ID,
    agentId: AGENT_ID,
    hostname: 'test-host',
    osType: overrides?.osType ?? 'linux',
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

// -------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------


describe('terminalWs', () => {
  beforeEach(() => {
    // Ownership is now exact: a leftover session from a prior test would
    // legitimately refuse replacement, so start each test from a clean map.
    __resetTerminalWsForTest();
    vi.clearAllMocks();
  });

  // ==========================================
  // Exported utility functions
  // ==========================================

  describe('handleTerminalOutput', () => {
    it('invokes registered callback with data', () => {
      const cb = vi.fn();
      registerTerminalOutputCallback('sess-1', cb);
      handleTerminalOutput('sess-1', 'hello world');
      expect(cb).toHaveBeenCalledWith('hello world');
      unregisterTerminalOutputCallback('sess-1');
    });

    it('does nothing when no callback is registered', () => {
      // Should not throw
      handleTerminalOutput('nonexistent', 'data');
    });
  });

  describe('registerTerminalOutputCallback / unregisterTerminalOutputCallback', () => {
    it('replaces a previously registered callback', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      registerTerminalOutputCallback('sess-2', cb1);
      registerTerminalOutputCallback('sess-2', cb2);
      handleTerminalOutput('sess-2', 'test');
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).toHaveBeenCalledWith('test');
      unregisterTerminalOutputCallback('sess-2');
    });

    it('unregisters callback so subsequent output is dropped', () => {
      const cb = vi.fn();
      registerTerminalOutputCallback('sess-3', cb);
      unregisterTerminalOutputCallback('sess-3');
      handleTerminalOutput('sess-3', 'data');
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('getActiveTerminalSessionCount / getActiveTerminalSessionIds', () => {
    it('returns zero when no sessions exist', () => {
      expect(getActiveTerminalSessionCount()).toBe(0);
      expect(getActiveTerminalSessionIds()).toEqual([]);
    });
  });

  describe('getActiveTerminalSession', () => {
    it('returns undefined for a non-existent session', () => {
      expect(getActiveTerminalSession('no-such-id')).toBeUndefined();
    });
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

    it('rejects connection when ticket session type does not match', async () => {
      vi.mocked(consumeWsTicket).mockResolvedValue({
        ok: true,
        sessionId: SESSION_ID,
        sessionType: 'desktop', // wrong type
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

    it('rejects connection when user is inactive', async () => {
      const userId = 'user-inactive';
      vi.mocked(consumeWsTicket).mockResolvedValue({
        ok: true,
        sessionId: SESSION_ID,
        sessionType: 'terminal',
        userId,
        expiresAt: Date.now() + 60_000
      });

      vi.mocked(db.select).mockReturnValueOnce(
        mockSelectChain([{ id: userId, status: 'disabled' }])
      );

      const handlers = captureWsHandlers(SESSION_ID, 'ticket-inactive-user');
      const ws = wsMock();

      await handlers.onOpen({}, ws);

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"AUTH_FAILED"')
      );
      expect(ws.close).toHaveBeenCalledWith(4001, 'Authentication failed');
    });

    it('rejects connection when session is not found in database', async () => {
      const userId = 'user-no-session';
      vi.mocked(consumeWsTicket).mockResolvedValue({
        ok: true,
        sessionId: SESSION_ID,
        sessionType: 'terminal',
        userId,
        expiresAt: Date.now() + 60_000
      });

      vi.mocked(db.select)
        .mockReturnValueOnce(mockSelectChain([{ id: userId, status: 'active' }]))
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]) // empty — not found
              })
            })
          })
        } as any);

      const handlers = captureWsHandlers(SESSION_ID, 'ticket-no-session');
      const ws = wsMock();

      await handlers.onOpen({}, ws);

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"AUTH_FAILED"')
      );
      expect(ws.close).toHaveBeenCalledWith(4001, 'Authentication failed');
    });

    it('rejects connection when device is offline', async () => {
      const userId = 'user-offline-dev';
      vi.mocked(consumeWsTicket).mockResolvedValue({
        ok: true,
        sessionId: SESSION_ID,
        sessionType: 'terminal',
        userId,
        expiresAt: Date.now() + 60_000
      });

      const user = { id: userId, status: 'active' };
      const session = { id: SESSION_ID, type: 'terminal', userId, status: 'pending', deviceId: DEVICE_ID };
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

    it('rejects connection when agent is not connected', async () => {
      const userId = 'user-agent-off';
      vi.mocked(consumeWsTicket).mockResolvedValue({
        ok: true,
        sessionId: SESSION_ID,
        sessionType: 'terminal',
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

      vi.mocked(isAgentConnected).mockReturnValue(false);

      const handlers = captureWsHandlers(SESSION_ID, 'ticket-agent-offline');
      const ws = wsMock();

      await handlers.onOpen({}, ws);

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"AGENT_OFFLINE"')
      );
      expect(ws.close).toHaveBeenCalledWith(4002, 'Agent offline');
    });

    it('successfully opens a terminal session', async () => {
      setupSuccessfulValidation();
      vi.mocked(db.update).mockReturnValue(mockUpdateNoReturn() as any);

      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();

      await handlers.onOpen({}, ws);

      // Should send 'connected' message
      const sentCalls = ws.send.mock.calls.map((c: any[]) => c[0]);
      const connectedMsg = sentCalls.find((s: string) => s.includes('"connected"'));
      expect(connectedMsg).toBeDefined();
      const parsed = JSON.parse(connectedMsg);
      expect(parsed.type).toBe('connected');
      expect(parsed.sessionId).toBe(SESSION_ID);
      expect(parsed.device.hostname).toBe('test-host');

      // Should update session status to 'active'
      expect(db.update).toHaveBeenCalled();

      // Should send terminal_start command to agent
      expect(sendCommandToAgent).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({
          type: 'terminal_start',
          payload: expect.objectContaining({
            sessionId: SESSION_ID,
            cols: 80,
            rows: 24
          })
        })
      );

      // Session should be active
      expect(getActiveTerminalSession(SESSION_ID)).toBeDefined();
      expect(getActiveTerminalSessionCount()).toBeGreaterThanOrEqual(1);
      expect(getActiveTerminalSessionIds()).toContain(SESSION_ID);
    });

    it('sends AGENT_SEND_FAILED when sendCommandToAgent fails', async () => {
      setupSuccessfulValidation();
      vi.mocked(sendCommandToAgent).mockReturnValue(false);
      vi.mocked(db.update).mockReturnValue(mockUpdateNoReturn() as any);

      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();

      await handlers.onOpen({}, ws);

      const sentCalls = ws.send.mock.calls.map((c: any[]) => c[0]);
      const errorMsg = sentCalls.find((s: string) => typeof s === 'string' && s.includes('"AGENT_SEND_FAILED"'));
      expect(errorMsg).toBeDefined();
    });

    it('uses powershell for windows devices', async () => {
      setupSuccessfulValidation({ osType: 'windows' });
      vi.mocked(db.update).mockReturnValue(mockUpdateNoReturn() as any);

      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();

      await handlers.onOpen({}, ws);

      expect(sendCommandToAgent).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({
          payload: expect.objectContaining({
            shell: 'powershell'
          })
        })
      );
    });

    it('rejects a shared second owner with HTTP 409 before the upgrade middleware runs', async () => {
      setupSuccessfulValidation();
      const upgradeMiddleware = vi.fn(() => new Response(null, { status: 204 }));
      const upgradeWebSocket = vi.fn(() => upgradeMiddleware);
      const sharedLeases = {
        acquire: vi.fn().mockResolvedValue({ ok: false, reason: 'already_owned' }),
      };

      const app = (createTerminalWsRoutes as unknown as (
        upgrade: typeof upgradeWebSocket,
        options: { sharedLeases: typeof sharedLeases }
      ) => ReturnType<typeof createTerminalWsRoutes>)(upgradeWebSocket, { sharedLeases });

      const response = await app.request(`/${SESSION_ID}/ws?ticket=valid-ticket`);

      expect(response.status).toBe(409);
      expect(sharedLeases.acquire).toHaveBeenCalledWith('terminal', SESSION_ID);
      expect(upgradeMiddleware).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(sendCommandToAgent).not.toHaveBeenCalled();
    });

    it('rejects a replacement for a locally held session with 409 before the upgrade, without disturbing the owner', async () => {
      // Establish a real local owner first.
      setupSuccessfulValidation();
      const ownerHandlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ownerWs = wsMock();
      await ownerHandlers.onOpen({}, ownerWs);
      const owner = getActiveTerminalSession(SESSION_ID);
      expect(owner).toBeDefined();

      // A second request for the same session: the shared lease is free (this
      // models the durable owner having been released while local state is
      // still installed), so only the local check can stop it. It must stop it
      // BEFORE the 101 — no replica may rely on a post-upgrade 4009 close.
      const upgradeMiddleware = vi.fn(() => new Response(null, { status: 204 }));
      const upgradeWebSocket = vi.fn(() => upgradeMiddleware);
      const released: unknown[] = [];
      const sharedLeases = {
        acquire: vi.fn().mockResolvedValue({
          ok: true,
          claim: {
            kind: 'terminal',
            sessionId: SESSION_ID,
            connectionId: '99999999-9999-4999-8999-999999999999',
            generation: 9_999,
            instanceId: '88888888-8888-4888-8888-888888888888',
            leaseToken: '77777777-7777-4777-8777-777777777777',
            ownerValue: 'contender',
            safeForwardingUntilMonotonicMs: Number.MAX_SAFE_INTEGER,
          },
        }),
        release: vi.fn(async (claim: unknown) => {
          released.push(claim);
          return true;
        }),
      };

      vi.mocked(sendCommandToAgent).mockClear();
      vi.mocked(db.update).mockClear();

      const app = (createTerminalWsRoutes as unknown as (
        upgrade: typeof upgradeWebSocket,
        options: { sharedLeases: typeof sharedLeases }
      ) => ReturnType<typeof createTerminalWsRoutes>)(upgradeWebSocket, { sharedLeases });

      const response = await app.request(`/${SESSION_ID}/ws?ticket=contender-ticket`);

      expect(response.status).toBe(409);
      expect(upgradeMiddleware).not.toHaveBeenCalled();
      // The loser's speculative claim is given back, not leaked.
      expect(released).toHaveLength(1);
      // The live owner is untouched: not replaced, not stopped, not rewritten.
      expect(getActiveTerminalSession(SESSION_ID)).toBe(owner);
      expect(ownerWs.close).not.toHaveBeenCalled();
      expect(sendCommandToAgent).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });
  });

});
