import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '22222222-2222-4222-8222-222222222222';
const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const PRINCIPAL_ID = '44444444-4444-4444-8444-444444444444';
const SITE_ID = '55555555-5555-4555-8555-555555555555';
const KEY_ID = '66666666-6666-4666-8666-666666666666';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  accessibleOrgIds: [] as string[],
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  writeAuditEventAsync: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: { select: mocks.select, insert: mocks.insert },
  hasDbAccessContext: () => true,
}));
vi.mock('../../config/env', () => ({}));
vi.mock('../../services/auditEvents', () => ({
  writeAuditEventAsync: mocks.writeAuditEventAsync,
}));
vi.mock('../../services/enrollmentKeySecurity', () => ({
  hashEnrollmentKey: (raw: string) => `hash:${raw}`,
}));
vi.mock('../../services/redis', () => ({
  getRedis: () => ({
    get: mocks.redisGet,
    set: mocks.redisSet,
  }),
}));
vi.mock('../../middleware/partnerApiAuth', () => ({
  partnerApiAuthMiddleware: async (c: any, next: any) => {
    if (c.req.header('X-API-Key') !== 'test-key') return c.json({ error: 'authentication required' }, 401);
    c.set('partnerApiPrincipal', {
      partnerId: PARTNER_ID,
      partnerServicePrincipalId: PRINCIPAL_ID,
      accessibleOrgIds: mocks.accessibleOrgIds,
      scopes: (c.req.header('X-Test-Scopes') ?? '').split(',').filter(Boolean),
    });
    return next();
  },
  requirePartnerApiScope: (...required: string[]) => async (c: any, next: any) => {
    const principal = c.get('partnerApiPrincipal');
    return required.every((scope) => principal.scopes.includes(scope))
      ? next()
      : c.json({ error: 'scope required' }, 403);
  },
}));

import { partnerApiRoutes } from './index';
import { PARTNER_SERVICE_PRINCIPAL_SCOPES } from '../../services/partnerServicePrincipalScopes';

function makeSelectBuilder(result: unknown) {
  const promise = Promise.resolve(result);
  const b: any = {
    from: vi.fn(() => b),
    where: vi.fn(() => b),
    limit: vi.fn(() => promise),
    then: promise.then.bind(promise),
  };
  return b;
}

function makeInsertBuilder(result: unknown) {
  const promise = Promise.resolve(result);
  const b: any = {
    values: vi.fn(() => b),
    returning: vi.fn(() => promise),
    then: promise.then.bind(promise),
  };
  return b;
}

function request(body: object, opts: { scope?: string; apiKey?: string; idempotencyKey?: string } = {}) {
  const { scope = 'enrollment-keys:write', apiKey = 'test-key', idempotencyKey } = opts;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-API-Key': apiKey,
    'X-Test-Scopes': scope,
  };
  if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;
  return app.request('/partner-api/enrollment-keys', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const validBody = {
  orgId: ORG_ID,
  name: 'Test Key',
};

const fakeKey = {
  id: KEY_ID,
  orgId: ORG_ID,
  siteId: null,
  name: 'Test Key',
  key: 'hash:somerawkey',
  maxUsage: 1,
  expiresAt: new Date('2026-08-27T00:00:00.000Z'),
  createdBy: PRINCIPAL_ID,
  createdAt: new Date('2026-07-27T00:00:00.000Z'),
  updatedAt: new Date('2026-07-27T00:00:00.000Z'),
};

let app: Hono;

describe('POST /partner-api/enrollment-keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accessibleOrgIds = [ORG_ID];
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisSet.mockResolvedValue('OK');
    mocks.writeAuditEventAsync.mockResolvedValue(undefined);
    mocks.insert.mockReturnValue(makeInsertBuilder([fakeKey]));
    app = new Hono();
    app.route('/partner-api', partnerApiRoutes);
  });

  it('returns 401 when X-API-Key is missing', async () => {
    const res = await request(validBody, { apiKey: 'bad-key' });
    expect(res.status).toBe(401);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('returns 403 when scope enrollment-keys:write is absent', async () => {
    const res = await request(validBody, { scope: 'organizations:read' });
    expect(res.status).toBe(403);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('returns 403 when orgId is not in accessible org list', async () => {
    mocks.accessibleOrgIds = [OTHER_ORG_ID];
    const res = await request(validBody);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/denied/i);
  });

  it('returns 400 when siteId does not belong to the org', async () => {
    mocks.select.mockReturnValue(makeSelectBuilder([]));
    const res = await request({ ...validBody, siteId: SITE_ID });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/siteId/i);
  });

  it('creates a key and returns 201 with the raw key on first call', async () => {
    const res = await request(validBody);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe(KEY_ID);
    expect(typeof body.key).toBe('string');
    expect(body.key).not.toContain('hash:');
    expect(mocks.insert).toHaveBeenCalledOnce();
    expect(mocks.writeAuditEventAsync).toHaveBeenCalledOnce();
  });

  it('omits the raw key and returns 200 on idempotency replay', async () => {
    const cached = JSON.stringify({ id: KEY_ID, orgId: ORG_ID, name: 'Test Key' });
    mocks.redisGet.mockResolvedValue(cached);

    const res = await request(validBody, { idempotencyKey: 'idem-abc' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.idempotencyReplay).toBe(true);
    expect(body.key).toBeUndefined();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('validates siteId when provided and creates key', async () => {
    mocks.select.mockReturnValue(makeSelectBuilder([{ id: SITE_ID }]));
    const keyWithSite = { ...fakeKey, siteId: SITE_ID };
    mocks.insert.mockReturnValue(makeInsertBuilder([keyWithSite]));

    const res = await request({ ...validBody, siteId: SITE_ID });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.siteId).toBe(SITE_ID);
  });

  it('returns 400 for invalid body (non-uuid orgId)', async () => {
    const res = await request({ ...validBody, orgId: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });

  it('writes audit event with actorType api_key', async () => {
    await request(validBody);
    expect(mocks.writeAuditEventAsync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorType: 'api_key',
        actorId: PRINCIPAL_ID,
        action: 'enrollment_key.create',
      }),
    );
  });
});

describe('PARTNER_SERVICE_PRINCIPAL_SCOPES matches SQL allowlist', () => {
  const SQL_ALLOWLIST = [
    'organizations:read',
    'sites:read',
    'devices:read',
    'inventory:read',
    'configuration:read',
    'scripts:read',
    'backup-configuration:read',
    'custom-fields:read',
    'enrollment-keys:write',
  ];

  it('TS scope array contains exactly the same scopes as the SQL allowlist', () => {
    const tsScopes = [...PARTNER_SERVICE_PRINCIPAL_SCOPES].sort();
    const sqlScopes = [...SQL_ALLOWLIST].sort();
    expect(tsScopes).toEqual(sqlScopes);
  });
});
