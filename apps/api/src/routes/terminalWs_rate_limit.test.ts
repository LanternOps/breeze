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
import {
  createTerminalWsRoutes,
  __createTerminalSharedLeasesForTest,
  __resetTerminalWsForTest,
  __TERMINAL_INPUT_LIMITS_FOR_TEST,
} from './terminalWs';

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
  // Every capture gets its own lease manager, but generations are globally
  // monotonic — a replaced generation can never reuse a prior identity.
  const testSharedLeases = __createTerminalSharedLeasesForTest();
  createTerminalWsRoutes(upgradeWebSocket, { sharedLeases: testSharedLeases });
  const fakeContext = {
    req: {
      param: vi.fn((key: string) => (key === 'id' ? sessionId : undefined)),
      query: vi.fn((key: string) => (key === 'ticket' ? ticket : undefined)),
      header: vi.fn(() => undefined),
    },
  };
  return capturedFactory(fakeContext);
}

function setupSuccessfulValidation() {
  const userId = nextUserId();
  vi.mocked(consumeWsTicket).mockResolvedValue({
    ok: true,
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
    // Ownership is now exact: a leftover session from a prior test would
    // legitimately refuse replacement, so start each test from a clean map.
    __resetTerminalWsForTest();
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
    // Ownership is now exact: a leftover session from a prior test would
    // legitimately refuse replacement, so start each test from a clean map.
    __resetTerminalWsForTest();
    vi.clearAllMocks();
    rateLimiterMock.mockReset();
    rateLimiterMock.mockImplementation(async () => ({
      allowed: true,
      remaining: 9,
      resetAt: new Date(Date.now() + 60_000),
    }));
  });

  const dataMsg = (d: string) => ({ data: JSON.stringify({ type: 'data', data: d }) });
  const terminalDataCalls = () =>
    vi.mocked(sendCommandToAgent).mock.calls.filter((c: any[]) => c[1]?.type === 'terminal_data');

  async function openSession() {
    setupSuccessfulValidation();
    const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
    const ws = wsMock();
    await handlers.onOpen({}, ws);
    vi.mocked(sendCommandToAgent).mockClear();
    return { handlers, ws };
  }

  it('does not throttle ordinary typing: 1000 single-key messages in a minute all reach the agent (#7475)', async () => {
    const { handlers, ws } = await openSession();
    for (let i = 0; i < 1000; i += 1) await handlers.onMessage(dataMsg('a'), ws);
    expect(ws.close).not.toHaveBeenCalled();
    expect(terminalDataCalls()).toHaveLength(1000);
  });

  it('a long pasted line is one message and passes (#7475)', async () => {
    const { handlers, ws } = await openSession();
    await handlers.onMessage(dataMsg('x'.repeat(5000)), ws);
    expect(ws.close).not.toHaveBeenCalled();
    expect(terminalDataCalls()).toHaveLength(1);
  });

  it('past the message ceiling it drops input and warns once, without closing the session', async () => {
    const { handlers, ws } = await openSession();
    const limit = __TERMINAL_INPUT_LIMITS_FOR_TEST.maxMessages;
    for (let i = 0; i < limit + 50; i += 1) await handlers.onMessage(dataMsg('a'), ws);

    expect(ws.close).not.toHaveBeenCalled();
    expect(terminalDataCalls()).toHaveLength(limit);
    const warnings = ws.send.mock.calls
      .map((c: any[]) => c[0])
      .filter((m: string) => m.includes('INPUT_RATE_LIMITED'));
    expect(warnings).toHaveLength(1);
  });

  it('past the byte ceiling it drops the oversized input without closing the session', async () => {
    const { handlers, ws } = await openSession();
    const chunk = 'x'.repeat(16_000);
    const n = Math.ceil(__TERMINAL_INPUT_LIMITS_FOR_TEST.maxBytes / chunk.length) + 5;
    for (let i = 0; i < n; i += 1) await handlers.onMessage(dataMsg(chunk), ws);

    expect(ws.close).not.toHaveBeenCalled();
    expect(terminalDataCalls().length).toBeLessThan(n);
    expect(ws.send.mock.calls.some((c: any[]) => String(c[0]).includes('INPUT_RATE_LIMITED'))).toBe(true);
  });

  it('resumes forwarding input once the window slides past the burst', async () => {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      const { handlers, ws } = await openSession();
      const limit = __TERMINAL_INPUT_LIMITS_FOR_TEST.maxMessages;
      for (let i = 0; i < limit + 5; i += 1) await handlers.onMessage(dataMsg('a'), ws);
      vi.mocked(sendCommandToAgent).mockClear();
      offset = 61_000;
      await handlers.onMessage(dataMsg('b'), ws);
      expect(terminalDataCalls()).toHaveLength(1);
      expect(ws.close).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });
});
