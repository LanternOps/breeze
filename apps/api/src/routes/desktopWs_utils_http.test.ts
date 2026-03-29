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

});
