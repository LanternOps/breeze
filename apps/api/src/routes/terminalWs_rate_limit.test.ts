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
    insert: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  remoteSessions: { id: 'remoteSessions.id', deviceId: 'remoteSessions.deviceId', status: 'remoteSessions.status' },
  devices: { id: 'devices.id' },
  users: { id: 'users.id', status: 'users.status' },
  auditLogs: {},
}));

vi.mock('../services/remoteSessionAuth', () => ({
  consumeWsTicket: vi.fn(),
}));

vi.mock('./agentWs', () => ({
  sendCommandToAgent: vi.fn(() => true),
  isAgentConnected: vi.fn(() => true),
}));

vi.mock('../services/remoteAccessPolicy', () => ({
  checkRemoteAccess: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('../services/redis', () => ({
  getRedis: vi.fn(() => ({})),
}));

const { rateLimiterMock } = vi.hoisted(() => ({
  rateLimiterMock: vi.fn(async () => ({
    allowed: true,
    remaining: 9,
    resetAt: new Date(Date.now() + 60_000),
  })),
}));
vi.mock('../services/rate-limit', () => ({
  rateLimiter: rateLimiterMock,
}));

vi.mock('./remote/helpers', () => ({
  logSessionAudit: vi.fn(async () => undefined),
}));

// -------------------------------------------------------------------
// Imports (after mocks)
// -------------------------------------------------------------------
import { db } from '../db';
import { consumeWsTicket } from '../services/remoteSessionAuth';
import { sendCommandToAgent, isAgentConnected } from './agentWs';
import { createTerminalWsRoutes } from './terminalWs';

const SESSION_ID = 'session-term-rate-001';
const DEVICE_ID = 'device-rate';
const AGENT_ID = 'agent-rate';
const ORG_ID = 'org-rate';

let userIdCounter = 0;
function nextUserId() {
  return `user-term-rate-${++userIdCounter}`;
}

function wsMock() {
  return {
    send: vi.fn(),
    close: vi.fn(),
  };
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

function captureWsHandlers(sessionId: string, ticket?: string) {
  let capturedFactory: any;
  const upgradeWebSocket = vi.fn((factory: any) => {
    capturedFactory = factory;
    return (_c: any, _next: any) => {};
  });
  createTerminalWsRoutes(upgradeWebSocket);
  const fakeContext = {
    req: {
      param: vi.fn((key: string) => (key === 'id' ? sessionId : undefined)),
      query: vi.fn((key: string) => (key === 'ticket' ? ticket : undefined)),
    },
  };
  return capturedFactory(fakeContext);
}

function setupSuccessfulValidation() {
  const userId = nextUserId();
  vi.mocked(consumeWsTicket).mockResolvedValue({
    sessionId: SESSION_ID,
    sessionType: 'terminal' as const,
    userId,
    expiresAt: Date.now() + 60_000,
  });

  const user = { id: userId, status: 'active' };
  const session = { id: SESSION_ID, type: 'terminal', userId, status: 'pending', deviceId: DEVICE_ID };
  const device = {
    id: DEVICE_ID,
    agentId: AGENT_ID,
    hostname: 'h',
    osType: 'linux',
    status: 'online',
    orgId: ORG_ID,
  };

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

  return { userId };
}

describe('terminalWs — E1 Redis rate limiter for WS connections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimiterMock.mockReset();
    rateLimiterMock.mockImplementation(async () => ({
      allowed: true,
      remaining: 9,
      resetAt: new Date(Date.now() + 60_000),
    }));
  });

  it('denies the connection when the Redis rate limiter says not allowed (e.g. 11th attempt in 60s)', async () => {
    setupSuccessfulValidation();
    // Simulate the limiter returning "not allowed" — this is the 11th attempt.
    rateLimiterMock.mockImplementationOnce(async () => ({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000),
    }));

    const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
    const ws = wsMock();
    await handlers.onOpen({}, ws);

    const sent = ws.send.mock.calls.map((c: any[]) => c[0]);
    expect(sent.some((m: string) => m.includes('"RATE_LIMITED"'))).toBe(true);
    expect(ws.close).toHaveBeenCalledWith(4029, 'Rate limited');
  });

  it('uses the terminalws:conn:<userId> Redis key', async () => {
    const { userId } = setupSuccessfulValidation();

    const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
    const ws = wsMock();
    await handlers.onOpen({}, ws);

    expect(rateLimiterMock).toHaveBeenCalledWith(
      expect.anything(),
      `terminalws:conn:${userId}`,
      10,
      60
    );
  });
});

describe('terminalWs — E2 per-session input rate limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimiterMock.mockReset();
    rateLimiterMock.mockImplementation(async () => ({
      allowed: true,
      remaining: 9,
      resetAt: new Date(Date.now() + 60_000),
    }));
  });

  it('closes the session with code 1008 after 201 data messages in under 60s', async () => {
    setupSuccessfulValidation();
    const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
    const ws = wsMock();
    await handlers.onOpen({}, ws);

    // 200 should pass, the 201st should trip the limit.
    for (let i = 0; i < 200; i += 1) {
      await handlers.onMessage(
        { data: JSON.stringify({ type: 'data', data: 'a' }) },
        ws
      );
    }
    expect(ws.close).not.toHaveBeenCalled();

    await handlers.onMessage(
      { data: JSON.stringify({ type: 'data', data: 'a' }) },
      ws
    );

    expect(ws.close).toHaveBeenCalledWith(1008, 'input_rate_limited');
  });

  it('trips the 1MB byte-cap well before the message count cap', async () => {
    setupSuccessfulValidation();
    const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
    const ws = wsMock();
    await handlers.onOpen({}, ws);

    // 100 messages of 16KB = ~1.6MB — well over 1MB cap, well under 200 msg cap.
    const big = 'x'.repeat(16_000);
    let closed = false;
    for (let i = 0; i < 100; i += 1) {
      await handlers.onMessage(
        { data: JSON.stringify({ type: 'data', data: big }) },
        ws
      );
      if (ws.close.mock.calls.length > 0) {
        closed = true;
        break;
      }
    }
    expect(closed).toBe(true);
    expect(ws.close).toHaveBeenCalledWith(1008, 'input_rate_limited');
  });
});
