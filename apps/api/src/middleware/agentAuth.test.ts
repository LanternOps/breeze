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
    agentTokenSuspendedReason: 'agentTokenSuspendedReason',
    hostname: 'hostname',
    lastSeenIp: 'lastSeenIp',
  },
}));

vi.mock('../services', () => ({
  getRedis: vi.fn(),
  rateLimiter: vi.fn(),
}));

vi.mock('../services/auditService', () => ({
  createAuditLogAsync: vi.fn(async () => undefined),
}));

vi.mock('../services/clientIp', () => ({
  getTrustedClientIp: vi.fn(() => 'unknown'),
}));

vi.mock('../services/tenantStatus', () => ({
  isAgentTenantActive: vi.fn(async () => true),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((left, right) => ({ left, right })),
  and: vi.fn((...args) => ({ and: args })),
  isNull: vi.fn((col) => ({ isNull: col })),
}));

import type { Context } from 'hono';
import { createHash } from 'crypto';

import { db } from '../db';
import { getRedis, rateLimiter } from '../services';
import { createAuditLogAsync } from '../services/auditService';
import { getTrustedClientIp } from '../services/clientIp';
import { isAgentTenantActive } from '../services/tenantStatus';
import {
  agentAuthMiddleware,
  isAgentTokenRotationDue,
  matchAgentTokenHash,
  matchRoleScopedAgentTokenHash,
  suspendAgentToken,
} from './agentAuth';

function sha(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

describe('matchAgentTokenHash', () => {
  it('matches the current token hash without rotation requirement', () => {
    const result = matchAgentTokenHash({
      agentTokenHash: sha('brz_current'),
      previousTokenHash: sha('brz_previous'),
      previousTokenExpiresAt: new Date(Date.now() + 60_000),
      tokenHash: sha('brz_current'),
    });

    expect(result).toEqual({ tokenRotationRequired: false });
  });

  it('matches the previous token hash only while the grace window is active', () => {
    const result = matchAgentTokenHash({
      agentTokenHash: sha('brz_current'),
      previousTokenHash: sha('brz_previous'),
      previousTokenExpiresAt: new Date('2026-03-31T18:05:00Z'),
      tokenHash: sha('brz_previous'),
      now: new Date('2026-03-31T18:00:00Z'),
    });

    expect(result).toEqual({ tokenRotationRequired: true });
  });

  it('rejects the previous token once the grace window expires', () => {
    const result = matchAgentTokenHash({
      agentTokenHash: sha('brz_current'),
      previousTokenHash: sha('brz_previous'),
      previousTokenExpiresAt: new Date('2026-03-31T17:59:00Z'),
      tokenHash: sha('brz_previous'),
      now: new Date('2026-03-31T18:00:00Z'),
    });

    expect(result).toBeNull();
  });
});

describe('matchRoleScopedAgentTokenHash', () => {
  it('returns agent role for normal agent tokens', () => {
    const result = matchRoleScopedAgentTokenHash({
      agentTokenHash: sha('brz_agent'),
      previousTokenHash: null,
      previousTokenExpiresAt: null,
      watchdogTokenHash: sha('brz_watchdog'),
      previousWatchdogTokenHash: null,
      previousWatchdogTokenExpiresAt: null,
      tokenHash: sha('brz_agent'),
    });

    expect(result).toEqual({ role: 'agent', tokenRotationRequired: false });
  });

  it('returns watchdog role for watchdog-scoped tokens', () => {
    const result = matchRoleScopedAgentTokenHash({
      agentTokenHash: sha('brz_agent'),
      previousTokenHash: null,
      previousTokenExpiresAt: null,
      watchdogTokenHash: sha('brz_watchdog'),
      previousWatchdogTokenHash: null,
      previousWatchdogTokenExpiresAt: null,
      tokenHash: sha('brz_watchdog'),
    });

    expect(result).toEqual({ role: 'watchdog', tokenRotationRequired: false });
  });
});

describe('isAgentTokenRotationDue', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('requires rotation when the token was never issued with a tracked timestamp', () => {
    expect(isAgentTokenRotationDue(null, new Date('2026-03-31T18:00:00Z'))).toBe(true);
  });

  it('uses the configured max age threshold', () => {
    vi.stubEnv('AGENT_TOKEN_ROTATION_MAX_AGE_DAYS', '7');

    expect(
      isAgentTokenRotationDue(
        new Date('2026-03-20T18:00:00Z'),
        new Date('2026-03-31T18:00:00Z')
      )
    ).toBe(true);

    expect(
      isAgentTokenRotationDue(
        new Date('2026-03-28T18:00:00Z'),
        new Date('2026-03-31T18:00:00Z')
      )
    ).toBe(false);
  });
});

type TestContext = Context & {
  _getResponseHeaders: () => Record<string, string>;
  _getResponse: () => { status: number; body: unknown } | null;
};

const VALID_TOKEN = 'brz_test_token';
const VALID_HASH = sha(VALID_TOKEN);

function buildSelectMock(result: unknown[]) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(result),
      }),
    }),
  } as any);
}

function makeDevice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'device-1',
    agentId: 'agent-1',
    orgId: 'org-1',
    siteId: 'site-1',
    agentTokenHash: VALID_HASH,
    previousTokenHash: null,
    previousTokenExpiresAt: null,
    watchdogTokenHash: null,
    previousWatchdogTokenHash: null,
    previousWatchdogTokenExpiresAt: null,
    status: 'active',
    hostname: 'box-1',
    lastSeenIp: null,
    ...overrides,
  };
}

function createContext(opts: { agentId?: string; token?: string } = {}): TestContext {
  const headers: Record<string, string> = {};
  const store = new Map<string, unknown>();
  const reqHeaders: Record<string, string> = {};
  if (opts.token) {
    reqHeaders['authorization'] = `Bearer ${opts.token}`;
  }

  let response: { status: number; body: unknown } | null = null;

  return {
    req: {
      header: (name: string) => reqHeaders[name.toLowerCase()],
      param: (_name: string) => opts.agentId ?? 'agent-1',
    },
    header: (name: string, value: string) => {
      headers[name] = value;
    },
    set: (key: string, value: unknown) => {
      store.set(key, value);
    },
    get: (key: string) => store.get(key),
    json: (body: unknown, status?: number) => {
      response = { status: status ?? 200, body };
      return response;
    },
    _getResponseHeaders: () => headers,
    _getResponse: () => response,
  } as unknown as TestContext;
}

describe('agentAuthMiddleware - tenant-status gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.mocked(getRedis).mockReturnValue({} as any);
    vi.mocked(isAgentTenantActive).mockResolvedValue(true);
    vi.mocked(rateLimiter).mockResolvedValue({
      allowed: true,
      remaining: 100,
      resetAt: new Date(Date.now() + 60_000),
    });
  });

  it('rejects with an opaque 401 when the device org/partner tenant is not active', async () => {
    buildSelectMock([makeDevice()]);
    vi.mocked(isAgentTenantActive).mockResolvedValue(false);

    const c = createContext({ token: VALID_TOKEN });
    const next = vi.fn();

    await expect(agentAuthMiddleware(c, next)).rejects.toMatchObject({
      status: 401,
      message: 'Invalid agent credentials',
    });
    expect(next).not.toHaveBeenCalled();
    expect(isAgentTenantActive).toHaveBeenCalledWith('org-1');
  });

  it('proceeds to next() when the device tenant is active', async () => {
    buildSelectMock([makeDevice()]);
    vi.mocked(isAgentTenantActive).mockResolvedValue(true);

    const c = createContext({ token: VALID_TOKEN });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(isAgentTenantActive).toHaveBeenCalledWith('org-1');
  });
});

describe('agentAuthMiddleware - per-org rate limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.mocked(getRedis).mockReturnValue({} as any);
    vi.mocked(isAgentTenantActive).mockResolvedValue(true);
  });

  it('returns 429 with org_rate_limit_exceeded body and Retry-After:60 when org limit is exceeded', async () => {
    buildSelectMock([makeDevice()]);

    // Per-agent passes, per-org fails
    vi.mocked(rateLimiter)
      .mockResolvedValueOnce({ allowed: true, remaining: 119, resetAt: new Date(Date.now() + 60_000) })
      .mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + 60_000) });

    const c = createContext({ token: VALID_TOKEN, agentId: 'agent-1' });
    const next = vi.fn();

    const result = await agentAuthMiddleware(c, next);

    // Middleware returned a Response (json call) without invoking next
    expect(next).not.toHaveBeenCalled();
    expect((result as any).status).toBe(429);
    expect((result as any).body).toEqual({ error: 'org_rate_limit_exceeded' });

    const headers = c._getResponseHeaders();
    expect(headers['Retry-After']).toBe('60');

    // Verify the org rate limiter was called with the expected key + default 600/60
    expect(rateLimiter).toHaveBeenNthCalledWith(2, expect.anything(), 'agent_org_rate:org-1', 600, 60);
  });

  it('honors AGENT_ORG_RATE_LIMIT_PER_MIN env override', async () => {
    vi.stubEnv('AGENT_ORG_RATE_LIMIT_PER_MIN', '900');
    buildSelectMock([makeDevice()]);

    vi.mocked(rateLimiter)
      .mockResolvedValueOnce({ allowed: true, remaining: 100, resetAt: new Date(Date.now() + 60_000) })
      .mockResolvedValueOnce({ allowed: true, remaining: 800, resetAt: new Date(Date.now() + 60_000) });

    const c = createContext({ token: VALID_TOKEN });
    const next = vi.fn();

    await agentAuthMiddleware(c, next);

    expect(rateLimiter).toHaveBeenNthCalledWith(2, expect.anything(), 'agent_org_rate:org-1', 900, 60);
  });

  it('triggers per-agent limit independently of per-org (does not increment org bucket)', async () => {
    buildSelectMock([makeDevice()]);

    // Per-agent limit fails — per-org limiter must NOT be called
    vi.mocked(rateLimiter).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 30_000),
    });

    const c = createContext({ token: VALID_TOKEN });
    const next = vi.fn();

    await expect(agentAuthMiddleware(c, next)).rejects.toMatchObject({
      status: 429,
      message: 'Agent rate limit exceeded',
    });

    // Only the per-agent limiter should have been called
    expect(rateLimiter).toHaveBeenCalledTimes(1);
    expect(rateLimiter).toHaveBeenCalledWith(expect.anything(), 'agent_rate:agent-1', 120, 60);
    expect(next).not.toHaveBeenCalled();
  });

  it('passes both limits and proceeds to next() when under both budgets', async () => {
    buildSelectMock([makeDevice()]);

    vi.mocked(rateLimiter)
      .mockResolvedValueOnce({ allowed: true, remaining: 119, resetAt: new Date(Date.now() + 60_000) })
      .mockResolvedValueOnce({ allowed: true, remaining: 599, resetAt: new Date(Date.now() + 60_000) });

    const c = createContext({ token: VALID_TOKEN });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(c._getResponse()).toBeNull();
    expect(rateLimiter).toHaveBeenCalledTimes(2);
    expect(c.get('agent')).toMatchObject({
      deviceId: 'device-1',
      agentId: 'agent-1',
      orgId: 'org-1',
      siteId: 'site-1',
      role: 'agent',
    });
  });

  it('authenticates watchdog-scoped tokens as watchdog role', async () => {
    buildSelectMock([
      makeDevice({
        agentTokenHash: sha('brz_agent_token'),
        watchdogTokenHash: sha('brz_watchdog_token'),
      }),
    ]);

    vi.mocked(rateLimiter)
      .mockResolvedValueOnce({ allowed: true, remaining: 119, resetAt: new Date(Date.now() + 60_000) })
      .mockResolvedValueOnce({ allowed: true, remaining: 599, resetAt: new Date(Date.now() + 60_000) });

    const c = createContext({ token: 'brz_watchdog_token' });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(c.get('agent')).toMatchObject({
      deviceId: 'device-1',
      agentId: 'agent-1',
      orgId: 'org-1',
      siteId: 'site-1',
      role: 'watchdog',
    });
  });
});

// Task 18: agent token auto-suspend (cross-tenant probe defense).
describe('Task 18 — agentAuthMiddleware rejects suspended tokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedis).mockReturnValue({} as any);
  });

  it('returns 401 when the device has agentTokenSuspendedAt set', async () => {
    buildSelectMock([
      makeDevice({ agentTokenSuspendedAt: new Date('2026-05-25T10:00:00Z') }),
    ]);
    // Rate limiter must NOT be consulted — auth gate fails earlier.
    vi.mocked(rateLimiter).mockResolvedValue({
      allowed: true,
      remaining: 119,
      resetAt: new Date(Date.now() + 60_000),
    });

    const c = createContext({ token: VALID_TOKEN });
    const next = vi.fn();

    await expect(agentAuthMiddleware(c, next)).rejects.toMatchObject({
      status: 401,
      message: 'Invalid agent credentials',
    });
    expect(next).not.toHaveBeenCalled();
    // Auth gate fails before rate limiter is touched.
    expect(rateLimiter).not.toHaveBeenCalled();
  });

  it('does NOT leak the suspension reason in the 401 response', async () => {
    buildSelectMock([
      makeDevice({
        agentTokenSuspendedAt: new Date('2026-05-25T10:00:00Z'),
        agentTokenSuspendedReason: 'cross-tenant-probe',
      }),
    ]);

    const c = createContext({ token: VALID_TOKEN });
    const next = vi.fn();

    let thrown: unknown;
    try {
      await agentAuthMiddleware(c, next);
    } catch (err) {
      thrown = err;
    }

    const message = (thrown as { message?: string })?.message ?? '';
    expect(message).not.toContain('cross-tenant-probe');
    expect(message).not.toContain('suspended');
    expect(message).toBe('Invalid agent credentials');
  });

  it('proceeds normally when agentTokenSuspendedAt is null', async () => {
    buildSelectMock([makeDevice({ agentTokenSuspendedAt: null })]);
    vi.mocked(rateLimiter)
      .mockResolvedValueOnce({ allowed: true, remaining: 119, resetAt: new Date(Date.now() + 60_000) })
      .mockResolvedValueOnce({ allowed: true, remaining: 599, resetAt: new Date(Date.now() + 60_000) });

    const c = createContext({ token: VALID_TOKEN });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('Task 18 — suspendAgentToken helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes agentTokenSuspendedAt + reason via UPDATE', async () => {
    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

    await suspendAgentToken('device-1', 'cross-tenant-probe');

    expect(setMock).toHaveBeenCalledTimes(1);
    const arg = setMock.mock.calls[0]?.[0];
    expect(arg).toMatchObject({ agentTokenSuspendedReason: 'cross-tenant-probe' });
    expect(arg.agentTokenSuspendedAt).toBeInstanceOf(Date);
  });

  it('truncates reasons longer than 100 chars to fit the column', async () => {
    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

    const longReason = 'x'.repeat(250);
    await suspendAgentToken('device-1', longReason);

    const arg = setMock.mock.calls[0]?.[0];
    expect(arg.agentTokenSuspendedReason.length).toBe(100);
  });

  it('swallows DB errors so callers never crash', async () => {
    vi.mocked(db.update).mockImplementation(() => {
      throw new Error('connection refused');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      suspendAgentToken('device-1', 'cross-tenant-probe')
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(
      '[agentAuth] suspendAgentToken failed',
      expect.objectContaining({ deviceId: 'device-1' })
    );
    errSpy.mockRestore();
  });
});

// Task 19: per-source-IP rate limit + IP-change audit.
describe('Task 19 — per-source-IP rate limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedis).mockReturnValue({
      set: vi.fn(async () => 'OK'),
    } as any);
    vi.mocked(getTrustedClientIp).mockReturnValue('203.0.113.5');
    // db.update is invoked fire-and-forget for last_seen_ip persistence;
    // mock it so the chain doesn't throw.
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);
  });

  it('rejects with 429 when the per-IP bucket is exhausted (before per-agent and per-org)', async () => {
    buildSelectMock([makeDevice({ lastSeenIp: '203.0.113.5' })]);

    // The first rateLimiter call is the per-IP check — make it fail.
    vi.mocked(rateLimiter).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 45_000),
    });

    const c = createContext({ token: VALID_TOKEN });
    const next = vi.fn();

    await expect(agentAuthMiddleware(c, next)).rejects.toMatchObject({
      status: 429,
      message: 'Agent per-source-IP rate limit exceeded',
    });

    // Only the per-IP limiter should have been called — per-agent + per-org
    // are skipped so the stolen-IP source can't burn the legit budgets.
    expect(rateLimiter).toHaveBeenCalledTimes(1);
    expect(rateLimiter).toHaveBeenCalledWith(
      expect.anything(),
      'agent_rate_ip:device-1:203.0.113.5',
      30,
      60,
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('checks the per-IP bucket BEFORE the per-agent + per-org buckets', async () => {
    buildSelectMock([makeDevice({ lastSeenIp: '203.0.113.5' })]);
    vi.mocked(rateLimiter)
      .mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: new Date(Date.now() + 60_000) })
      .mockResolvedValueOnce({ allowed: true, remaining: 119, resetAt: new Date(Date.now() + 60_000) })
      .mockResolvedValueOnce({ allowed: true, remaining: 599, resetAt: new Date(Date.now() + 60_000) });

    const c = createContext({ token: VALID_TOKEN });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(rateLimiter).toHaveBeenCalledTimes(3);
    expect(rateLimiter).toHaveBeenNthCalledWith(1, expect.anything(), 'agent_rate_ip:device-1:203.0.113.5', 30, 60);
    expect(rateLimiter).toHaveBeenNthCalledWith(2, expect.anything(), 'agent_rate:agent-1', 120, 60);
    expect(rateLimiter).toHaveBeenNthCalledWith(3, expect.anything(), 'agent_org_rate:org-1', 600, 60);
  });

  it('skips the per-IP check entirely when the trusted client IP is unknown', async () => {
    vi.mocked(getTrustedClientIp).mockReturnValue('unknown');
    buildSelectMock([makeDevice()]);
    vi.mocked(rateLimiter)
      .mockResolvedValueOnce({ allowed: true, remaining: 119, resetAt: new Date(Date.now() + 60_000) })
      .mockResolvedValueOnce({ allowed: true, remaining: 599, resetAt: new Date(Date.now() + 60_000) });

    const c = createContext({ token: VALID_TOKEN });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(rateLimiter).toHaveBeenCalledTimes(2);
    expect(rateLimiter).toHaveBeenNthCalledWith(1, expect.anything(), 'agent_rate:agent-1', 120, 60);
    expect(createAuditLogAsync).not.toHaveBeenCalled();
  });
});

describe('Task 19 — agent source-IP change audit', () => {
  let redisMock: { set: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    redisMock = { set: vi.fn(async () => 'OK') };
    vi.mocked(getRedis).mockReturnValue(redisMock as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);
    // Allow all rate limiters in this block.
    vi.mocked(rateLimiter).mockResolvedValue({
      allowed: true,
      remaining: 99,
      resetAt: new Date(Date.now() + 60_000),
    });
  });

  it('does NOT audit when source IP matches lastSeenIp', async () => {
    vi.mocked(getTrustedClientIp).mockReturnValue('203.0.113.1');
    buildSelectMock([makeDevice({ lastSeenIp: '203.0.113.1' })]);

    const c = createContext({ token: VALID_TOKEN });
    await agentAuthMiddleware(c, vi.fn().mockResolvedValue(undefined));

    expect(createAuditLogAsync).not.toHaveBeenCalled();
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it('does NOT audit on first sighting (lastSeenIp is NULL) but still records the IP', async () => {
    vi.mocked(getTrustedClientIp).mockReturnValue('203.0.113.7');
    buildSelectMock([makeDevice({ lastSeenIp: null })]);

    const c = createContext({ token: VALID_TOKEN });
    await agentAuthMiddleware(c, vi.fn().mockResolvedValue(undefined));

    expect(createAuditLogAsync).not.toHaveBeenCalled();
    // last_seen_ip update is fire-and-forget — verify db.update was called.
    expect(db.update).toHaveBeenCalled();
  });

  it('audits ONCE when the IP changes (Redis SET NX returns OK)', async () => {
    vi.mocked(getTrustedClientIp).mockReturnValue('198.51.100.7');
    buildSelectMock([makeDevice({ lastSeenIp: '203.0.113.1' })]);

    const c = createContext({ token: VALID_TOKEN });
    await agentAuthMiddleware(c, vi.fn().mockResolvedValue(undefined));

    expect(redisMock.set).toHaveBeenCalledWith(
      'agent_ip_change:device-1:198.51.100.7',
      '1',
      'EX',
      24 * 60 * 60,
      'NX',
    );
    expect(createAuditLogAsync).toHaveBeenCalledTimes(1);
    expect(createAuditLogAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-1',
        actorType: 'agent',
        actorId: 'device-1',
        action: 'agent.source.ip.changed',
        resourceType: 'device',
        resourceId: 'device-1',
        details: { previousIp: '203.0.113.1', newIp: '198.51.100.7' },
        ipAddress: '198.51.100.7',
        result: 'success',
      }),
    );
  });

  it('dedupes audit events when the same (device, IP) pair is seen again within 24h (Redis SET NX returns null)', async () => {
    vi.mocked(getTrustedClientIp).mockReturnValue('198.51.100.7');
    redisMock.set.mockResolvedValueOnce(null); // dedup HIT — already logged
    buildSelectMock([makeDevice({ lastSeenIp: '203.0.113.1' })]);

    const c = createContext({ token: VALID_TOKEN });
    await agentAuthMiddleware(c, vi.fn().mockResolvedValue(undefined));

    expect(redisMock.set).toHaveBeenCalledTimes(1);
    expect(createAuditLogAsync).not.toHaveBeenCalled();
  });

  it('skips audit silently if Redis dedup write throws', async () => {
    vi.mocked(getTrustedClientIp).mockReturnValue('198.51.100.7');
    redisMock.set.mockRejectedValueOnce(new Error('redis down'));
    buildSelectMock([makeDevice({ lastSeenIp: '203.0.113.1' })]);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const c = createContext({ token: VALID_TOKEN });
    await agentAuthMiddleware(c, vi.fn().mockResolvedValue(undefined));

    expect(createAuditLogAsync).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      '[agentAuth] ip-change dedup lookup failed:',
      expect.anything(),
    );
    errSpy.mockRestore();
  });
});
