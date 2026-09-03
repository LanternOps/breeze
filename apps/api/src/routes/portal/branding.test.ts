import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

// DB mock: select().from().where().limit() resolves the next queued row set.
// Mirrors the single-slot pattern in featureFlags.test.ts — each test issues
// exactly one read (the authenticated org projection, or the public
// domain-lookup projection).
const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: [] as unknown[],
    where: undefined as unknown,
  },
}));
vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'limit']) chain[m] = vi.fn(() => chain);
  chain.where = vi.fn((predicate: unknown) => {
    dbState.where = predicate;
    return chain;
  });
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(dbState.rows).then(resolve);
  return {
    db: chain,
    runOutsideDbContext: <T>(fn: () => T): T => fn(),
    withSystemDbAccessContext: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
});

import { brandingRoutes } from './branding';

const ORG_ID = '22222222-2222-2222-2222-222222222222';

function buildAuthenticatedApp() {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: { id: 'pu1', orgId: ORG_ID, email: 'c@example.test', name: 'Cust', contactId: null, receiveNotifications: true, status: 'active' },
      token: 't',
      authMethod: 'bearer',
      timezone: 'UTC',
    });
    await next();
  });
  a.route('/', brandingRoutes);
  return a;
}

const authenticatedApp = buildAuthenticatedApp();

describe('GET /branding (authenticated)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.rows = [];
    dbState.where = undefined;
  });

  it('returns all visibility flags for the authenticated org', async () => {
    dbState.rows = [{
      enableDashboard: true,
      enableSecurity: true,
      enableBackups: false,
      enableReports: true,
      enableSupportUsage: false,
    }];

    const response = await authenticatedApp.request('/branding');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      branding: {
        enableDashboard: true,
        enableSecurity: true,
        enableBackups: false,
        enableReports: true,
        enableSupportUsage: false,
      },
    });

    const query = new PgDialect().sqlToQuery(dbState.where as SQL);
    expect(query.sql).toContain('"portal_branding"."org_id" = $1');
    expect(query.params).toEqual([ORG_ID]);
  });

  it('returns 404 when the authenticated org has no portal_branding row (default state)', async () => {
    dbState.rows = [];

    const response = await authenticatedApp.request('/branding');

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).not.toHaveProperty('branding');
    expect(body).not.toHaveProperty('enableDashboard');
    expect(body).not.toHaveProperty('enableSecurity');
    expect(body).not.toHaveProperty('enableBackups');
    expect(body).not.toHaveProperty('enableReports');
    expect(body).not.toHaveProperty('enableSupportUsage');
  });

  it('applies private cache headers scoped to the authenticated viewer', async () => {
    dbState.rows = [{
      enableDashboard: false,
      enableSecurity: false,
      enableBackups: false,
      enableReports: false,
      enableSupportUsage: false,
    }];

    const response = await authenticatedApp.request('/branding');

    expect(response.headers.get('Cache-Control')).toContain('private');
    expect(response.headers.get('Vary')).toContain('Authorization');
    expect(response.headers.get('Vary')).toContain('Cookie');
  });
});

describe('GET /branding/:domain (public)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.rows = [];
    dbState.where = undefined;
  });

  it('does not require authentication and does not expose visibility flags', async () => {
    dbState.rows = [{
      id: 'b1',
      orgId: ORG_ID,
      logoUrl: null,
      faviconUrl: null,
      primaryColor: null,
      secondaryColor: null,
      accentColor: null,
      customDomain: 'portal.example.test',
      domainVerified: true,
      welcomeMessage: null,
      supportEmail: null,
      supportPhone: null,
      footerText: null,
      customCss: null,
      enableTickets: true,
      enableAssetCheckout: true,
      enableSelfService: true,
      enablePasswordReset: true,
    }];

    const publicApp = new Hono();
    publicApp.route('/', brandingRoutes);
    const response = await publicApp.request('/branding/portal.example.test');

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.branding.customDomain).toBe('portal.example.test');
    expect(body.branding).not.toHaveProperty('enableDashboard');
    expect(body.branding).not.toHaveProperty('enableSecurity');
    expect(body.branding).not.toHaveProperty('enableBackups');
    expect(body.branding).not.toHaveProperty('enableReports');
    expect(body.branding).not.toHaveProperty('enableSupportUsage');
    expect(response.headers.get('Cache-Control')).toContain('public');
  });

  it('returns 404 when the domain is unverified or unknown', async () => {
    dbState.rows = [];

    const publicApp = new Hono();
    publicApp.route('/', brandingRoutes);
    const response = await publicApp.request('/branding/unknown.example.test');

    expect(response.status).toBe(404);
  });
});
