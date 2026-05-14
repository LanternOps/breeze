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
  createdAt: 'thirdPartyPackageCatalog.createdAt',
  updatedAt: 'thirdPartyPackageCatalog.updatedAt',
}));

const mockPlatformAdminState = vi.hoisted(() => ({
  isPlatformAdmin: true,
}));

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
  eq: (left: unknown, right: unknown) => ({ op: 'eq', left, right }),
  ilike: (left: unknown, right: unknown) => ({ op: 'ilike', left, right }),
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
    });
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
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function insertReturning(row: CatalogRow) {
  return {
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([row]),
    }),
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

describe('third-party catalog operations routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPlatformAdminState.isPlatformAdmin = true;
    app = new Hono();
    app.route('/third-party-catalog', thirdPartyCatalogRoutes);
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
    });
    vi.mocked(db.insert).mockReturnValueOnce(insertReturning(row) as never);

    const res = await app.request('/third-party-catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        packageId: 'Google.Chrome',
        vendor: 'Google',
        friendlyName: 'Google Chrome',
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body).toEqual(expect.objectContaining({
      packageId: 'Google.Chrome',
      vendor: 'Google',
      friendlyName: 'Google Chrome',
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
});
