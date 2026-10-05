/**
 * #8050 — agentAuthMiddleware's negative cache for TERMINAL rejections.
 *
 * What is under test is the middleware contract: a repeat of the same rejected
 * (agentId, token) replays the identical status + body with ZERO DB work, while
 * every non-terminal outcome (429, drain, quarantine, parked, cert binding, DB
 * error, success) keeps hitting the DB every time. The cache's own TTL/cap
 * mechanics are proven in agentAuthNegativeCache.test.ts; TTL is re-proven
 * here end to end with fake timers.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
  withDbAccessContext: vi.fn(async (_context: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: {
    id: 'id',
    agentId: 'agentId',
    orgId: 'orgId',
    siteId: 'siteId',
    agentTokenHash: 'agentTokenHash',
    previousTokenHash: 'previousTokenHash',
    previousTokenExpiresAt: 'previousTokenExpiresAt',
    watchdogTokenHash: 'watchdogTokenHash',
    previousWatchdogTokenHash: 'previousWatchdogTokenHash',
    previousWatchdogTokenExpiresAt: 'previousWatchdogTokenExpiresAt',
    status: 'status',
    agentTokenSuspendedAt: 'agentTokenSuspendedAt',
    hostname: 'hostname',
    lastSeenIp: 'lastSeenIp',
  },
  organizations: {
    id: 'organizations.id',
    partnerId: 'organizations.partnerId',
    type: 'organizations.type',
  },
}));

vi.mock('../services', () => ({
  getRedis: vi.fn(),
  rateLimiter: vi.fn(),
}));

vi.mock('../services/agentStorageSessionRateLimit', () => ({
  checkAgentStorageSessionRateLimit: vi.fn(async () => ({ allowed: true })),
}));

vi.mock('../services/auditService', () => ({
  createAuditLogAsync: vi.fn(async () => undefined),
}));

vi.mock('../services/clientIp', () => ({
  rateLimitIpKey: (ip: string) => ip,
  getTrustedClientIp: vi.fn(() => 'unknown'),
}));

vi.mock('../services/tenantStatus', () => ({
  getAgentTenantState: vi.fn(async () => 'active'),
}));

vi.mock('../services/deviceUninstallDrain', () => ({
  isDeviceUninstallDraining: vi.fn(async () => false),
}));

// The binding decision's own semantics live in agentCertificateBinding.test.ts;
// here it only needs to be drivable so a binding failure can be proven uncached.
vi.mock('../services/agentCertificateBinding', () => ({
  readAgentCertificateAssertion: vi.fn(() => ({
    assertionTrusted: false,
    assertedVerified: false,
    assertedSerial: null,
  })),
  enforceAgentCertificateBinding: vi.fn(async () => ({ allowed: true })),
}));

vi.mock('../services/agentOrgRateLimit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/agentOrgRateLimit')>();
  return {
    ...actual,
    resolveOrgRateLimit: vi.fn(async () => 600),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((left, right) => ({ left, right })),
  and: vi.fn((...args) => ({ and: args })),
  isNull: vi.fn((col) => ({ isNull: col })),
}));

import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createHash } from 'crypto';
import { ERROR_CODES } from '@breeze/shared';

import { db, withSystemDbAccessContext } from '../db';
import { getRedis, rateLimiter } from '../services';
import { getAgentTenantState } from '../services/tenantStatus';
import { isDeviceUninstallDraining } from '../services/deviceUninstallDrain';
import { enforceAgentCertificateBinding } from '../services/agentCertificateBinding';
import { agentAuthMiddleware } from './agentAuth';
import {
  AGENT_AUTH_NEGATIVE_CACHE_TTL_MS,
  __resetAgentAuthNegativeCacheForTests,
  agentAuthNegativeCache,
} from './agentAuthNegativeCache';

function sha(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

type TestContext = Context & {
  _getResponse: () => { status: number; body: unknown } | null;
};

const VALID_TOKEN = 'brz_valid_token';
const OTHER_TOKEN = 'brz_other_token';

function buildSelectMock(result: unknown[]) {
  const terminal = {
    where: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue(result),
    }),
  };
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue(terminal),
      ...terminal,
    }),
  } as any);
}

function makeDevice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'device-1',
    agentId: 'agent-1',
    orgId: 'org-1',
    siteId: 'site-1',
    partnerId: 'partner-1',
    agentTokenHash: sha(VALID_TOKEN),
    previousTokenHash: null,
    previousTokenExpiresAt: null,
    watchdogTokenHash: null,
    previousWatchdogTokenHash: null,
    previousWatchdogTokenExpiresAt: null,
    pendingTokenHash: null,
    pendingWatchdogTokenHash: null,
    pendingTokenExpiresAt: null,
    status: 'online',
    agentTokenSuspendedAt: null,
    hostname: 'box-1',
    lastSeenIp: null,
    organizationType: 'customer',
    ...overrides,
  };
}

function createContext(opts: { agentId?: string; token?: string; path?: string } = {}): TestContext {
  const store = new Map<string, unknown>();
  const reqHeaders: Record<string, string> = {};
  if (opts.token) reqHeaders['authorization'] = `Bearer ${opts.token}`;
  let response: { status: number; body: unknown } | null = null;
  return {
    req: {
      header: (name: string) => reqHeaders[name.toLowerCase()],
      param: (_name: string) => opts.agentId ?? 'agent-1',
      path: opts.path ?? '/api/v1/agents/agent-1/heartbeat',
    },
    header: vi.fn(),
    set: (key: string, value: unknown) => store.set(key, value),
    get: (key: string) => store.get(key),
    json: (body: unknown, status?: number) => {
      response = { status: status ?? 200, body };
      return response;
    },
    _getResponse: () => response,
  } as unknown as TestContext;
}

/** Run the middleware and capture the thrown HTTPException's rendered response. */
async function runRejected(opts: { agentId?: string; token?: string; path?: string } = {}) {
  const next = vi.fn();
  let caught: unknown;
  try {
    await agentAuthMiddleware(createContext({ token: VALID_TOKEN, ...opts }), next);
  } catch (err) {
    caught = err;
  }
  expect(next).not.toHaveBeenCalled();
  expect(caught).toBeInstanceOf(HTTPException);
  const exc = caught as HTTPException;
  const res = exc.getResponse();
  return { status: exc.status, message: exc.message, resStatus: res.status, body: await res.text() };
}

async function runAdmitted(opts: { agentId?: string; token?: string; path?: string } = {}) {
  const next = vi.fn().mockResolvedValue(undefined);
  await agentAuthMiddleware(createContext({ token: VALID_TOKEN, ...opts }), next);
  expect(next).toHaveBeenCalledTimes(1);
}

/** DB-touching calls the middleware can make before reaching a decision. */
function dbWork() {
  return {
    select: vi.mocked(db.select).mock.calls.length,
    systemCtx: vi.mocked(withSystemDbAccessContext).mock.calls.length,
    tenant: vi.mocked(getAgentTenantState).mock.calls.length,
    drain: vi.mocked(isDeviceUninstallDraining).mock.calls.length,
    rateLimiter: vi.mocked(rateLimiter).mock.calls.length,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetAgentAuthNegativeCacheForTests();
  vi.mocked(getRedis).mockReturnValue({} as any);
  vi.mocked(getAgentTenantState).mockResolvedValue('active');
  vi.mocked(isDeviceUninstallDraining).mockResolvedValue(false);
  vi.mocked(enforceAgentCertificateBinding).mockResolvedValue({ allowed: true } as any);
  vi.mocked(rateLimiter).mockResolvedValue({
    allowed: true,
    remaining: 100,
    resetAt: new Date(Date.now() + 60_000),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('agentAuthMiddleware negative cache (#8050) — terminal rejections are replayed with zero DB work', () => {
  const terminalCases: Array<{
    name: string;
    rows: () => unknown[];
    setup?: () => void;
    status: number;
  }> = [
    { name: 'no device row', rows: () => [], status: 401 },
    {
      name: 'token suspended',
      rows: () => [makeDevice({ agentTokenSuspendedAt: new Date('2026-01-01T00:00:00Z') })],
      status: 401,
    },
    {
      name: 'token-hash mismatch',
      rows: () => [makeDevice({ agentTokenHash: sha('brz_someone_else') })],
      status: 401,
    },
    {
      name: 're-enrollment required (no token hashes)',
      rows: () => [makeDevice({ agentTokenHash: null, watchdogTokenHash: null })],
      status: 401,
    },
    {
      name: 'decommissioned and not draining',
      rows: () => [makeDevice({ status: 'decommissioned' })],
      status: 403,
    },
    {
      name: 'tenant-state denied',
      rows: () => [makeDevice()],
      setup: () => vi.mocked(getAgentTenantState).mockResolvedValue(null),
      status: 401,
    },
  ];

  for (const tc of terminalCases) {
    it(`${tc.name}: the repeat makes no DB call and returns the same status + body`, async () => {
      buildSelectMock(tc.rows());
      tc.setup?.();

      const first = await runRejected();
      expect(first.status).toBe(tc.status);
      const afterFirst = dbWork();
      expect(afterFirst.select).toBe(1);

      const second = await runRejected();
      expect(second).toEqual(first);
      // Zero work of any kind on the hit path.
      expect(dbWork()).toEqual(afterFirst);
    });
  }

  it('re-enrollment replay keeps the structured RE_ENROLLMENT_REQUIRED body every time', async () => {
    buildSelectMock([makeDevice({ agentTokenHash: null, watchdogTokenHash: null })]);
    for (let i = 0; i < 3; i++) {
      const r = await runRejected();
      expect(r.resStatus).toBe(401);
      expect(JSON.parse(r.body)).toEqual({
        error: 'Re-enrollment required',
        code: ERROR_CODES.RE_ENROLLMENT_REQUIRED,
      });
    }
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
  });

  it('a decommissioned device that IS draining is not cached (drain check runs every time)', async () => {
    buildSelectMock([makeDevice({ status: 'decommissioned' })]);
    vi.mocked(isDeviceUninstallDraining).mockResolvedValue(true);
    // Drain admits heartbeat; a non-allowed path is refused 403 (drain refusal).
    const ctxPath = '/api/v1/agents/agent-1/inventory';
    await agentAuthMiddleware(createContext({ token: VALID_TOKEN, path: ctxPath }), vi.fn());
    await agentAuthMiddleware(createContext({ token: VALID_TOKEN, path: ctxPath }), vi.fn());
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(isDeviceUninstallDraining)).toHaveBeenCalledTimes(2);
    expect(agentAuthNegativeCache.size).toBe(0);
  });
});

describe('agentAuthMiddleware negative cache (#8050) — key isolation', () => {
  it('a cached rejection for one token does not affect a different token for the same agentId', async () => {
    buildSelectMock([makeDevice()]);

    // A forged token for a real agentId is rejected and cached...
    const forged = await runRejected({ token: OTHER_TOKEN });
    expect(forged.status).toBe(401);
    await runRejected({ token: OTHER_TOKEN });
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);

    // ...but the legitimate agent's own token still authenticates.
    await runAdmitted({ token: VALID_TOKEN });
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2);
  });

  it('a cached rejection for one agentId does not affect another agentId with the same token', async () => {
    buildSelectMock([]);
    await runRejected({ agentId: 'agent-gone' });

    buildSelectMock([makeDevice({ agentId: 'agent-1' })]);
    await runAdmitted({ agentId: 'agent-1' });
  });
});

describe('agentAuthMiddleware negative cache (#8050) — non-terminal outcomes are never cached', () => {
  it('a 429 rate-limit refusal is not cached', async () => {
    buildSelectMock([makeDevice()]);
    vi.mocked(rateLimiter).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 30_000),
    });

    const limited = await runRejected();
    expect(limited.status).toBe(429);

    await runAdmitted();
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2);
    expect(agentAuthNegativeCache.size).toBe(0);
  });

  it('a quarantined 403 is not cached (admin approval must take effect at once)', async () => {
    buildSelectMock([makeDevice({ status: 'quarantined' })]);
    expect((await runRejected()).status).toBe(403);
    await runRejected();
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2);
    expect(agentAuthNegativeCache.size).toBe(0);
  });

  it('a tenant drain refusal is not cached', async () => {
    buildSelectMock([makeDevice()]);
    vi.mocked(getAgentTenantState).mockResolvedValue('draining');
    const path = '/api/v1/agents/agent-1/inventory';
    const c1 = createContext({ token: VALID_TOKEN, path });
    await agentAuthMiddleware(c1, vi.fn());
    expect(c1._getResponse()).toEqual({ status: 403, body: { error: 'tenant_offboarding' } });
    await agentAuthMiddleware(createContext({ token: VALID_TOKEN, path }), vi.fn());
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2);
    expect(agentAuthNegativeCache.size).toBe(0);
  });

  it('a parked (pre-assignment) refusal is not cached', async () => {
    buildSelectMock([makeDevice({ organizationType: 'unassigned_pool' })]);
    const path = '/api/v1/agents/agent-1/inventory';
    const c1 = createContext({ token: VALID_TOKEN, path });
    await agentAuthMiddleware(c1, vi.fn());
    expect(c1._getResponse()?.status).toBe(403);
    await agentAuthMiddleware(createContext({ token: VALID_TOKEN, path }), vi.fn());
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2);
    expect(agentAuthNegativeCache.size).toBe(0);
  });

  it('a certificate-binding failure is not cached', async () => {
    buildSelectMock([makeDevice()]);
    vi.mocked(enforceAgentCertificateBinding).mockResolvedValueOnce({ allowed: false } as any);
    expect((await runRejected()).status).toBe(401);
    await runAdmitted();
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2);
    expect(agentAuthNegativeCache.size).toBe(0);
  });

  it('a DB error during the device lookup is not cached', async () => {
    vi.mocked(withSystemDbAccessContext).mockRejectedValueOnce(new Error('pool timeout'));
    await expect(
      agentAuthMiddleware(createContext({ token: VALID_TOKEN }), vi.fn()),
    ).rejects.toThrow('pool timeout');

    buildSelectMock([makeDevice()]);
    await runAdmitted();
    expect(agentAuthNegativeCache.size).toBe(0);
  });

  it('a successful auth is never cached and never blocked', async () => {
    buildSelectMock([makeDevice()]);
    await runAdmitted();
    await runAdmitted();
    await runAdmitted();
    // Every success pays its own lookup — nothing positive is remembered.
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(3);
    expect(agentAuthNegativeCache.size).toBe(0);
  });
});

describe('agentAuthMiddleware negative cache (#8050) — TTL', () => {
  it('a cached rejection expires after the TTL and the next request re-checks the DB', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));

    buildSelectMock([makeDevice()]);
    vi.mocked(getAgentTenantState).mockResolvedValue(null);
    expect((await runRejected()).status).toBe(401);

    vi.advanceTimersByTime(AGENT_AUTH_NEGATIVE_CACHE_TTL_MS - 1);
    await runRejected();
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);

    // Tenant reinstated; once the TTL lapses the agent is admitted again.
    vi.mocked(getAgentTenantState).mockResolvedValue('active');
    vi.advanceTimersByTime(1);
    await runAdmitted();
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2);
  });
});
