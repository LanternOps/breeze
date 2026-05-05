import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
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
  },
}));

vi.mock('../services', () => ({
  getRedis: vi.fn(),
  rateLimiter: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((left, right) => ({ left, right })),
}));

import type { Context } from 'hono';
import { createHash } from 'crypto';

import { db } from '../db';
import { getRedis, rateLimiter } from '../services';
import { agentAuthMiddleware, isAgentTokenRotationDue, matchAgentTokenHash, matchRoleScopedAgentTokenHash } from './agentAuth';

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

describe('agentAuthMiddleware - per-org rate limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.mocked(getRedis).mockReturnValue({} as any);
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
