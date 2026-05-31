import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { thirdPartyCatalogRoutes } from './index';

const mockCatalogTable = vi.hoisted(() => ({
  id: 'thirdPartyPackageCatalog.id',
  source: 'thirdPartyPackageCatalog.source',
  packageId: 'thirdPartyPackageCatalog.packageId',
  vendor: 'thirdPartyPackageCatalog.vendor',
  friendlyName: 'thirdPartyPackageCatalog.friendlyName',
  category: 'thirdPartyPackageCatalog.category',
  defaultSeverity: 'thirdPartyPackageCatalog.defaultSeverity',
  breezeTested: 'thirdPartyPackageCatalog.breezeTested',
  notes: 'thirdPartyPackageCatalog.notes',
  homepageUrl: 'thirdPartyPackageCatalog.homepageUrl',
  osvEcosystem: 'thirdPartyPackageCatalog.osvEcosystem',
  createdAt: 'thirdPartyPackageCatalog.createdAt',
  updatedAt: 'thirdPartyPackageCatalog.updatedAt',
}));

const mockReleaseTestsTable = vi.hoisted(() => ({
  id: 'thirdPartyReleaseTests.id',
  catalogId: 'thirdPartyReleaseTests.catalogId',
  status: 'thirdPartyReleaseTests.status',
}));

const mockEnqueue = vi.hoisted(() => vi.fn());
const mockExecute = vi.hoisted(() => vi.fn());
const mockInvalidate = vi.hoisted(() => vi.fn());

const mockPlatformAdminState = vi.hoisted(() => ({
  isPlatformAdmin: true,
  // MFA step-up state — drives the requireMfa() mock below. Defaults to
  // satisfied so existing happy-path tests are unaffected; the MFA-gate
  // tests flip this to false to assert the 403 step-up.
  mfaSatisfied: true,
}));

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
  eq: (left: unknown, right: unknown) => ({ op: 'eq', left, right }),
  ilike: (left: unknown, right: unknown) => ({ op: 'ilike', left, right }),
  inArray: (left: unknown, right: unknown) => ({ op: 'inArray', left, right }),
  or: (...conditions: unknown[]) => ({ op: 'or', conditions }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    op: 'sql',
    strings: Array.from(strings),
    values,
  }),
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  thirdPartyPackageCatalog: mockCatalogTable,
  thirdPartyReleaseTests: mockReleaseTestsTable,
}));

vi.mock('../../jobs/wingetReleaseTestWorker', () => ({
  enqueueWingetReleaseTest: mockEnqueue,
  executeWingetReleaseTest: mockExecute,
}));

vi.mock('../../services/thirdPartyEnrichment', () => ({
  invalidateCatalogCache: mockInvalidate,
}));

vi.mock('../../middleware/platformAdmin', () => ({
  platformAdminMiddleware: vi.fn(async (c: any, next: any) => {
    if (!mockPlatformAdminState.isPlatformAdmin) {
      throw new HTTPException(403, { message: 'platform admin access required' });
    }

    c.set('auth', {
      user: {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'platform@example.com',
        isPlatformAdmin: true,
      },
      // Surface the MFA claim so the requireMfa() mock can gate on it,
      // mirroring how real JWTs carry the `mfa` claim.
      token: { mfa: mockPlatformAdminState.mfaSatisfied },
    });
    return next();
  }),
}));

// Mirror the REAL requireMfa() behavior: 401 when no auth, 403 when the
// token's `mfa` claim is unsatisfied, pass-through otherwise. The mutating
// operations routes (POST /, PATCH /:id, DELETE /:id, POST /:id/test) are
// gated by requireMfa() on top of the platform-admin gate.
vi.mock('../../middleware/auth', () => ({
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    const auth = c.get('auth');
    if (!auth) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    if (auth.token?.mfa === false) {
      return c.json({ error: 'MFA required' }, 403);
    }
    return next();
  }),
}));

import { db } from '../../db';

type CatalogRow = {
  id: string;
  source: string;
  packageId: string;
  vendor: string;
  friendlyName: string;
  category: string;
  defaultSeverity: string;
  breezeTested: boolean;
  notes: string | null;
  homepageUrl: string | null;
  osvEcosystem: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function catalogRow(overrides: Partial<CatalogRow>): CatalogRow {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    source: 'third_party',
    packageId: 'Mozilla.Firefox',
    vendor: 'Mozilla',
    friendlyName: 'Mozilla Firefox',
    category: 'application',
    defaultSeverity: 'unknown',
    breezeTested: false,
    notes: null,
    homepageUrl: null,
    osvEcosystem: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function updateReturning(rows: CatalogRow[]) {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

function deleteReturning(rows: Array<{ id: string }>) {
  return {
    where: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(rows),
    }),
  };
}

function inflightSelect(rows: Array<{ id: string }>) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

describe('third-party catalog operations routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPlatformAdminState.isPlatformAdmin = true;
    mockPlatformAdminState.mfaSatisfied = true;
    app = new Hono();
    app.route('/third-party-catalog', thirdPartyCatalogRoutes);
  });

  // MFA step-up: the mutating/destructive operations (create, update, hard
  // delete, and the SSH-spawning release-test) MUST require MFA on top of the
  // platform-admin gate. requireMfa() is a no-op when ENABLE_2FA is off, so the
  // gate is free until 2FA is enabled. Read routes (GET) are intentionally NOT
  // gated.
  describe('MFA step-up on mutating operations', () => {
    beforeEach(() => {
      mockPlatformAdminState.mfaSatisfied = false;
    });

    it('rejects POST / (create) when MFA is not satisfied (403)', async () => {
      const res = await app.request('/third-party-catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packageId: 'Mozilla.Firefox',
          vendor: 'Mozilla',
          friendlyName: 'Mozilla Firefox',
        }),
      });

      expect(res.status).toBe(403);
      expect(await res.text()).toContain('MFA required');
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('rejects PATCH /:id (update) when MFA is not satisfied (403)', async () => {
      const res = await app.request('/third-party-catalog/22222222-2222-4222-8222-222222222222', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ friendlyName: 'Renamed' }),
      });

      expect(res.status).toBe(403);
      expect(await res.text()).toContain('MFA required');
      expect(db.update).not.toHaveBeenCalled();
    });

    it('rejects DELETE /:id (hard delete) when MFA is not satisfied (403)', async () => {
      const res = await app.request('/third-party-catalog/22222222-2222-4222-8222-222222222222', {
        method: 'DELETE',
      });

      expect(res.status).toBe(403);
      expect(await res.text()).toContain('MFA required');
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('rejects POST /:id/test (spawns SSH runner) when MFA is not satisfied (403)', async () => {
      const res = await app.request('/third-party-catalog/44444444-4444-4444-8444-444444444444/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: '121.0' }),
      });

      expect(res.status).toBe(403);
      expect(await res.text()).toContain('MFA required');
      expect(db.select).not.toHaveBeenCalled();
      expect(mockEnqueue).not.toHaveBeenCalled();
    });
  });

  it('rejects POST without platform admin access', async () => {
    mockPlatformAdminState.isPlatformAdmin = false;

    const res = await app.request('/third-party-catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        packageId: 'Mozilla.Firefox',
        vendor: 'Mozilla',
        friendlyName: 'Mozilla Firefox',
      }),
    });

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('platform admin access required');
  });

  it('creates catalog items with platform admin access', async () => {
    const row = catalogRow({
      packageId: 'Google.Chrome',
      vendor: 'Google',
      friendlyName: 'Google Chrome',
      osvEcosystem: 'test-ecosystem',
    });
    const values = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([row]),
    });
    vi.mocked(db.insert).mockReturnValueOnce({ values } as never);

    const res = await app.request('/third-party-catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        packageId: 'Google.Chrome',
        vendor: 'Google',
        friendlyName: 'Google Chrome',
        osvEcosystem: 'test-ecosystem',
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body).toEqual(expect.objectContaining({
      packageId: 'Google.Chrome',
      vendor: 'Google',
      friendlyName: 'Google Chrome',
      osvEcosystem: 'test-ecosystem',
    }));
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      osvEcosystem: 'test-ecosystem',
    }));
  });

  it('updates catalog item osvEcosystem with platform admin access', async () => {
    const row = catalogRow({
      osvEcosystem: 'test-ecosystem',
    });
    const set = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([row]),
      }),
    });
    vi.mocked(db.update).mockReturnValueOnce({ set } as never);

    const res = await app.request('/third-party-catalog/22222222-2222-4222-8222-222222222222', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        osvEcosystem: 'test-ecosystem',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(expect.objectContaining({
      osvEcosystem: 'test-ecosystem',
    }));
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      osvEcosystem: 'test-ecosystem',
      updatedAt: expect.any(Date),
    }));
  });

  it('returns 404 when patching a missing catalog item', async () => {
    vi.mocked(db.update).mockReturnValueOnce(updateReturning([]) as never);

    const res = await app.request('/third-party-catalog/33333333-3333-4333-8333-333333333333', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        friendlyName: 'Missing Package',
      }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('deletes an existing catalog item', async () => {
    vi.mocked(db.delete).mockReturnValueOnce(deleteReturning([
      { id: '22222222-2222-4222-8222-222222222222' },
    ]) as never);

    const res = await app.request('/third-party-catalog/22222222-2222-4222-8222-222222222222', {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
  });

  describe('POST /:id/test', () => {
    const CATALOG_ID = '44444444-4444-4444-8444-444444444444';

    beforeEach(() => {
      mockEnqueue.mockReset();
      mockExecute.mockReset();
      mockExecute.mockResolvedValue(undefined);
    });

    it('returns 403 without platform admin access', async () => {
      mockPlatformAdminState.isPlatformAdmin = false;

      const res = await app.request(`/third-party-catalog/${CATALOG_ID}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: '121.0' }),
      });

      expect(res.status).toBe(403);
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('returns 400 when catalog entry not found / not breeze-tested', async () => {
      vi.mocked(db.select).mockReturnValueOnce(inflightSelect([]) as never);
      mockEnqueue.mockResolvedValueOnce({ testId: null, alreadyExisted: false });

      const res = await app.request(`/third-party-catalog/${CATALOG_ID}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: '121.0' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('cannot enqueue test');
      expect(mockEnqueue).toHaveBeenCalledWith({ catalogId: CATALOG_ID, version: '121.0' });
    });

    it('returns 202 with body shape on happy path', async () => {
      vi.mocked(db.select).mockReturnValueOnce(inflightSelect([]) as never);
      mockEnqueue.mockResolvedValueOnce({ testId: 'test-1', alreadyExisted: false });

      const res = await app.request(`/third-party-catalog/${CATALOG_ID}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: '121.0' }),
      });

      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ testId: 'test-1', alreadyExisted: false });
      expect(mockExecute).toHaveBeenCalledWith({ testId: 'test-1' });
    });

    it('returns 409 when a test is already queued/running', async () => {
      vi.mocked(db.select).mockReturnValueOnce(
        inflightSelect([{ id: 'existing-test-id' }]) as never
      );

      const res = await app.request(`/third-party-catalog/${CATALOG_ID}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: '121.0' }),
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'test already in progress',
        testId: 'existing-test-id',
      });
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('returns 400 for malformed version (empty string)', async () => {
      const res = await app.request(`/third-party-catalog/${CATALOG_ID}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: '' }),
      });

      expect(res.status).toBe(400);
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('returns 400 when version is missing', async () => {
      const res = await app.request(`/third-party-catalog/${CATALOG_ID}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      expect(mockEnqueue).not.toHaveBeenCalled();
    });
  });
});
