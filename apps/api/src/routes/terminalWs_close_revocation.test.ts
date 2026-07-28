import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// -------------------------------------------------------------------
// Mocks — declared before any import that triggers terminalWs's deps.
// -------------------------------------------------------------------

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

// The new mid-session revocation check on the terminal ping loop.
vi.mock('../services/viewerTokenRevocation', () => ({
  isViewerSessionRevoked: vi.fn().mockResolvedValue(false),
}));

import { db } from '../db';
import { consumeWsTicket } from '../services/remoteSessionAuth';
import { sendCommandToAgent, isAgentConnected } from './agentWs';
import { isViewerSessionRevoked } from '../services/viewerTokenRevocation';
import {
  getActiveTerminalSession,
  createTerminalWsRoutes,
  __createTerminalSharedLeasesForTest,
  __resetTerminalWsForTest,
  closeTerminalSession,
} from './terminalWs';

const DEVICE_ID = 'device-xyz';
const AGENT_ID = 'agent-xyz';

let userIdCounter = 0;
let sessionCounter = 0;
const nextUserId = () => `user-term-${++userIdCounter}`;
const nextSessionId = () => `session-term-${++sessionCounter}`;
// Mirrors terminalWs.ts's server-side ping cadence.
const PING_INTERVAL_MS = 30_000;

function wsMock() {
  return { send: vi.fn(), close: vi.fn() };
}

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
  // Every capture gets its own lease manager, but generations are globally
  // monotonic — a replaced generation can never reuse a prior identity.
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

/** Drive a successful onOpen so the session lands in the live in-memory map. */
async function openLiveSession(sessionId: string) {
  const userId = nextUserId();
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

  const ws = wsMock();
  const handlers = captureWsHandlers(sessionId);
  await handlers.onOpen({}, ws);
  return { ws, userId, handlers };
}

describe('closeTerminalSession', () => {
  beforeEach(() => {
    // Ownership is now exact: a leftover session from a prior test would
    // legitimately refuse replacement, so start each test from a clean map.
    __resetTerminalWsForTest();
    vi.clearAllMocks();
  });

  it('returns false and does nothing for an unknown session', async () => {
    await expect(closeTerminalSession('does-not-exist')).resolves.toBe(false);
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });

  it('closes a live socket: sends terminal_stop, closes ws with 4003, drops the map entry, returns true', async () => {
    const sessionId = nextSessionId();
    const { ws } = await openLiveSession(sessionId);
    expect(getActiveTerminalSession(sessionId)).toBeDefined();
    vi.mocked(sendCommandToAgent).mockClear();

    const result = await closeTerminalSession(sessionId);

    expect(result).toBe(true);
    expect(sendCommandToAgent).toHaveBeenCalledWith(AGENT_ID, {
      id: `term-stop-${sessionId}`,
      type: 'terminal_stop',
      payload: { sessionId },
    });
    expect(ws.close).toHaveBeenCalledWith(4003, 'Session revoked');
    // Map entry gone → a subsequent onClose finds nothing and no-ops.
    expect(getActiveTerminalSession(sessionId)).toBeUndefined();
  });
});

describe('terminal ping loop — mid-session revocation', () => {
  beforeEach(() => {
    // Ownership is now exact: a leftover session from a prior test would
    // legitimately refuse replacement, so start each test from a clean map.
    __resetTerminalWsForTest();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('closes the live socket within one ping interval when the viewer session is revoked', async () => {
    const sessionId = nextSessionId();
    const { ws } = await openLiveSession(sessionId);
    expect(getActiveTerminalSession(sessionId)).toBeDefined();

    // Now the session gets revoked mid-stream.
    vi.mocked(isViewerSessionRevoked).mockResolvedValue(true);
    vi.mocked(sendCommandToAgent).mockClear();

    // Advance past one ping interval (30s) and flush the revocation promise.
    await vi.advanceTimersByTimeAsync(30_000);

    expect(isViewerSessionRevoked).toHaveBeenCalledWith(sessionId);
    expect(ws.close).toHaveBeenCalledWith(4003, 'Session revoked');
    expect(getActiveTerminalSession(sessionId)).toBeUndefined();
  });

  it('fails closed: closes the socket when the revocation check itself rejects', async () => {
    const sessionId = nextSessionId();
    const { ws } = await openLiveSession(sessionId);

    vi.mocked(isViewerSessionRevoked).mockRejectedValue(new Error('redis blip'));

    await vi.advanceTimersByTimeAsync(30_000);

    expect(ws.close).toHaveBeenCalledWith(4003, 'Session revoked');
    expect(getActiveTerminalSession(sessionId)).toBeUndefined();
  });

  it('keeps the socket open when the session is not revoked', async () => {
    const sessionId = nextSessionId();
    const { ws } = await openLiveSession(sessionId);

    vi.mocked(isViewerSessionRevoked).mockResolvedValue(false);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(ws.close).not.toHaveBeenCalled();
    expect(getActiveTerminalSession(sessionId)).toBeDefined();
    // Clean up the live session so its interval doesn't leak into other tests.
    await closeTerminalSession(sessionId);
  });

  it('makes a captured timer from an old generation inert after reopen', async () => {
    const sessionId = nextSessionId();
    // Select the PING timer by its interval, not by creation order — the
    // session also installs a lease-renewal timer, and picking index 0 would
    // silently assert against the wrong closure.
    const intervalCallbacks: Array<{ callback: () => void; delay?: number }> = [];
    const realSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delay?: number) => {
      intervalCallbacks.push({ callback, delay });
      return realSetInterval(callback, delay);
    }) as typeof setInterval);

    const { ws: staleWs, handlers: staleHandlers } = await openLiveSession(sessionId);
    const staleTimer = intervalCallbacks.find(entry => entry.delay === PING_INTERVAL_MS)?.callback;
    expect(staleTimer).toBeDefined();
    await staleHandlers.onClose({}, staleWs);

    const { ws: replacementWs } = await openLiveSession(sessionId);
    const replacement = getActiveTerminalSession(sessionId);
    expect(replacement).toBeDefined();

    vi.mocked(isViewerSessionRevoked).mockResolvedValue(true);
    vi.mocked(sendCommandToAgent).mockClear();
    staleWs.send.mockClear();
    staleTimer!();
    await Promise.resolve();
    await Promise.resolve();

    expect(staleWs.send).not.toHaveBeenCalledWith(expect.stringContaining('"ping"'));
    expect(replacementWs.close).not.toHaveBeenCalled();
    expect(sendCommandToAgent).not.toHaveBeenCalled();
    expect(getActiveTerminalSession(sessionId)).toBe(replacement);

    await closeTerminalSession(sessionId);
  });
});
