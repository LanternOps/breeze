import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  dbExecute: vi.fn(),
  dbUpdate: vi.fn(),
  eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
  inArray: vi.fn((left: unknown, right: unknown) => ({ left, right })),
  rateLimiter: vi.fn(),
  getRedis: vi.fn(),
  getTrustedClientIpOrUndefined: vi.fn(),
  writeAuditEvent: vi.fn(),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  insideSystemContext: false,
  insidePartnerContext: false,
  systemContextCalls: 0,
  partnerContexts: [] as unknown[],
}));

vi.mock('../db', () => ({
  db: {
    select: mocks.dbSelect,
    execute: mocks.dbExecute,
    update: mocks.dbUpdate,
  },
  runOutsideDbContext: mocks.runOutsideDbContext,
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    mocks.systemContextCalls += 1;
    mocks.insideSystemContext = true;
    try {
      return await fn();
    } finally {
      mocks.insideSystemContext = false;
    }
  }),
  withDbAccessContext: vi.fn(async (context: unknown, fn: () => Promise<unknown>) => {
    expect(mocks.insideSystemContext).toBe(false);
    mocks.partnerContexts.push(context);
    mocks.insidePartnerContext = true;
    try {
      return await fn();
    } finally {
      mocks.insidePartnerContext = false;
    }
  }),
  withResolvedDbAccessContext: vi.fn(async (
    resolve: () => Promise<{ context: unknown; value: unknown }>,
    fn: (value: unknown) => Promise<unknown>,
  ) => {
    expect(mocks.insideSystemContext).toBe(false);
    mocks.insideSystemContext = true;
    const resolved = await resolve();
    mocks.insideSystemContext = false;
    mocks.partnerContexts.push(resolved.context);
    mocks.insidePartnerContext = true;
    try {
      return await fn(resolved.value);
    } finally {
      mocks.insidePartnerContext = false;
    }
  }),
}));

vi.mock('../db/schema', () => ({
  apiKeys: {},
  users: {},
  partnerServicePrincipalKeys: {
    id: 'partnerServicePrincipalKeys.id',
    partnerId: 'partnerServicePrincipalKeys.partnerId',
    partnerServicePrincipalId: 'partnerServicePrincipalKeys.partnerServicePrincipalId',
    keyHash: 'partnerServicePrincipalKeys.keyHash',
    status: 'partnerServicePrincipalKeys.status',
    expiresAt: 'partnerServicePrincipalKeys.expiresAt',
    rateLimit: 'partnerServicePrincipalKeys.rateLimit',
  },
  partnerServicePrincipals: {
    id: 'partnerServicePrincipals.id',
    partnerId: 'partnerServicePrincipals.partnerId',
    name: 'partnerServicePrincipals.name',
    status: 'partnerServicePrincipals.status',
    scopes: 'partnerServicePrincipals.scopes',
    expiresAt: 'partnerServicePrincipals.expiresAt',
    sourceCidrs: 'partnerServicePrincipals.sourceCidrs',
  },
  partners: {
    id: 'partners.id',
    status: 'partners.status',
    deletedAt: 'partners.deletedAt',
  },
  organizations: {
    id: 'organizations.id',
    partnerId: 'organizations.partnerId',
    status: 'organizations.status',
    deletedAt: 'organizations.deletedAt',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...conditions: unknown[]) => ({ conditions })),
  eq: mocks.eq,
  inArray: mocks.inArray,
  isNull: vi.fn((value: unknown) => ({ isNull: value })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
}));

vi.mock('../services', () => ({
  getRedis: mocks.getRedis,
  rateLimiter: mocks.rateLimiter,
}));

vi.mock('../services/clientIp', () => ({
  getTrustedClientIp: vi.fn(() => '203.0.113.10'),
  getTrustedClientIpOrUndefined: mocks.getTrustedClientIpOrUndefined,
}));

vi.mock('../services/auditEvents', () => ({
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
  writeAuditEventAsync: mocks.writeAuditEvent,
}));

import { db, withResolvedDbAccessContext } from '../db';
import { rateLimiter } from '../services';
import {
  partnerApiAuthMiddleware,
  requirePartnerApiScope,
  type PartnerApiPrincipalContext,
} from './partnerApiAuth';
import { partnerExportAuditMiddleware } from '../routes/partnerApi/audit';

const RAW_KEY = `brz_sp_${'A'.repeat(43)}`;
const KEY_ID = '11111111-1111-4111-8111-111111111111';
const PRINCIPAL_ID = '22222222-2222-4222-8222-222222222222';
const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const ORG_1 = '44444444-4444-4444-8444-444444444444';
const ORG_2 = '55555555-5555-4555-8555-555555555555';

type TestContext = Context & { _headers: Record<string, string> };

function createContext(apiKey: string | null = RAW_KEY): TestContext {
  const responseHeaders: Record<string, string> = {};
  const store = new Map<string, unknown>();
  return {
    req: {
      path: '/api/v1/partner-api/organizations',
      method: 'GET',
      header: (name: string) => {
        if (name.toLowerCase() === 'x-api-key') return apiKey;
        if (name.toLowerCase() === 'user-agent') return 'partner-client/1.0';
        return undefined;
      },
    },
    header: (name: string, value: string) => {
      responseHeaders[name] = value;
    },
    set: (key: string, value: unknown) => store.set(key, value),
    get: (key: string) => store.get(key),
    _headers: responseHeaders,
  } as unknown as TestContext;
}

function credential(overrides: Record<string, unknown> = {}) {
  return {
    keyId: KEY_ID,
    keyStatus: 'active',
    keyExpiresAt: null,
    rateLimit: 600,
    partnerServicePrincipalId: PRINCIPAL_ID,
    partnerId: PARTNER_ID,
    name: 'Weavestream export',
    principalStatus: 'active',
    principalExpiresAt: null,
    scopes: ['organizations:read', 'devices:read'],
    sourceCidrs: [],
    partnerStatus: 'active',
    partnerDeletedAt: null,
    ...overrides,
  };
}

function principalContext(
  scopes: PartnerApiPrincipalContext['scopes'],
): PartnerApiPrincipalContext {
  return {
    partnerServicePrincipalId: PRINCIPAL_ID,
    keyId: KEY_ID,
    partnerId: PARTNER_ID,
    name: 'Weavestream export',
    scopes,
    accessibleOrgIds: [ORG_1],
    rateLimit: 600,
  };
}

function credentialSelectResult(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      innerJoin: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue(rows) })),
        })),
      })),
    })),
  };
}

function organizationSelectResult(rows: unknown[]) {
  return {
    from: vi.fn(() => ({ where: vi.fn().mockResolvedValue(rows) })),
  };
}

function mockBootstrap(
  selectedCredential: Record<string, unknown> | null = credential(),
  organizations = [{ id: ORG_1 }, { id: ORG_2 }],
) {
  mocks.dbSelect.mockReturnValueOnce(
    credentialSelectResult(selectedCredential ? [selectedCredential] : []),
  );
  if (selectedCredential) {
    mocks.dbSelect.mockReturnValueOnce(organizationSelectResult(organizations));
  }
}

function mockLastUsedUpdate() {
  const where = vi.fn().mockResolvedValue(undefined);
  mocks.dbUpdate.mockReturnValue({
    set: vi.fn(() => ({ where })),
  });
  return where;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('partnerApiAuthMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dbSelect.mockReset();
    mocks.dbExecute.mockReset();
    mocks.dbUpdate.mockReset();
    mocks.inArray.mockReset();
    mocks.rateLimiter.mockReset();
    mocks.getRedis.mockReset();
    mocks.getTrustedClientIpOrUndefined.mockReset();
    mocks.runOutsideDbContext.mockReset();
    mocks.writeAuditEvent.mockReset();
    mocks.insideSystemContext = false;
    mocks.insidePartnerContext = false;
    mocks.systemContextCalls = 0;
    mocks.partnerContexts = [];
    mocks.getRedis.mockReturnValue({ redis: true });
    mocks.getTrustedClientIpOrUndefined.mockReturnValue('203.0.113.10');
    mocks.runOutsideDbContext.mockImplementation((fn: () => unknown) => fn());
    mocks.writeAuditEvent.mockResolvedValue(undefined);
    mocks.dbExecute.mockResolvedValue([]);
    mocks.rateLimiter.mockResolvedValue({
      allowed: true,
      remaining: 299,
      resetAt: new Date(Date.now() + 60_000),
    });
    mockLastUsedUpdate();
  });

  it('rejects a missing X-API-Key with a stable sanitized error', async () => {
    await expect(partnerApiAuthMiddleware(createContext(null), vi.fn())).rejects.toMatchObject({
      status: 401,
      message: 'Partner API authentication required',
    });
    expect(db.select).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed key', 'brz_sp_short'],
    ['wrong prefix', `brz_${'A'.repeat(43)}`],
  ])('rejects a %s before hashing or lookup', async (_label, rawKey) => {
    await expect(partnerApiAuthMiddleware(createContext(rawKey), vi.fn())).rejects.toMatchObject({
      status: 401,
      message: 'Invalid partner API credentials',
    });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('throttles probes before credential lookup', async () => {
    const resetAt = new Date(Date.now() + 30_000);
    mocks.rateLimiter.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt });

    const context = createContext('brz_sp_short');
    const next = vi.fn();
    await expect(partnerApiAuthMiddleware(context, next)).rejects.toMatchObject({
      status: 429,
      message: 'Too many API key authentication attempts',
    });
    expect(db.select).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(rateLimiter).toHaveBeenCalledWith(
      { redis: true },
      'api_key_probe:203.0.113.10',
      300,
      60,
    );
    expect(context._headers['Retry-After']).toBeDefined();
  });

  it('fails closed when the prelookup Redis limiter rejects', async () => {
    mocks.rateLimiter.mockRejectedValueOnce(new Error('redis unavailable'));
    const next = vi.fn();

    await expect(partnerApiAuthMiddleware(createContext(), next)).rejects.toThrow(
      'redis unavailable',
    );

    expect(db.select).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('hashes a well-formed key and sanitizes an unknown hash failure', async () => {
    mockBootstrap(null);

    await expect(partnerApiAuthMiddleware(createContext(), vi.fn())).rejects.toMatchObject({
      status: 401,
      message: 'Invalid partner API credentials',
    });
    expect(mocks.eq).toHaveBeenCalledWith(
      'partnerServicePrincipalKeys.keyHash',
      createHash('sha256').update(RAW_KEY).digest('hex'),
    );
  });

  it.each([
    ['revoked key', { keyStatus: 'revoked' }],
    ['expired key', { keyExpiresAt: new Date(Date.now() - 1000) }],
    ['disabled principal', { principalStatus: 'disabled' }],
    ['expired principal', { principalExpiresAt: new Date(Date.now() - 1000) }],
    ['inactive partner', { partnerStatus: 'suspended' }],
    ['deleted partner', { partnerDeletedAt: new Date() }],
  ])('sanitizes authentication failure for a %s', async (_label, overrides) => {
    mockBootstrap(credential(overrides));

    await expect(partnerApiAuthMiddleware(createContext(), vi.fn())).rejects.toMatchObject({
      status: 401,
      message: 'Invalid partner API credentials',
    });
    expect(mocks.dbSelect).toHaveBeenCalledTimes(1);
  });

  it('fails closed when source CIDRs are configured but trusted client IP is unavailable', async () => {
    mocks.getTrustedClientIpOrUndefined.mockReturnValue(undefined);
    mockBootstrap(credential({ sourceCidrs: ['203.0.113.0/24'] }));

    await expect(partnerApiAuthMiddleware(createContext(), vi.fn())).rejects.toMatchObject({
      status: 401,
      message: 'Invalid partner API credentials',
    });
  });

  it('rejects a trusted client IP outside configured source CIDRs', async () => {
    mockBootstrap(credential({ sourceCidrs: ['198.51.100.0/24'] }));

    await expect(partnerApiAuthMiddleware(createContext(), vi.fn())).rejects.toMatchObject({
      status: 401,
      message: 'Invalid partner API credentials',
    });
  });

  it('discovers only active, non-deleted organizations under the exact partner RLS context', async () => {
    mockBootstrap();
    const context = createContext();
    const next = vi.fn(async () => {
      expect(mocks.insideSystemContext).toBe(false);
      expect(mocks.insidePartnerContext).toBe(true);
      expect(rateLimiter).toHaveBeenCalledTimes(2);
    });

    await partnerApiAuthMiddleware(context, next);

    expect(next).toHaveBeenCalledOnce();
    expect(mocks.eq).toHaveBeenCalledWith('organizations.status', 'active');
    expect(mocks.inArray).not.toHaveBeenCalledWith(
      'organizations.status',
      expect.arrayContaining(['trial']),
    );
    expect(context.get('partnerApiPrincipal')).toEqual({
      partnerServicePrincipalId: PRINCIPAL_ID,
      keyId: KEY_ID,
      partnerId: PARTNER_ID,
      name: 'Weavestream export',
      scopes: ['organizations:read', 'devices:read'],
      accessibleOrgIds: [ORG_1, ORG_2],
      rateLimit: 600,
    });
    expect(withResolvedDbAccessContext).toHaveBeenCalledOnce();
    expect(mocks.partnerContexts).toEqual([{
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [ORG_1, ORG_2],
      accessiblePartnerIds: [PARTNER_ID],
      currentPartnerId: PARTNER_ID,
      userId: null,
    }]);
  });

  it('closes system/request contexts before Redis, last-used update, and machine-use audit', async () => {
    mockBootstrap();
    const updateWhere = mockLastUsedUpdate();
    let updateInsidePartnerContext: boolean | undefined;
    let auditInsidePartnerContext: boolean | undefined;
    mocks.rateLimiter.mockImplementation(async () => {
      expect(mocks.insideSystemContext).toBe(false);
      return { allowed: true, remaining: 5, resetAt: new Date(Date.now() + 60_000) };
    });
    mocks.runOutsideDbContext.mockImplementation((fn: () => unknown) => {
      updateInsidePartnerContext = mocks.insidePartnerContext;
      return fn();
    });
    mocks.writeAuditEvent.mockImplementation(() => {
      auditInsidePartnerContext = mocks.insidePartnerContext;
    });

    await partnerApiAuthMiddleware(createContext(), vi.fn());

    expect(updateWhere).toHaveBeenCalled();
    expect(updateInsidePartnerContext).toBe(false);
    expect(auditInsidePartnerContext).toBe(false);
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: null,
        actorType: 'api_key',
        actorId: KEY_ID,
        action: 'partner_api.request',
        resourceType: 'partner_service_principal',
        resourceId: PRINCIPAL_ID,
        result: 'success',
        details: expect.objectContaining({
          principalType: 'partner_service_principal',
          partnerId: PARTNER_ID,
          keyId: KEY_ID,
          status: 200,
        }),
      }),
    );
    const auditJson = JSON.stringify(mocks.writeAuditEvent.mock.calls);
    expect(auditJson).not.toContain(RAW_KEY);
    expect(auditJson).not.toContain(createHash('sha256').update(RAW_KEY).digest('hex'));
  });

  it('writes exactly one managed export audit after the partner context closes', async () => {
    mockBootstrap();
    let auditInsidePartnerContext: boolean | undefined;
    mocks.writeAuditEvent.mockImplementation(() => {
      auditInsidePartnerContext = mocks.insidePartnerContext;
    });
    const app = new Hono();
    app.use('*', partnerExportAuditMiddleware);
    app.use('*', partnerApiAuthMiddleware);
    app.get('/api/v1/partner-api/organizations', (c) => c.json({
      schemaVersion: '1',
      snapshotAt: '2026-07-14T12:00:00.000Z',
      data: [],
      nextCursor: null,
      hasMore: false,
    }));

    const response = await app.request('/api/v1/partner-api/organizations', {
      headers: { 'X-API-Key': RAW_KEY },
    });

    expect(response.status).toBe(200);
    expect(auditInsidePartnerContext).toBe(false);
    expect(mocks.writeAuditEvent).toHaveBeenCalledTimes(1);
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'partner_api.export',
        result: 'success',
        details: expect.objectContaining({
          resource: 'organizations',
          recordCount: 0,
          httpStatus: 200,
        }),
      }),
    );
  });

  it.each([
    ['unsupported GET', 'GET', '/api/v1/partner-api/not-a-resource?cursor=must-not-enter-audit'],
    ['unsupported method', 'POST', '/api/v1/partner-api/organizations?cursor=must-not-enter-audit'],
    ['trailing path', 'GET', '/api/v1/partner-api/organizations/?cursor=must-not-enter-audit'],
    ['nested repeated prefix', 'GET', '/api/v1/partner-api/foo/partner-api/sites?cursor=must-not-enter-audit'],
    ['double slash', 'GET', '/api/v1/partner-api//sites?cursor=must-not-enter-audit'],
    ['encoded slash', 'GET', '/api/v1/partner-api/%2Fsites?cursor=must-not-enter-audit'],
    ['alternate prefix', 'GET', '/partner-api/sites?cursor=must-not-enter-audit'],
  ] as const)('preserves exactly one bounded legacy audit for an authenticated %s', async (_label, method, path) => {
    mockBootstrap();
    const app = new Hono();
    app.use('*', partnerExportAuditMiddleware);
    app.use('*', partnerApiAuthMiddleware);

    const response = await app.request(path, {
      method,
      headers: { 'X-API-Key': RAW_KEY },
    });

    expect(response.status).toBe(404);
    expect(mocks.writeAuditEvent).toHaveBeenCalledTimes(1);
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'partner_api.request',
        result: 'failure',
        details: expect.objectContaining({
          method,
          path: path.split('?')[0],
          status: 404,
        }),
      }),
    );
    const auditJson = JSON.stringify(mocks.writeAuditEvent.mock.calls);
    expect(auditJson).not.toContain('partner_api.export');
    expect(auditJson).not.toContain('must-not-enter-audit');
    expect(auditJson).not.toContain(RAW_KEY);
    expect(auditJson).not.toContain(createHash('sha256').update(RAW_KEY).digest('hex'));
  });

  it('awaits both last-used and audit completion after the held request context closes', async () => {
    mockBootstrap();
    const update = deferred<void>();
    const audit = deferred<void>();
    const updateWhere = vi.fn(() => update.promise);
    mocks.dbUpdate.mockReturnValue({
      set: vi.fn(() => ({ where: updateWhere })),
    });
    mocks.writeAuditEvent.mockReturnValue(audit.promise);
    let settled = false;

    const middleware = partnerApiAuthMiddleware(createContext(), vi.fn()).then(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(updateWhere).toHaveBeenCalledOnce();
      expect(mocks.writeAuditEvent).toHaveBeenCalledOnce();
    });
    expect(settled).toBe(false);

    update.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    audit.resolve();
    await middleware;
    expect(settled).toBe(true);
  });

  it('audits an explicit downstream error response as failure without replacing it', async () => {
    mockBootstrap();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.writeAuditEvent.mockImplementation(() => {
      throw new Error('audit secret detail');
    });
    const app = new Hono();
    app.use('*', partnerApiAuthMiddleware);
    app.get('/explicit-error', (c) => c.json({ error: 'unprocessable' }, 422));

    try {
      const response = await app.request('/explicit-error', {
        headers: { 'X-API-Key': RAW_KEY },
      });

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: 'unprocessable' });
      expect(mocks.writeAuditEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          result: 'failure',
          details: expect.objectContaining({ status: 422 }),
        }),
      );
      expect(consoleError).toHaveBeenCalledWith(
        'Failed to write partner API machine-use audit',
      );
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain('audit secret detail');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('preserves a downstream thrown error response when bookkeeping fails', async () => {
    mockBootstrap();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.runOutsideDbContext.mockImplementation(() => {
      throw new Error('bookkeeping secret detail');
    });
    const app = new Hono();
    app.onError((error, c) => c.json(
      { error: error.message },
      error.message === 'downstream boom' ? 503 : 500,
    ));
    app.use('*', partnerApiAuthMiddleware);
    app.get('/throws', () => {
      throw new Error('downstream boom');
    });

    try {
      const response = await app.request('/throws', {
        headers: { 'X-API-Key': RAW_KEY },
      });

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'downstream boom' });
      expect(mocks.writeAuditEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          result: 'failure',
          details: expect.objectContaining({ status: 503 }),
        }),
      );
      expect(consoleError).toHaveBeenCalledWith(
        'Failed to update partner API key usage timestamp',
      );
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain('bookkeeping secret detail');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('audits a direct DB-context rejection as 500 and rethrows only after bookkeeping', async () => {
    mockBootstrap();
    const directError = new Error('database context failed');
    const audit = deferred<void>();
    const context = createContext();
    context.res = new Response(null, { status: 200 });
    vi.mocked(withResolvedDbAccessContext).mockRejectedValueOnce(directError);
    let auditInsidePartnerContext: boolean | undefined;
    mocks.writeAuditEvent.mockImplementation(() => {
      auditInsidePartnerContext = mocks.insidePartnerContext;
      return audit.promise;
    });
    const next = vi.fn();
    let settled = false;

    const outcome = partnerApiAuthMiddleware(context, next).then(
      () => null,
      (error: unknown) => {
        settled = true;
        return error;
      },
    );

    await vi.waitFor(() => expect(mocks.writeAuditEvent).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(next).not.toHaveBeenCalled();
    expect(auditInsidePartnerContext).toBe(false);
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        result: 'failure',
        details: expect.objectContaining({ status: 500 }),
      }),
    );

    audit.resolve();
    expect(await outcome).toBe(directError);
    expect(settled).toBe(true);
  });

  it('uses an explicit direct HTTPException status instead of a stale response status', async () => {
    mockBootstrap();
    const directError = new HTTPException(409, { message: 'context conflict' });
    const context = createContext();
    context.res = new Response(null, { status: 200 });
    vi.mocked(withResolvedDbAccessContext).mockRejectedValueOnce(directError);
    const next = vi.fn();

    await expect(partnerApiAuthMiddleware(context, next)).rejects.toBe(directError);

    expect(next).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        result: 'failure',
        details: expect.objectContaining({ status: 409 }),
      }),
    );
  });

  it('applies a principal-specific rate limit after the system bootstrap closes', async () => {
    mockBootstrap();
    const resetAt = new Date(Date.now() + 30_000);
    mocks.rateLimiter
      .mockResolvedValueOnce({ allowed: true, remaining: 299, resetAt })
      .mockImplementationOnce(async () => {
        expect(mocks.insideSystemContext).toBe(false);
        return { allowed: false, remaining: 0, resetAt };
      });
    const context = createContext();
    const next = vi.fn();

    await expect(partnerApiAuthMiddleware(context, next)).rejects.toMatchObject({
      status: 429,
      message: 'Partner API rate limit exceeded',
    });
    expect(rateLimiter).toHaveBeenNthCalledWith(
      2,
      { redis: true },
      `partner_api_rate:${PRINCIPAL_ID}:${KEY_ID}`,
      600,
      3600,
    );
    expect(withResolvedDbAccessContext).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(context.get('partnerApiPrincipal')).toMatchObject({
      partnerServicePrincipalId: PRINCIPAL_ID,
      keyId: KEY_ID,
      partnerId: PARTNER_ID,
      accessibleOrgIds: [],
    });
  });

  it('fails closed when the principal Redis limiter rejects', async () => {
    mockBootstrap();
    mocks.rateLimiter
      .mockResolvedValueOnce({
        allowed: true,
        remaining: 299,
        resetAt: new Date(Date.now() + 60_000),
      })
      .mockRejectedValueOnce(new Error('principal limiter unavailable'));
    const next = vi.fn();

    await expect(partnerApiAuthMiddleware(createContext(), next)).rejects.toThrow(
      'principal limiter unavailable',
    );

    expect(withResolvedDbAccessContext).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requirePartnerApiScope', () => {
  it('returns a sanitized 401 without partner API authentication', async () => {
    await expect(
      requirePartnerApiScope('organizations:read')(createContext(), vi.fn()),
    ).rejects.toMatchObject({ status: 401, message: 'Partner API authentication required' });
  });

  it('requires every documented scope passed to the middleware', async () => {
    const context = createContext();
    context.set('partnerApiPrincipal', principalContext(['organizations:read']));
    const next = vi.fn();

    await expect(
      requirePartnerApiScope('organizations:read', 'devices:read')(context, next),
    ).rejects.toMatchObject({
      status: 403,
      message: 'Partner API scope required',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('allows an exact-scope match and does not honor unrelated scopes', async () => {
    const context = createContext();
    context.set(
      'partnerApiPrincipal',
      principalContext(['organizations:read', 'devices:read']),
    );
    const next = vi.fn();

    await requirePartnerApiScope('organizations:read', 'devices:read')(context, next);

    expect(next).toHaveBeenCalledOnce();
  });
});
