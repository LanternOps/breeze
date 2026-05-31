import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { thirdPartyCatalogRoutes } from './index';

const mockPlatformAdminState = vi.hoisted(() => ({
  isPlatformAdmin: true,
  // Step-up state on the auth token. List (read) routes are gated by
  // platformAdminMiddleware ONLY — the router-level requireMfa() lives on
  // operations.ts (writes). Reads must stay ungated, so an unsatisfied-MFA
  // token must still read fine. Defaults to true; the asymmetry test flips it.
  tokenMfa: true as boolean,
}));

const mockCatalogTable = vi.hoisted(() => ({
  id: 'thirdPartyPackageCatalog.id',
  source: 'thirdPartyPackageCatalog.source',
  packageId: 'thirdPartyPackageCatalog.packageId',
  vendor: 'thirdPartyPackageCatalog.vendor',
  friendlyName: 'thirdPartyPackageCatalog.friendlyName',
  category: 'thirdPartyPackageCatalog.category',
  defaultSeverity: 'thirdPartyPackageCatalog.defaultSeverity',
  breezeTested: 'thirdPartyPackageCatalog.breezeTested',
  lastTestedAt: 'thirdPartyPackageCatalog.lastTestedAt',
  lastTestedVersion: 'thirdPartyPackageCatalog.lastTestedVersion',
  lastTestedResult: 'thirdPartyPackageCatalog.lastTestedResult',
  notes: 'thirdPartyPackageCatalog.notes',
  homepageUrl: 'thirdPartyPackageCatalog.homepageUrl',
  createdAt: 'thirdPartyPackageCatalog.createdAt',
  updatedAt: 'thirdPartyPackageCatalog.updatedAt',
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
      token: { mfa: mockPlatformAdminState.tokenMfa },
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
  lastTestedAt: Date | null;
  lastTestedVersion: string | null;
  lastTestedResult: string | null;
  notes: string | null;
  homepageUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function catalogRow(overrides: Partial<CatalogRow>): CatalogRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    source: 'third_party',
    packageId: 'Example.Package',
    vendor: 'Example',
    friendlyName: 'Example Package',
    category: 'application',
    defaultSeverity: 'unknown',
    breezeTested: false,
    lastTestedAt: null,
    lastTestedVersion: null,
    lastTestedResult: null,
    notes: null,
    homepageUrl: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function selectCatalogRows(rows: CatalogRow[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            offset: vi.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    }),
  };
}

function selectCount(total: number) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([{ count: total }]),
    }),
  };
}

describe('third-party catalog routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPlatformAdminState.isPlatformAdmin = true;
    mockPlatformAdminState.tokenMfa = true;
    app = new Hono();
    app.route('/third-party-catalog', thirdPartyCatalogRoutes);
  });

  it('rejects GET without platform admin access', async () => {
    mockPlatformAdminState.isPlatformAdmin = false;

    const res = await app.request('/third-party-catalog');

    expect([401, 403]).toContain(res.status);
  });

  it('allows a GET read even when MFA step-up is NOT satisfied (reads bypass requireMfa)', async () => {
    // The router-level requireMfa() gate lives on operations.ts (writes) only.
    // This locks the read/write asymmetry: a future move of requireMfa to a
    // shared parent router would start gating reads and fail this test.
    mockPlatformAdminState.tokenMfa = false;

    vi.mocked(db.select)
      .mockReturnValueOnce(selectCatalogRows([catalogRow({})]) as never)
      .mockReturnValueOnce(selectCount(1) as never);

    const res = await app.request('/third-party-catalog');

    expect(res.status).toBe(200);
  });

  it('lists catalog items with limit pagination', async () => {
    const rows = [
      catalogRow({ id: '11111111-1111-4111-8111-111111111111', packageId: 'Mozilla.Firefox', vendor: 'Mozilla', friendlyName: 'Mozilla Firefox' }),
      catalogRow({ id: '22222222-2222-4222-8222-222222222222', packageId: 'Google.Chrome', vendor: 'Google', friendlyName: 'Google Chrome' }),
      catalogRow({ id: '33333333-3333-4333-8333-333333333333', packageId: 'VideoLAN.VLC', vendor: 'VideoLAN', friendlyName: 'VLC media player' }),
    ];

    vi.mocked(db.select)
      .mockReturnValueOnce(selectCatalogRows(rows) as never)
      .mockReturnValueOnce(selectCount(20) as never);

    const res = await app.request('/third-party-catalog?limit=5');

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.total).toBeGreaterThanOrEqual(20);
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items.length).toBeLessThanOrEqual(5);
    expect(body.limit).toBe(5);
    expect(body.offset).toBe(0);
  });

  it('filters catalog items by vendor', async () => {
    const rows = [
      catalogRow({ id: '11111111-1111-4111-8111-111111111111', packageId: 'Mozilla.Firefox', vendor: 'Mozilla', friendlyName: 'Mozilla Firefox' }),
      catalogRow({ id: '22222222-2222-4222-8222-222222222222', packageId: 'Mozilla.Thunderbird', vendor: 'Mozilla', friendlyName: 'Mozilla Thunderbird' }),
    ];

    vi.mocked(db.select)
      .mockReturnValueOnce(selectCatalogRows(rows) as never)
      .mockReturnValueOnce(selectCount(rows.length) as never);

    const res = await app.request('/third-party-catalog?vendor=Mozilla');

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items).toHaveLength(2);
    expect(body.items.every((item: CatalogRow) => item.vendor === 'Mozilla')).toBe(true);
  });

  it('searches catalog items by friendly name', async () => {
    const rows = [
      catalogRow({ id: '11111111-1111-4111-8111-111111111111', packageId: 'Mozilla.Firefox', vendor: 'Mozilla', friendlyName: 'Mozilla Firefox' }),
    ];

    vi.mocked(db.select)
      .mockReturnValueOnce(selectCatalogRows(rows) as never)
      .mockReturnValueOnce(selectCount(rows.length) as never);

    const res = await app.request('/third-party-catalog?search=firefox');

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items.some((item: CatalogRow) => /firefox/i.test(item.friendlyName))).toBe(true);
  });
});
