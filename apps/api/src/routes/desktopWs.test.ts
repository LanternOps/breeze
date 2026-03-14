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
  users: { id: 'users.id', status: 'users.status' }
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

// -------------------------------------------------------------------
// Imports (after mocks)
// -------------------------------------------------------------------
import { db } from '../db';
import { consumeWsTicket, consumeDesktopConnectCode, getViewerAccessTokenExpirySeconds } from '../services/remoteSessionAuth';
import { createAccessToken } from '../services/jwt';
import { sendCommandToAgent, isAgentConnected } from './agentWs';
import {
  handleDesktopFrame,
  registerDesktopFrameCallback,
  unregisterDesktopFrameCallback,
  createDesktopWsRoutes,
  isDesktopSessionOwnedByAgent,
  getActiveDesktopSessionCount
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
      where: vi.fn().mockResolvedValue(undefined)
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

  createDesktopWsRoutes(upgradeWebSocket);

  const fakeContext = {
    req: {
      param: vi.fn((key: string) => (key === 'id' ? sessionId : undefined)),
      query: vi.fn((key: string) => (key === 'ticket' ? ticket : undefined))
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
    sessionId: SESSION_ID,
    sessionType: 'desktop',
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
  });

  // ==========================================
  // Exported utility functions
  // ==========================================

  describe('handleDesktopFrame', () => {
    it('invokes registered callback with frame data', () => {
      const cb = vi.fn();
      registerDesktopFrameCallback('desk-1', cb);

      const frameData = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // JPEG header bytes
      handleDesktopFrame('desk-1', frameData);

      expect(cb).toHaveBeenCalledWith(frameData);
      unregisterDesktopFrameCallback('desk-1');
    });

    it('does nothing when no callback is registered', () => {
      // Should not throw
      handleDesktopFrame('nonexistent', new Uint8Array([1, 2, 3]));
    });
  });

  describe('registerDesktopFrameCallback / unregisterDesktopFrameCallback', () => {
    it('replaces a previously registered callback', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      registerDesktopFrameCallback('desk-2', cb1);
      registerDesktopFrameCallback('desk-2', cb2);

      const data = new Uint8Array([0x01]);
      handleDesktopFrame('desk-2', data);

      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).toHaveBeenCalledWith(data);
      unregisterDesktopFrameCallback('desk-2');
    });

    it('unregisters callback so subsequent frames are dropped', () => {
      const cb = vi.fn();
      registerDesktopFrameCallback('desk-3', cb);
      unregisterDesktopFrameCallback('desk-3');
      handleDesktopFrame('desk-3', new Uint8Array([0x01]));
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('getActiveDesktopSessionCount', () => {
    it('returns zero when no sessions exist', () => {
      expect(getActiveDesktopSessionCount()).toBe(0);
    });
  });

  describe('isDesktopSessionOwnedByAgent', () => {
    it('returns false for non-existent session', () => {
      expect(isDesktopSessionOwnedByAgent('no-such', 'some-agent')).toBe(false);
    });
  });

  // ==========================================
  // POST /connect/exchange (HTTP endpoint)
  // ==========================================

  describe('POST /connect/exchange', () => {
    it('returns 401 when connect code is invalid', async () => {
      vi.mocked(consumeDesktopConnectCode).mockResolvedValue(null);

      const app = buildApp();
      const res = await app.request('/connect/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: SESSION_ID, code: 'bad-code' })
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain('Invalid or expired');
    });

    it('returns 401 when code sessionId does not match', async () => {
      vi.mocked(consumeDesktopConnectCode).mockResolvedValue({
        sessionId: 'other-session',
        userId: 'user-1',
        tokenPayload: { sub: 'user-1', email: 'test@example.com', roleId: 'r1', orgId: 'org-1', partnerId: null, scope: 'organization', mfa: true },
        expiresAt: Date.now() + 60_000
      });

      const app = buildApp();
      const res = await app.request('/connect/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: SESSION_ID, code: 'code-wrong-session' })
      });

      expect(res.status).toBe(401);
    });

    it('returns 401 when session type is not desktop', async () => {
      const userId = 'user-wrong-type';
      vi.mocked(consumeDesktopConnectCode).mockResolvedValue({
        sessionId: SESSION_ID,
        userId,
        tokenPayload: { sub: userId, email: 'test@example.com', roleId: 'r1', orgId: 'org-1', partnerId: null, scope: 'organization', mfa: true },
        expiresAt: Date.now() + 60_000
      });

      vi.mocked(db.select).mockReturnValueOnce(mockSelectChain([{
        id: SESSION_ID,
        userId,
        type: 'terminal',
        status: 'pending'
      }]));

      const app = buildApp();
      const res = await app.request('/connect/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: SESSION_ID, code: 'code-wrong-type' })
      });

      expect(res.status).toBe(401);
    });

    it('returns 400 when session status is not connectable', async () => {
      const userId = 'user-disconnected';
      vi.mocked(consumeDesktopConnectCode).mockResolvedValue({
        sessionId: SESSION_ID,
        userId,
        tokenPayload: { sub: userId, email: 'test@example.com', roleId: 'r1', orgId: 'org-1', partnerId: null, scope: 'organization', mfa: true },
        expiresAt: Date.now() + 60_000
      });

      vi.mocked(db.select).mockReturnValueOnce(mockSelectChain([{
        id: SESSION_ID,
        userId,
        type: 'desktop',
        status: 'disconnected'
      }]));

      const app = buildApp();
      const res = await app.request('/connect/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: SESSION_ID, code: 'code-disconnected' })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('not available');
    });

    it('returns access token on successful exchange', async () => {
      const userId = 'user-success';
      vi.mocked(consumeDesktopConnectCode).mockResolvedValue({
        sessionId: SESSION_ID,
        userId,
        tokenPayload: { sub: userId, email: 'test@example.com', roleId: 'r1', orgId: 'org-1', partnerId: null, scope: 'organization', mfa: true },
        expiresAt: Date.now() + 60_000
      });

      vi.mocked(db.select).mockReturnValueOnce(mockSelectChain([{
        id: SESSION_ID,
        userId,
        type: 'desktop',
        status: 'pending'
      }]));

      vi.mocked(createAccessToken).mockResolvedValue('mock-access-token-xyz');
      vi.mocked(getViewerAccessTokenExpirySeconds).mockReturnValue(900);

      const app = buildApp();
      const res = await app.request('/connect/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: SESSION_ID, code: 'valid-code' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.accessToken).toBe('mock-access-token-xyz');
      expect(body.expiresInSeconds).toBe(900);
    });

    it('returns cached result for duplicate exchange within TTL', async () => {
      const userId = 'user-cache';
      vi.mocked(consumeDesktopConnectCode).mockResolvedValue({
        sessionId: SESSION_ID,
        userId,
        tokenPayload: { sub: userId, email: 'test@example.com', roleId: 'r1', orgId: 'org-1', partnerId: null, scope: 'organization', mfa: true },
        expiresAt: Date.now() + 60_000
      });

      vi.mocked(db.select).mockReturnValueOnce(mockSelectChain([{
        id: SESSION_ID,
        userId,
        type: 'desktop',
        status: 'pending'
      }]));

      vi.mocked(createAccessToken).mockResolvedValue('first-token');
      vi.mocked(getViewerAccessTokenExpirySeconds).mockReturnValue(900);

      const app = buildApp();
      const body = { sessionId: SESSION_ID, code: 'dup-code' };

      // First call
      const res1 = await app.request('/connect/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      expect(res1.status).toBe(200);
      const json1 = await res1.json();
      expect(json1.accessToken).toBe('first-token');

      // Second call — code already consumed, but cache should return same token
      vi.mocked(consumeDesktopConnectCode).mockResolvedValue(null);

      const res2 = await app.request('/connect/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      expect(res2.status).toBe(200);
      const json2 = await res2.json();
      expect(json2.accessToken).toBe('first-token');
    });

    it('validates required fields via Zod', async () => {
      const app = buildApp();

      // Missing sessionId
      const res1 = await app.request('/connect/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'some-code' })
      });
      expect(res1.status).toBe(400);

      // Missing code
      const res2 = await app.request('/connect/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: SESSION_ID })
      });
      expect(res2.status).toBe(400);

      // Empty strings
      const res3 = await app.request('/connect/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: '', code: '' })
      });
      expect(res3.status).toBe(400);
    });
  });

  // ==========================================
  // GET /health (HTTP endpoint)
  // ==========================================

  describe('GET /health', () => {
    it('returns ok', async () => {
      const app = buildApp();
      const res = await app.request('/health', { method: 'GET' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.route).toBe('desktop-ws');
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
      vi.mocked(consumeWsTicket).mockResolvedValue(null);

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
    });
  });

  // ==========================================
  // WebSocket handler — onMessage
  // ==========================================

  describe('onMessage', () => {
    let handlers: any;
    let ws: ReturnType<typeof wsMock>;

    beforeEach(async () => {
      setupSuccessfulValidation();

      handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      ws = wsMock();

      await handlers.onOpen({}, ws);
      ws.send.mockClear();
      vi.mocked(sendCommandToAgent).mockClear();
    });

    it('sends SESSION_NOT_FOUND for messages on non-existent session', async () => {
      const freshHandlers = captureWsHandlers('nonexistent-session', undefined);
      const freshWs = wsMock();

      await freshHandlers.onMessage(
        { data: JSON.stringify({ type: 'ping' }) },
        freshWs
      );

      expect(freshWs.send).toHaveBeenCalledWith(
        expect.stringContaining('"SESSION_NOT_FOUND"')
      );
    });

    it('relays input events to the agent', async () => {
      const event = {
        type: 'mousemove',
        x: 100,
        y: 200
      };

      await handlers.onMessage(
        { data: JSON.stringify({ type: 'input', event }) },
        ws
      );

      expect(sendCommandToAgent).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({
          type: 'desktop_input',
          payload: expect.objectContaining({
            sessionId: SESSION_ID,
            event
          })
        })
      );
    });

    it('relays keyboard input events', async () => {
      const event = {
        type: 'keydown',
        key: 'a',
        code: 'KeyA',
        modifiers: { ctrl: false, alt: false, shift: false, meta: false }
      };

      await handlers.onMessage(
        { data: JSON.stringify({ type: 'input', event }) },
        ws
      );

      expect(sendCommandToAgent).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({
          type: 'desktop_input',
          payload: expect.objectContaining({
            event: expect.objectContaining({ key: 'a', code: 'KeyA' })
          })
        })
      );
    });

    it('relays mouse click events', async () => {
      const event = {
        type: 'mousedown',
        x: 50,
        y: 75,
        button: 0
      };

      await handlers.onMessage(
        { data: JSON.stringify({ type: 'input', event }) },
        ws
      );

      expect(sendCommandToAgent).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({
          type: 'desktop_input'
        })
      );
    });

    it('relays wheel events', async () => {
      const event = {
        type: 'wheel',
        x: 500,
        y: 300,
        deltaY: -120
      };

      await handlers.onMessage(
        { data: JSON.stringify({ type: 'input', event }) },
        ws
      );

      expect(sendCommandToAgent).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({
          type: 'desktop_input',
          payload: expect.objectContaining({
            event: expect.objectContaining({ type: 'wheel', deltaY: -120 })
          })
        })
      );
    });

    it('sends AGENT_DISCONNECTED when agent drops during input', async () => {
      vi.mocked(sendCommandToAgent).mockReturnValue(false);

      await handlers.onMessage(
        { data: JSON.stringify({ type: 'input', event: { type: 'mousemove', x: 1, y: 1 } }) },
        ws
      );

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"AGENT_DISCONNECTED"')
      );
    });

    it('relays config messages to the agent', async () => {
      await handlers.onMessage(
        { data: JSON.stringify({ type: 'config', quality: 80, maxFps: 30 }) },
        ws
      );

      expect(sendCommandToAgent).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({
          type: 'desktop_config',
          payload: expect.objectContaining({
            sessionId: SESSION_ID,
            quality: 80,
            maxFps: 30
          })
        })
      );
    });

    it('relays config with scaleFactor', async () => {
      await handlers.onMessage(
        { data: JSON.stringify({ type: 'config', scaleFactor: 0.5 }) },
        ws
      );

      expect(sendCommandToAgent).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({
          type: 'desktop_config',
          payload: expect.objectContaining({
            scaleFactor: 0.5
          })
        })
      );
    });

    it('sends AGENT_DISCONNECTED when agent drops during config', async () => {
      vi.mocked(sendCommandToAgent).mockReturnValue(false);

      await handlers.onMessage(
        { data: JSON.stringify({ type: 'config', quality: 50 }) },
        ws
      );

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"AGENT_DISCONNECTED"')
      );
    });

    it('responds to client-initiated ping with pong', async () => {
      await handlers.onMessage(
        { data: JSON.stringify({ type: 'ping' }) },
        ws
      );

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"pong"')
      );
    });

    it('handles pong messages by updating lastPongAt', async () => {
      await handlers.onMessage(
        { data: JSON.stringify({ type: 'pong' }) },
        ws
      );

      // Should not send any response — just update internal state
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('silently drops invalid messages (bad schema)', async () => {
      await handlers.onMessage(
        { data: JSON.stringify({ type: 'bogus_type' }) },
        ws
      );

      expect(ws.send).not.toHaveBeenCalled();
    });

    it('sends MESSAGE_ERROR for malformed JSON', async () => {
      await handlers.onMessage(
        { data: '{not json' },
        ws
      );

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"MESSAGE_ERROR"')
      );
    });

    it('handles binary message data via toString()', async () => {
      const buffer = Buffer.from(JSON.stringify({ type: 'ping' }));

      await handlers.onMessage(
        { data: buffer },
        ws
      );

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"pong"')
      );
    });

    it('validates input event fields via Zod (rejects oversized key)', async () => {
      const event = {
        type: 'keydown',
        key: 'a'.repeat(100) // exceeds max(50)
      };

      await handlers.onMessage(
        { data: JSON.stringify({ type: 'input', event }) },
        ws
      );

      // Invalid message is silently dropped
      expect(sendCommandToAgent).not.toHaveBeenCalled();
    });
  });

  // ==========================================
  // WebSocket handler — onClose
  // ==========================================

  describe('onClose', () => {
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

      // Should send desktop_stream_stop to agent
      expect(sendCommandToAgent).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({
          type: 'desktop_stream_stop',
          payload: expect.objectContaining({ sessionId: SESSION_ID })
        })
      );

      // Should update database with disconnected status
      expect(db.update).toHaveBeenCalled();
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

      // Should send stop command to agent
      expect(sendCommandToAgent).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({
          type: 'desktop_stream_stop'
        })
      );

      // Should update database
      expect(db.update).toHaveBeenCalled();
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

      // Make DB update fail during error handler
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockRejectedValue(new Error('DB down'))
        })
      } as any);

      // Should not throw even when DB fails
      await handlers.onError(new Error('ws error'), ws);

      // Session should still be cleaned from memory
      expect(isDesktopSessionOwnedByAgent(SESSION_ID, AGENT_ID)).toBe(false);
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
      expect(typeof upgradeWebSocket.mock.calls[0][0]).toBe('function');
      expect(app).toBeDefined();
    });

    it('registers /health and WS routes', async () => {
      const app = buildApp();
      const res = await app.request('/health', { method: 'GET' });
      expect(res.status).toBe(200);
    });
  });
});
