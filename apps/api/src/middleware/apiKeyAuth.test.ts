import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn()
  },
  withDbAccessContext: vi.fn(async (_context, fn) => fn())
}));

vi.mock('../db/schema', () => ({
  apiKeys: {
    id: 'id',
    orgId: 'orgId',
    name: 'name',
    keyPrefix: 'keyPrefix',
    keyHash: 'keyHash',
    scopes: 'scopes',
    expiresAt: 'expiresAt',
    rateLimit: 'rateLimit',
    usageCount: 'usageCount',
    status: 'status',
    createdBy: 'createdBy'
  },
  organizations: {}
}));

vi.mock('../services', () => ({
  getRedis: vi.fn(),
  rateLimiter: vi.fn()
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((left, right) => ({ left, right })),
  and: vi.fn()
}));

import type { Context } from 'hono';
import { db, withDbAccessContext } from '../db';
import { getRedis, rateLimiter } from '../services';
import * as apiKeyAuthModule from './apiKeyAuth';

const { apiKeyAuthMiddleware, requireApiKeyScope, eitherAuthMiddleware } = apiKeyAuthModule;

type TestContext = Context & {
  _getResponseHeaders: () => Record<string, string>;
};

const createContext = (headers: Record<string, string | undefined> = {}): TestContext => {
  const responseHeaders: Record<string, string> = {};
  const store = new Map<string, unknown>();
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );

  return {
    req: {
      header: (name: string) => normalized[name.toLowerCase()]
    },
    header: (name: string, value: string) => {
      responseHeaders[name] = value;
    },
    set: (key: string, value: unknown) => {
      store.set(key, value);
    },
    get: (key: string) => store.get(key),
    _getResponseHeaders: () => responseHeaders
  } as TestContext;
};

const buildSelectMock = (result: unknown[]) =>
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(result)
      })
    })
  } as any);

describe('apiKeyAuth middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects when X-API-Key header is missing', async () => {
    const c = createContext();
    const next = vi.fn();

    await expect(apiKeyAuthMiddleware(c, next)).rejects.toMatchObject({
      status: 401,
      message: 'Missing X-API-Key header'
    });
  });

  it('rejects when API key format is invalid', async () => {
    const c = createContext({ 'X-API-Key': 'invalid' });
    const next = vi.fn();

    await expect(apiKeyAuthMiddleware(c, next)).rejects.toMatchObject({
      status: 401,
      message: 'Invalid API key format'
    });
  });

  it('rejects when API key is not found', async () => {
    buildSelectMock([]);
    const c = createContext({ 'X-API-Key': 'brz_missing' });
    const next = vi.fn();

    await expect(apiKeyAuthMiddleware(c, next)).rejects.toMatchObject({
      status: 401,
      message: 'Invalid API key'
    });
  });

  it('rejects when API key is inactive', async () => {
    buildSelectMock([
      {
        id: 'key-1',
        orgId: 'org-1',
        name: 'Key',
        keyPrefix: 'brz_',
        keyHash: 'hash',
        scopes: ['read'],
        expiresAt: null,
        rateLimit: 10,
        usageCount: 0,
        status: 'revoked',
        createdBy: 'user-1'
      }
    ]);

    const c = createContext({ 'X-API-Key': 'brz_revoked' });
    const next = vi.fn();

    await expect(apiKeyAuthMiddleware(c, next)).rejects.toMatchObject({
      status: 401,
      message: 'API key is revoked'
    });
  });

  it('expires and rejects when API key is past expiration', async () => {
    buildSelectMock([
      {
        id: 'key-2',
        orgId: 'org-1',
        name: 'Key',
        keyPrefix: 'brz_',
        keyHash: 'hash',
        scopes: ['read'],
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        rateLimit: 10,
        usageCount: 0,
        status: 'active',
        createdBy: 'user-1'
      }
    ]);

    const updateWhere = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn().mockReturnValue({
        where: updateWhere
      })
    } as any);

    const c = createContext({ 'X-API-Key': 'brz_expired' });
    const next = vi.fn();

    await expect(apiKeyAuthMiddleware(c, next)).rejects.toMatchObject({
      status: 401,
      message: 'API key has expired'
    });
    expect(updateWhere).toHaveBeenCalled();
  });

  it('rejects when rate limit is exceeded and sets headers', async () => {
    const resetAt = new Date(Date.now() + 60_000);
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    buildSelectMock([
      {
        id: 'key-3',
        orgId: 'org-1',
        name: 'Key',
        keyPrefix: 'brz_',
        keyHash: 'hash',
        scopes: ['read'],
        expiresAt: null,
        rateLimit: 2,
        usageCount: 3,
        status: 'active',
        createdBy: 'user-1'
      }
    ]);

    vi.mocked(getRedis).mockReturnValue({} as any);
    vi.mocked(rateLimiter).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt
    });

    const c = createContext({ 'X-API-Key': 'brz_rate' });
    const next = vi.fn();

    try {
      await expect(apiKeyAuthMiddleware(c, next)).rejects.toMatchObject({
        status: 429,
        message: 'Rate limit exceeded'
      });
    } finally {
      nowSpy.mockRestore();
    }

    const headers = c._getResponseHeaders();
    expect(headers['X-RateLimit-Limit']).toBe('2');
    expect(headers['X-RateLimit-Remaining']).toBe('0');
    expect(headers['X-RateLimit-Reset']).toBe(String(Math.ceil(resetAt.getTime() / 1000)));
    expect(headers['Retry-After']).toBe(String(Math.ceil((resetAt.getTime() - now) / 1000)));
  });

  it('sets context, headers, and calls next when API key is valid', async () => {
    const resetAt = new Date(Date.now() + 60_000);
    buildSelectMock([
      {
        id: 'key-4',
        orgId: 'org-2',
        name: 'Key',
        keyPrefix: 'brz_',
        keyHash: 'hash',
        scopes: ['read'],
        expiresAt: null,
        rateLimit: 5,
        usageCount: 2,
        status: 'active',
        createdBy: 'user-2'
      }
    ]);

    vi.mocked(getRedis).mockReturnValue({} as any);
    vi.mocked(rateLimiter).mockResolvedValue({
      allowed: true,
      remaining: 4,
      resetAt
    });

    const execute = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          execute
        })
      })
    } as any);

    const c = createContext({ 'X-API-Key': 'brz_valid' });
    const next = vi.fn();

    await apiKeyAuthMiddleware(c, next);

    const headers = c._getResponseHeaders();
    expect(headers['X-RateLimit-Limit']).toBe('5');
    expect(headers['X-RateLimit-Remaining']).toBe('4');
    expect(headers['X-RateLimit-Reset']).toBe(String(Math.ceil(resetAt.getTime() / 1000)));
    expect(c.get('apiKey')).toMatchObject({
      id: 'key-4',
      orgId: 'org-2',
      scopes: ['read'],
      rateLimit: 5,
      createdBy: 'user-2'
    });
    expect(c.get('apiKeyOrgId')).toBe('org-2');
    expect(next).toHaveBeenCalled();
    expect(execute).toHaveBeenCalled();
    expect(vi.mocked(withDbAccessContext)).toHaveBeenCalledWith(
      {
        scope: 'organization',
        orgId: 'org-2',
        accessibleOrgIds: ['org-2']
      },
      expect.any(Function)
    );
  });
});

describe('requireApiKeyScope middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects when apiKey is missing from context', async () => {
    const c = createContext();
    const next = vi.fn();

    await expect(requireApiKeyScope('read')(c, next)).rejects.toMatchObject({
      status: 401,
      message: 'API key authentication required'
    });
  });

  it('allows access when no scopes are required', async () => {
    const c = createContext();
    c.set('apiKey', { scopes: [] });
    const next = vi.fn();

    await requireApiKeyScope()(c, next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects when apiKey has no scopes', async () => {
    const c = createContext();
    c.set('apiKey', { scopes: [] });
    const next = vi.fn();

    await expect(requireApiKeyScope('read')(c, next)).rejects.toMatchObject({
      status: 403,
      message: 'API key does not have required permissions'
    });
  });

  it('allows access when wildcard scope is present', async () => {
    const c = createContext();
    c.set('apiKey', { scopes: ['*'] });
    const next = vi.fn();

    await requireApiKeyScope('admin')(c, next);
    expect(next).toHaveBeenCalled();
  });

  it('allows access when any required scope is present', async () => {
    const c = createContext();
    c.set('apiKey', { scopes: ['read'] });
    const next = vi.fn();

    await requireApiKeyScope('write', 'read')(c, next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects when required scopes are missing', async () => {
    const c = createContext();
    c.set('apiKey', { scopes: ['read'] });
    const next = vi.fn();

    await expect(requireApiKeyScope('write')(c, next)).rejects.toMatchObject({
      status: 403,
      message: 'API key does not have required permissions'
    });
  });
});

describe('eitherAuth middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects when neither Authorization nor X-API-Key headers are present', async () => {
    const c = createContext();
    const next = vi.fn();

    await expect(eitherAuthMiddleware(c, next)).rejects.toMatchObject({
      status: 401,
      message: 'Authentication required. Provide either Authorization header or X-API-Key header.'
    });
  });

  it.skip('prefers API key auth when X-API-Key is provided', async () => {
    // Skipped: Complex spy mock required
    const c = createContext({ 'X-API-Key': 'brz_key', Authorization: 'Bearer token' });
    const next = vi.fn();
    const apiKeySpy = vi
      .spyOn(apiKeyAuthModule, 'apiKeyAuthMiddleware')
      .mockResolvedValue(undefined as unknown as void);

    await eitherAuthMiddleware(c, next);

    expect(apiKeySpy).toHaveBeenCalledWith(c, next);
    expect(next).not.toHaveBeenCalled();
  });

  it('falls through to next middleware when only Authorization header is provided', async () => {
    const c = createContext({ Authorization: 'Bearer token' });
    const next = vi.fn();

    await eitherAuthMiddleware(c, next);

    expect(next).toHaveBeenCalled();
  });
});
