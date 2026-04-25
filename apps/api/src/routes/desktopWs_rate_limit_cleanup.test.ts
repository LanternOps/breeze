import { beforeEach, describe, expect, it, vi } from 'vitest';

// -------------------------------------------------------------------
// Mocks
// -------------------------------------------------------------------

const { withSystemDbAccessContextMock } = vi.hoisted(() => ({
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: withSystemDbAccessContextMock,
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
  consumeDesktopConnectCode: vi.fn(),
  createWsTicket: vi.fn(),
  getViewerAccessTokenExpirySeconds: vi.fn(() => 300),
}));

vi.mock('../services/jwt', () => ({
  createViewerAccessToken: vi.fn(),
  verifyViewerAccessToken: vi.fn(),
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
  getIceServers: vi.fn(() => []),
  logSessionAudit: vi.fn(async () => undefined),
}));

vi.mock('../services/clientIp', () => ({
  getTrustedClientIp: vi.fn(() => '127.0.0.1'),
}));

// -------------------------------------------------------------------
// Imports (after mocks)
// -------------------------------------------------------------------
import { db } from '../db';
import { consumeWsTicket } from '../services/remoteSessionAuth';
import { sendCommandToAgent, isAgentConnected } from './agentWs';
import {
  createDesktopWsRoutes,
  isDesktopSessionOwnedByAgent,
} from './desktopWs';

const SESSION_ID = 'session-desktop-rate-001';
const DEVICE_ID = 'device-desk-rate';
const AGENT_ID = 'agent-desk-rate';
const ORG_ID = 'org-desk-rate';

let userIdCounter = 0;
function nextUserId() {
  return `user-desk-rate-${++userIdCounter}`;
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
  // createDesktopWsRoutes mounts routes + the WS upgrade.
  createDesktopWsRoutes(upgradeWebSocket);
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
    sessionType: 'desktop' as const,
    userId,
    expiresAt: Date.now() + 60_000,
  });

  const user = { id: userId, status: 'active' };
  const session = { id: SESSION_ID, type: 'desktop', userId, status: 'pending', deviceId: DEVICE_ID };
  const device = {
    id: DEVICE_ID,
    agentId: AGENT_ID,
    hostname: 'h',
    osType: 'windows',
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

describe('desktopWs — E1 Redis rate limiter for WS connections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimiterMock.mockReset();
    rateLimiterMock.mockImplementation(async () => ({
      allowed: true,
      remaining: 9,
      resetAt: new Date(Date.now() + 60_000),
    }));
    withSystemDbAccessContextMock.mockImplementation(async (fn) => fn());
  });

  it('denies the connection when the limiter returns not-allowed', async () => {
    setupSuccessfulValidation();
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

  it('uses the desktopws:conn:<userId> Redis key', async () => {
    const { userId } = setupSuccessfulValidation();

    const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
    const ws = wsMock();
    await handlers.onOpen({}, ws);

    expect(rateLimiterMock).toHaveBeenCalledWith(
      expect.anything(),
      `desktopws:conn:${userId}`,
      10,
      60
    );
  });
});

describe('desktopWs — E3 onOpen try/catch cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimiterMock.mockReset();
    rateLimiterMock.mockImplementation(async () => ({
      allowed: true,
      remaining: 9,
      resetAt: new Date(Date.now() + 60_000),
    }));
    withSystemDbAccessContextMock.mockImplementation(async (fn) => fn());
  });

  it('removes the active session entry and closes the WS when setup throws after the entry is stored', async () => {
    setupSuccessfulValidation();

    // Force the second withSystemDbAccessContext (the "update to active") to throw.
    // Validation's withSystemDbAccessContext was already consumed inside validateDesktopAccess,
    // so the next call is the status update inside onOpen, which runs AFTER the session
    // entry + frame callback have been registered.
    withSystemDbAccessContextMock
      .mockImplementationOnce(async (fn) => fn()) // validation
      .mockImplementationOnce(async () => {
        throw new Error('simulated DB failure after session stored');
      })
      .mockImplementation(async (fn) => fn()); // "mark failed" cleanup path

    const handlers = captureWsHandlers(SESSION_ID, 'valid-ticket');
    const ws = wsMock();

    await handlers.onOpen({}, ws);

    // Session entry for THIS session must not leak after the thrown error.
    expect(isDesktopSessionOwnedByAgent(SESSION_ID, AGENT_ID)).toBe(false);
    // WS must be closed with internal_error.
    expect(ws.close).toHaveBeenCalled();
    const lastClose = ws.close.mock.calls.at(-1);
    expect(lastClose?.[0]).toBe(1011);
    expect(lastClose?.[1]).toBe('internal_error');
  });
});
