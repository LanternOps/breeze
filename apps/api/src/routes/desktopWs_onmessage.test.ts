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

});
