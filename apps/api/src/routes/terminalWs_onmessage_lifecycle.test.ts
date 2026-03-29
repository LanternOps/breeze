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
import { sendCommandToAgent, isAgentConnected } from './agentWs';
import {
  handleTerminalOutput,
  registerTerminalOutputCallback,
  unregisterTerminalOutputCallback,
  getActiveTerminalSession,
  createTerminalWsRoutes,
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

  createTerminalWsRoutes(upgradeWebSocket);

  // Simulate the Hono context the factory expects
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
function setupSuccessfulValidation(overrides?: { osType?: string }) {
  const userId = nextUserId();

  const ticketRecord = {
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

// -------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------


describe('terminalWs', () => {
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
      vi.mocked(db.update).mockReturnValue(mockUpdateNoReturn() as any);

      handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      ws = wsMock();

      await handlers.onOpen({}, ws);
      ws.send.mockClear();
    });

    it('sends SESSION_NOT_FOUND for messages on a non-existent session', async () => {
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

    it('relays data messages to the agent', async () => {
      vi.mocked(sendCommandToAgent).mockClear();

      await handlers.onMessage(
        { data: JSON.stringify({ type: 'data', data: 'ls -la\n' }) },
        ws
      );

      expect(sendCommandToAgent).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({
          type: 'terminal_data',
          payload: expect.objectContaining({
            sessionId: SESSION_ID,
            data: 'ls -la\n'
          })
        })
      );
    });

    it('relays resize messages to the agent', async () => {
      vi.mocked(sendCommandToAgent).mockClear();

      await handlers.onMessage(
        { data: JSON.stringify({ type: 'resize', cols: 120, rows: 40 }) },
        ws
      );

      expect(sendCommandToAgent).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({
          type: 'terminal_resize',
          payload: expect.objectContaining({
            sessionId: SESSION_ID,
            cols: 120,
            rows: 40
          })
        })
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

      // Should not throw or send error
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('silently drops invalid messages', async () => {
      await handlers.onMessage(
        { data: JSON.stringify({ type: 'unknown_type', foo: 'bar' }) },
        ws
      );

      // Should not send any response for invalid messages (just logs a warning)
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('sends MESSAGE_ERROR for malformed JSON', async () => {
      await handlers.onMessage(
        { data: 'not valid json{{{' },
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
  });

  // ==========================================
  // WebSocket handler — onClose
  // ==========================================

  describe('onClose', () => {
    it('cleans up session on close and updates database', async () => {
      setupSuccessfulValidation();
      vi.mocked(db.update).mockReturnValue(mockUpdateNoReturn() as any);

      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();

      await handlers.onOpen({}, ws);
      expect(getActiveTerminalSession(SESSION_ID)).toBeDefined();

      vi.mocked(db.update).mockClear();
      vi.mocked(db.update).mockReturnValue(mockUpdateNoReturn() as any);
      vi.mocked(sendCommandToAgent).mockClear();

      await handlers.onClose({}, ws);

      // Session should be removed from active map
      expect(getActiveTerminalSession(SESSION_ID)).toBeUndefined();

      // Should send terminal_stop command to agent
      expect(sendCommandToAgent).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({
          type: 'terminal_stop',
          payload: expect.objectContaining({ sessionId: SESSION_ID })
        })
      );

      // Should update database with disconnected status
      expect(db.update).toHaveBeenCalled();
    });

    it('handles close for non-existent session gracefully', async () => {
      const handlers = captureWsHandlers('never-opened', undefined);
      const ws = wsMock();

      // Should not throw
      await handlers.onClose({}, ws);

      expect(sendCommandToAgent).not.toHaveBeenCalled();
    });
  });

  // ==========================================
  // WebSocket handler — onError
  // ==========================================

  describe('onError', () => {
    it('cleans up session on error and updates database', async () => {
      setupSuccessfulValidation();
      vi.mocked(db.update).mockReturnValue(mockUpdateNoReturn() as any);

      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();

      await handlers.onOpen({}, ws);

      vi.mocked(db.update).mockClear();
      vi.mocked(db.update).mockReturnValue(mockUpdateNoReturn() as any);

      await handlers.onError(new Error('WebSocket error'), ws);

      expect(getActiveTerminalSession(SESSION_ID)).toBeUndefined();
      expect(db.update).toHaveBeenCalled();
    });

    it('handles error for non-existent session gracefully', async () => {
      const handlers = captureWsHandlers('never-opened', undefined);
      const ws = wsMock();

      // Should not throw
      await handlers.onError(new Error('WebSocket error'), ws);
    });

    it('catches database errors during error cleanup', async () => {
      setupSuccessfulValidation();
      vi.mocked(db.update).mockReturnValue(mockUpdateNoReturn() as any);

      const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
      const ws = wsMock();

      await handlers.onOpen({}, ws);

      // Make the DB update fail during error handler
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockRejectedValue(new Error('DB down'))
        })
      } as any);

      // Should not throw even when DB fails
      await handlers.onError(new Error('ws error'), ws);

      // Session should still be cleaned up from in-memory map
      expect(getActiveTerminalSession(SESSION_ID)).toBeUndefined();
    });
  });

  // ==========================================
  // Route creation
  // ==========================================

  describe('createTerminalWsRoutes', () => {
    it('calls upgradeWebSocket with a factory function', () => {
      const upgradeWebSocket = vi.fn(() => (_c: any, _next: any) => {});
      const app = createTerminalWsRoutes(upgradeWebSocket);

      expect(upgradeWebSocket).toHaveBeenCalledTimes(1);
      expect(typeof (upgradeWebSocket.mock.calls[0] as unknown[])[0]).toBe('function');
      expect(app).toBeDefined();
    });
  });

});
