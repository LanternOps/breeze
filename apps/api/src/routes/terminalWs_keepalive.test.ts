import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// Regression coverage for issue #2871: an established, healthy terminal
// session must outlive the 60s mark. The ping loop runs every 30s and closes
// the socket when no liveness signal arrived within PING_INTERVAL_MS +
// PONG_TIMEOUT_MS (40s) — so a session whose pongs are lost dies at exactly
// the second tick (60s). Liveness comes from either leg: a pong answering a
// server ping, or a client-initiated ping (both refresh lastPongAt).

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), update: vi.fn(), insert: vi.fn() },
}));

vi.mock('../db/schema', () => ({
  remoteSessions: { id: 'remoteSessions.id', deviceId: 'remoteSessions.deviceId', status: 'remoteSessions.status' },
  devices: { id: 'devices.id' },
  users: { id: 'users.id', status: 'users.status' },
}));

vi.mock('../services/remoteSessionAuth', () => ({ consumeWsTicket: vi.fn() }));

vi.mock('./agentWs', () => ({
  sendCommandToAgent: vi.fn(() => true),
  isAgentConnected: vi.fn(() => true),
}));

vi.mock('../services/remoteAccessPolicy', () => ({
  checkRemoteAccess: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('../services/redis', () => ({ getRedis: vi.fn(() => ({})) }));

vi.mock('../services/rate-limit', () => ({
  rateLimiter: vi.fn(async () => ({ allowed: true, remaining: 9, resetAt: new Date(Date.now() + 60_000) })),
}));

vi.mock('./remote/helpers', () => ({
  logSessionAudit: vi.fn(async () => undefined),
  getIceServers: vi.fn(() => []),
}));

vi.mock('../services/viewerTokenRevocation', () => ({
  isViewerSessionRevoked: vi.fn().mockResolvedValue(false),
}));

import { db } from '../db';
import { consumeWsTicket } from '../services/remoteSessionAuth';
import { sendCommandToAgent, isAgentConnected } from './agentWs';
import {
  getActiveTerminalSession,
  createTerminalWsRoutes,
  __createTerminalSharedLeasesForTest,
  __resetTerminalWsForTest,
  closeTerminalSession,
} from './terminalWs';

const DEVICE_ID = 'device-xyz';
const AGENT_ID = 'agent-xyz';

function mockSelectChain(result: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(result) }),
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(result) }),
      }),
    }),
  } as any;
}

function mockUpdateNoReturn() {
  return { set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) } as any;
}

function captureWsHandlers(sessionId: string) {
  let capturedFactory: any;
  const upgradeWebSocket = vi.fn((factory: any) => {
    capturedFactory = factory;
    return (_c: any, _next: any) => {};
  });
  const testSharedLeases = __createTerminalSharedLeasesForTest();
  createTerminalWsRoutes(upgradeWebSocket, { sharedLeases: testSharedLeases });
  const fakeContext = {
    req: {
      param: vi.fn((key: string) => (key === 'id' ? sessionId : undefined)),
      query: vi.fn((key: string) => (key === 'ticket' ? 'ticket-xyz' : undefined)),
      header: vi.fn(() => undefined),
    },
  };
  return capturedFactory(fakeContext);
}

async function openLiveSession(sessionId: string) {
  const userId = 'user-1';
  vi.mocked(consumeWsTicket).mockResolvedValue({
    ok: true as const,
    sessionId,
    sessionType: 'terminal' as const,
    userId,
    expiresAt: Date.now() + 60_000,
  });
  const user = { id: userId, status: 'active' };
  const session = { id: sessionId, type: 'terminal', userId, status: 'pending', deviceId: DEVICE_ID };
  const device = { id: DEVICE_ID, agentId: AGENT_ID, hostname: 'h', osType: 'linux', status: 'online', orgId: 'org-1' };

  vi.mocked(db.select)
    .mockReturnValueOnce(mockSelectChain([user]))
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ session, device }]) }),
        }),
      }),
    } as any);
  vi.mocked(isAgentConnected).mockReturnValue(true);
  vi.mocked(sendCommandToAgent).mockReturnValue(true);
  vi.mocked(db.update).mockReturnValue(mockUpdateNoReturn() as any);

  const handlers = captureWsHandlers(sessionId);

  // A ws mock that behaves like a healthy browser: every server ping is
  // answered with a pong routed back through onMessage.
  const ws: any = {
    close: vi.fn(),
    send: vi.fn(),
  };
  ws.send.mockImplementation((raw: string) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'ping') {
        // Answer asynchronously like a real client would.
        queueMicrotask(() => {
          void handlers.onMessage(
            { data: JSON.stringify({ type: 'pong', timestamp: Date.now() }) } as MessageEvent,
            ws,
          );
        });
      }
    } catch {
      /* not JSON */
    }
  });

  await handlers.onOpen({}, ws);
  return { ws, handlers };
}

describe('terminal keepalive — healthy session must outlive 60s (#2871)', () => {
  beforeEach(() => {
    __resetTerminalWsForTest();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('a client that answers every ping keeps the session alive past 5 minutes', async () => {
    const sessionId = 'session-keepalive-1';
    const { ws } = await openLiveSession(sessionId);
    expect(getActiveTerminalSession(sessionId)).toBeDefined();

    // Walk 5 minutes of fake time in 1s steps so intervals, microtasks, and
    // the pong round-trips all interleave realistically.
    for (let s = 0; s < 300; s++) {
      await vi.advanceTimersByTimeAsync(1000);
    }

    expect(ws.close).not.toHaveBeenCalled();
    expect(getActiveTerminalSession(sessionId)).toBeDefined();

    await closeTerminalSession(sessionId);
  });

  it('client-initiated pings alone keep the session alive even when server pings are never answered', async () => {
    // Session-1 failure mode from #2871: the server→browser leg loses frames,
    // so the client never sees a server ping and never pongs. The client's own
    // periodic {type:'ping'} must still count as liveness (the server updates
    // lastPongAt when handling it), so the session survives.
    const sessionId = 'session-keepalive-3';
    const { ws, handlers } = await openLiveSession(sessionId);
    // Server→client frames are dropped: no pong autoresponder.
    ws.send.mockImplementation(() => undefined);

    // Client pings every 20s, mirroring RemoteTerminal's keepalive.
    const clientPing = setInterval(() => {
      void handlers.onMessage(
        { data: JSON.stringify({ type: 'ping' }) } as MessageEvent,
        ws,
      );
    }, 20_000);

    for (let s = 0; s < 180; s++) {
      await vi.advanceTimersByTimeAsync(1000);
    }

    clearInterval(clientPing);
    expect(ws.close).not.toHaveBeenCalled();
    expect(getActiveTerminalSession(sessionId)).toBeDefined();

    await closeTerminalSession(sessionId);
  });

  it('a client that never answers pings is closed with 4008 pong timeout', async () => {
    const sessionId = 'session-keepalive-2';
    const { ws } = await openLiveSession(sessionId);
    // Disable the pong autoresponder.
    ws.send.mockImplementation(() => undefined);

    for (let s = 0; s < 120; s++) {
      await vi.advanceTimersByTimeAsync(1000);
    }

    expect(ws.close).toHaveBeenCalledWith(4008, 'Pong timeout');
  });
});
