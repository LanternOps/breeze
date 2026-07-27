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
}));

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
import { sendCommandToAgent } from './agentWs';
import {
  createTerminalWsRoutes,
  getActiveTerminalSession,
  handleTerminalOutput,
  __createTerminalSharedLeasesForTest,
  __resetTerminalWsForTest,
} from './terminalWs';

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

const SESSION_ID = 'session-terminal-001';
const DEVICE_ID = 'device-xyz';
const AGENT_ID = 'agent-xyz';

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
      header: vi.fn(() => undefined)
    }
  };

  return capturedFactory(fakeContext);
}

// -------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------

describe('terminalWs — multi-tenant isolation', () => {
  beforeEach(() => {
    // Ownership is now exact: a leftover session from a prior test would
    // legitimately refuse replacement, so start each test from a clean map.
    __resetTerminalWsForTest();
    vi.clearAllMocks();
  });

  it('rejects connection when session belongs to a different user', async () => {
    const ticketUserId = 'user-org-a';

    vi.mocked(consumeWsTicket).mockResolvedValue({
      ok: true,
      sessionId: SESSION_ID,
      sessionType: 'terminal',
      userId: ticketUserId,
      expiresAt: Date.now() + 60_000
    });

    const user = { id: ticketUserId, status: 'active' };
    // Session lookup returns empty because the DB query filters by
    // both sessionId AND userId — mismatch means empty result
    vi.mocked(db.select)
      .mockReturnValueOnce(mockSelectChain([user]))
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]) // no match
            })
          })
        })
      } as any);

    const handlers = captureWsHandlers(SESSION_ID, 'ticket-cross-user');
    const ws = wsMock();

    await handlers.onOpen({}, ws);

    expect(ws.send).toHaveBeenCalledWith(
      expect.stringContaining('"AUTH_FAILED"')
    );
    expect(ws.close).toHaveBeenCalledWith(4001, 'Authentication failed');
  });

  it('rejects connection when ticket userId does not match session userId', async () => {
    const ticketUserId = 'user-attacker';
    const realSessionUserId = 'user-victim';

    vi.mocked(consumeWsTicket).mockResolvedValue({
      ok: true,
      sessionId: SESSION_ID,
      sessionType: 'terminal',
      userId: ticketUserId,
      expiresAt: Date.now() + 60_000
    });

    const user = { id: ticketUserId, status: 'active' };
    const session = {
      id: SESSION_ID,
      type: 'terminal',
      userId: realSessionUserId, // different from ticket user
      status: 'pending',
      deviceId: DEVICE_ID
    };
    const device = {
      id: DEVICE_ID,
      agentId: AGENT_ID,
      hostname: 'test-host',
      osType: 'linux',
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

    const handlers = captureWsHandlers(SESSION_ID, 'ticket-wrong-user');
    const ws = wsMock();

    await handlers.onOpen({}, ws);

    // Should reject because the session's userId does not match the ticket's userId
    expect(ws.send).toHaveBeenCalledWith(
      expect.stringContaining('"AUTH_FAILED"')
    );
    expect(ws.close).toHaveBeenCalledWith(4001, 'Authentication failed');
  });
});

// -------------------------------------------------------------------
// Cross-replica ownership (Wave 4 Task 4, Step 1)
//
// Route maps are module-global, so a second "replica" is modelled by a second
// route instance sharing ONE lease manager — the same thing two API processes
// share in production (Redis) — plus direct manager calls for the identity
// that never reaches a route.
// -------------------------------------------------------------------

const REMOTE_WS_SHARED_LEASE_RENEW_EVERY_MS = 5_000;

function mockUpdateNoReturn() {
  return {
    set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
  } as any;
}

function seedSuccessfulValidation(userId: string) {
  vi.mocked(consumeWsTicket).mockResolvedValue({
    ok: true,
    sessionId: SESSION_ID,
    sessionType: 'terminal',
    userId,
    expiresAt: Date.now() + 60_000,
  } as any);

  const user = { id: userId, status: 'active' };
  const session = {
    id: SESSION_ID,
    type: 'terminal',
    userId,
    status: 'pending',
    deviceId: DEVICE_ID,
  };
  const device = {
    id: DEVICE_ID,
    agentId: AGENT_ID,
    hostname: 'test-host',
    osType: 'linux',
    status: 'online',
    orgId: 'org-test-1',
  };

  vi.mocked(db.select)
    .mockReturnValueOnce(mockSelectChain([user]))
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ session, device }]),
          }),
        }),
      }),
    } as any);
  vi.mocked(db.update).mockReturnValue(mockUpdateNoReturn() as any);
}

/** Capture a handler set for a specific (shared) lease manager. */
function captureWsHandlersOn(sharedLeases: any, ticket: string) {
  let capturedFactory: any;
  const upgradeWebSocket = vi.fn((factory: any) => {
    capturedFactory = factory;
    return (_c: any, _next: any) => {};
  });
  createTerminalWsRoutes(upgradeWebSocket, { sharedLeases });
  return capturedFactory({
    req: {
      param: vi.fn((key: string) => (key === 'id' ? SESSION_ID : undefined)),
      query: vi.fn((key: string) => (key === 'ticket' ? ticket : undefined)),
      header: vi.fn(() => undefined),
    },
  });
}

describe('terminalWs — cross-replica lease ownership', () => {
  beforeEach(() => {
    __resetTerminalWsForTest();
    vi.clearAllMocks();
  });

  it('refuses a second replica an owner while the first holds the lease', async () => {
    const sharedLeases = __createTerminalSharedLeasesForTest();

    seedSuccessfulValidation('user-replica-a');
    const firstHandlers = captureWsHandlersOn(sharedLeases, 'ticket-replica-a');
    const firstWs = wsMock();
    await firstHandlers.onOpen({}, firstWs);

    const owner = getActiveTerminalSession(SESSION_ID);
    expect(owner).toBeDefined();
    expect(firstWs.close).not.toHaveBeenCalled();

    // The identity a second replica would try to take, driven straight at the
    // shared manager — it never gets a claim to install.
    await expect(sharedLeases.acquire('terminal', SESSION_ID)).resolves.toEqual({
      ok: false,
      reason: 'already_owned',
    });

    // And the second route instance, sharing that manager, cannot upgrade or
    // replace the live owner.
    seedSuccessfulValidation('user-replica-b');
    vi.mocked(sendCommandToAgent).mockClear();
    const secondHandlers = captureWsHandlersOn(sharedLeases, 'ticket-replica-b');
    const secondWs = wsMock();
    await secondHandlers.onOpen({}, secondWs);

    expect(secondWs.close).toHaveBeenCalledWith(4009, 'Terminal session unavailable');
    expect(getActiveTerminalSession(SESSION_ID)).toBe(owner);
    expect(sendCommandToAgent).not.toHaveBeenCalled();

    // The loser's socket is inert against the live session.
    await secondHandlers.onMessage(
      { data: JSON.stringify({ type: 'data', data: 'from-loser\n' }) },
      secondWs,
    );
    await secondHandlers.onClose({}, secondWs);
    expect(sendCommandToAgent).not.toHaveBeenCalled();
    expect(getActiveTerminalSession(SESSION_ID)).toBe(owner);
  });

  it('makes every event and callback inert on renewal failure, and admits a new owner only after the lease is gone', async () => {
    vi.useFakeTimers();
    try {
      let redisOwner: string | null = null;
      let generation = 100;
      let renewShouldFail = false;

      const sharedLeases = {
        acquire: async (kind: string, sessionId: string) => {
          if (redisOwner) return { ok: false as const, reason: 'already_owned' as const };
          generation += 1;
          const claim = {
            kind,
            sessionId,
            connectionId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(generation).padStart(12, '0')}`,
            generation,
            instanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            leaseToken: `cccccccc-cccc-4ccc-8ccc-${String(generation).padStart(12, '0')}`,
            ownerValue: `owner-${generation}`,
            safeForwardingUntilMonotonicMs: Number.MAX_SAFE_INTEGER,
          };
          redisOwner = claim.ownerValue;
          return { ok: true as const, claim };
        },
        renew: async (claim: any) => {
          // A partition takes the whole connection down, not one command: a
          // manager whose renew fails while beginClose succeeds is not a state
          // Redis can actually be in.
          if (renewShouldFail) throw new Error('lease renewal failed');
          return claim;
        },
        beginClose: async (claim: any) => {
          if (renewShouldFail) throw new Error('lease unavailable');
          return redisOwner === claim.ownerValue
            ? { ok: true as const, ownership: 'still_owner' as const }
            : { ok: false as const, reason: 'owner_mismatch' as const };
        },
        release: async (claim: any) => {
          if (redisOwner !== claim.ownerValue) return false;
          redisOwner = null;
          return true;
        },
        writeDesktopFinalizationIntent: async () => 'written',
        claimDesktopOrphan: async () => 'claimed',
        releaseDesktopFinalizationIntent: async () => true,
        observeDesktopFinalization: async () => ({
          ownerPresent: false,
          finalizationId: null,
          canonicalPayload: null,
          consistent: true,
        }),
        topology: {} as any,
      };

      seedSuccessfulValidation('user-renewal');
      const handlers = captureWsHandlersOn(sharedLeases, 'ticket-renewal');
      const ws = wsMock();
      await handlers.onOpen({}, ws);
      expect(getActiveTerminalSession(SESSION_ID)).toBeDefined();

      // Simulate this replica losing the lease: renewal starts failing, but the
      // Redis owner value is still present (TTL has NOT expired yet).
      renewShouldFail = true;
      vi.mocked(sendCommandToAgent).mockClear();
      ws.send.mockClear();
      await vi.advanceTimersByTimeAsync(REMOTE_WS_SHARED_LEASE_RENEW_EVERY_MS + 1);

      // Forwarding expired first, so nothing relays either way...
      handleTerminalOutput(SESSION_ID, 'output-after-lease-loss');
      expect(ws.send).not.toHaveBeenCalledWith(expect.stringContaining('output-after-lease-loss'));
      await handlers.onMessage(
        { data: JSON.stringify({ type: 'data', data: 'input-after-lease-loss\n' }) },
        ws,
      );
      expect(sendCommandToAgent).not.toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({ type: 'terminal_data' }),
      );

      // ...this replica failed CLOSED on the stream (the shell dies) but did
      // NOT compare-release a lease it cannot compare. The local entry is gone;
      // the durable owner value survives until its TTL.
      expect(sendCommandToAgent).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({ type: 'terminal_stop' }),
      );
      expect(getActiveTerminalSession(SESSION_ID)).toBeUndefined();
      expect(redisOwner).not.toBeNull();

      // A new owner is refused while that lease still stands.
      await expect(sharedLeases.acquire('terminal', SESSION_ID)).resolves.toEqual({
        ok: false,
        reason: 'already_owned',
      });

      // Only once the lease expires (TTL) can a new owner be admitted.
      redisOwner = null;
      seedSuccessfulValidation('user-renewal-next');
      const nextHandlers = captureWsHandlersOn(sharedLeases, 'ticket-renewal-next');
      const nextWs = wsMock();
      await nextHandlers.onOpen({}, nextWs);
      expect(getActiveTerminalSession(SESSION_ID)).toBeDefined();
      expect(nextWs.close).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('detaches without stopping the agent when the durable owner has moved on', async () => {
    let redisOwner: string | null = null;
    let generation = 200;

    const sharedLeases = {
      acquire: async (kind: string, sessionId: string) => {
        generation += 1;
        const claim = {
          kind,
          sessionId,
          connectionId: `dddddddd-dddd-4ddd-8ddd-${String(generation).padStart(12, '0')}`,
          generation,
          instanceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          leaseToken: `ffffffff-ffff-4fff-8fff-${String(generation).padStart(12, '0')}`,
          ownerValue: `owner-${generation}`,
          safeForwardingUntilMonotonicMs: Number.MAX_SAFE_INTEGER,
        };
        redisOwner = claim.ownerValue;
        return { ok: true as const, claim };
      },
      renew: async (claim: any) => claim,
      beginClose: async (claim: any) => (
        redisOwner === claim.ownerValue
          ? { ok: true as const, ownership: 'still_owner' as const }
          : { ok: false as const, reason: 'owner_mismatch' as const }
      ),
      release: async (claim: any) => {
        if (redisOwner !== claim.ownerValue) return false;
        redisOwner = null;
        return true;
      },
      writeDesktopFinalizationIntent: async () => 'written',
      claimDesktopOrphan: async () => 'claimed',
      releaseDesktopFinalizationIntent: async () => true,
      observeDesktopFinalization: async () => ({
        ownerPresent: false,
        finalizationId: null,
        canonicalPayload: null,
        consistent: true,
      }),
      topology: {} as any,
    };

    seedSuccessfulValidation('user-mismatch');
    const handlers = captureWsHandlersOn(sharedLeases, 'ticket-mismatch');
    const ws = wsMock();
    await handlers.onOpen({}, ws);
    expect(getActiveTerminalSession(SESSION_ID)).toBeDefined();

    // Another replica legitimately took the session over.
    redisOwner = 'owner-from-another-replica';
    vi.mocked(sendCommandToAgent).mockClear();
    vi.mocked(db.update).mockClear();

    await handlers.onClose({}, ws);

    // Stale local state is detached, and nothing else: killing the PTY or
    // writing the row here would tear down the replica that now owns it.
    expect(getActiveTerminalSession(SESSION_ID)).toBeUndefined();
    expect(sendCommandToAgent).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(redisOwner).toBe('owner-from-another-replica');
  });
});
