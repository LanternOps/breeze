import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';

// Tests for the network arm of the unified Devices list (issue #1322,
// phase 1): GET /devices/network surfaces approved, unlinked
// discovered_assets normalized into the shared list shape with
// deviceClass='network'.

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
  },
}));

vi.mock('../../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/schema')>();
  return { ...actual };
});

let accessibleOrgIds: string[] = ['org-1'];
// Site-allowlist for the mocked caller. `undefined` = unrestricted (sees all
// sites in accessible orgs); a real array = a site-restricted caller whose
// list-level site-scoping branch in network.ts MUST be exercised (the most
// isolation-critical code, previously never reached because the mock hard-set
// this to `undefined`). #1322 specialist-panel fix.
let allowedSiteIds: string[] | undefined = undefined;

// The mocked auth stack faithfully models the REAL dependency that the
// production bug violated: `requireScope`/`requirePermission` read
// `c.get('auth')`, which ONLY `authMiddleware` establishes. So our mocked
// `requireScope` does NOT fabricate the auth context out of thin air — it
// reads the context flag that the mocked `authMiddleware` sets and 401s if
// authMiddleware never ran. This means the suite will fail with a 401 the
// moment `networkRoutes.use('*', authMiddleware)` is removed again, closing
// the blind spot where the old mock injected auth itself (#1322 review).
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    // Stand-in for the real middleware establishing the request auth context.
    c.set('auth', {
      user: { id: 'user-1', email: 'a@b.c', name: 'A' },
      scope: 'organization',
      orgId: 'org-1',
      partnerId: null,
      accessibleOrgIds,
      canAccessOrg: (orgId: string) => accessibleOrgIds.includes(orgId),
      orgCondition: () => undefined,
      token: { mfa: false },
    });
    c.set('permissions', {
      permissions: [
        { resource: 'devices', action: 'read' },
      ],
      partnerId: null,
      orgId: 'org-1',
      roleId: 'role-1',
      scope: 'organization',
      // Mirrors the real permissions object: `allowedSiteIds` is the site
      // allowlist the route's site-scoping branch keys off. Driven per-test.
      allowedSiteIds,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (c: any, next: any) => {
    // Mirror the real requireScope: bail 401 when authMiddleware never ran.
    if (!c.get('auth')) return c.json({ error: 'Not authenticated' }, 401);
    return next();
  }),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (!c.get('auth')) return c.json({ error: 'Not authenticated' }, 401);
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

import { networkRoutes } from './network';
import { authMiddleware, requireScope, requirePermission } from '../../middleware/auth';
import { listNetworkDevicesSchema } from './schemas';
import { db } from '../../db';
import { zValidator } from '@hono/zod-validator';

/**
 * Rig the two query shapes the route uses:
 *   - row query: select().from().where().orderBy().limit().offset() → rows
 *   - count query (includeTotal): select().from().where() → [{count}]
 * The count query resolves the promise at `.where()`; the row query keeps
 * chaining. We disambiguate by returning a thenable from `.where()` that
 * also carries `.orderBy`.
 */
// Captures the WHERE condition the row query is built with so site-scoping
// tests can serialize it to SQL and assert the narrowing/lockout predicate.
let capturedRowWhere: unknown;

function rigNetworkRows(rows: unknown[], total?: number) {
  capturedRowWhere = undefined;
  const offset = vi.fn().mockResolvedValue(rows);
  const limit = vi.fn().mockReturnValue({ offset });
  const orderBy = vi.fn().mockReturnValue({ limit });

  vi.mocked(db.select).mockImplementation(((arg: any) => {
    // The count query selects `{ count: sql }`; the row query selects the
    // full projection. Detect the count query by its single `count` key.
    const isCount = arg && typeof arg === 'object' && 'count' in arg && Object.keys(arg).length === 1;
    const where = isCount
      ? vi.fn().mockResolvedValue([{ count: total ?? rows.length }])
      : vi.fn().mockImplementation((cond: unknown) => {
          capturedRowWhere = cond;
          return { orderBy };
        });
    const from = vi.fn().mockReturnValue({ where });
    return { from } as never;
  }) as never);
}

describe('GET /devices/network — unified-list network arm (#1322)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    accessibleOrgIds = ['org-1'];
    allowedSiteIds = undefined;
    app = new Hono();
    app.route('/devices', networkRoutes);
  });

  it('normalizes an approved unlinked asset into the shared list shape with deviceClass="network"', async () => {
    rigNetworkRows([
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        orgId: 'org-1',
        siteId: 'site-1',
        assetType: 'printer',
        hostname: 'hp-laserjet.local',
        label: 'Front Desk Printer',
        ipAddress: '10.0.0.42',
        macAddress: '00:11:22:33:44:55',
        manufacturer: 'HP',
        model: 'LaserJet 400',
        isOnline: true,
        responseTimeMs: 4.2,
        openPorts: [9100, 631],
        lastSeenAt: new Date('2026-06-13T10:00:00.000Z'),
        firstSeenAt: new Date('2026-06-01T10:00:00.000Z'),
        tags: ['lobby'],
        snmpMonitoringEnabled: true,
        networkMonitoringEnabled: false,
      },
    ]);

    const res = await app.request('/devices/network?limit=50', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    const row = body.data[0];

    expect(row).toMatchObject({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      deviceClass: 'network',
      assetType: 'printer',
      // Label wins as the display name.
      hostname: 'Front Desk Printer',
      status: 'online',
      ipAddress: '10.0.0.42',
      manufacturer: 'HP',
      model: 'LaserJet 400',
      responseTimeMs: 4.2,
      monitoringEnabled: true,
    });

    // Agent-only fields must be present-but-null so the web table renders "—".
    expect(row.cpuPercent).toBeNull();
    expect(row.ramPercent).toBeNull();
    expect(row.agentVersion).toBeNull();
    expect(row.osBuild).toBeNull();
    expect(row.hardware).toBeNull();
  });

  it('falls back to hostname then IP when no label is set, and maps offline status', async () => {
    rigNetworkRows([
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        orgId: 'org-1',
        siteId: 'site-1',
        assetType: 'router',
        hostname: 'gw-01',
        label: null,
        ipAddress: '10.0.0.1',
        macAddress: null,
        manufacturer: null,
        model: null,
        isOnline: false,
        responseTimeMs: null,
        openPorts: null,
        lastSeenAt: null,
        firstSeenAt: new Date('2026-06-01T10:00:00.000Z'),
        tags: null,
        snmpMonitoringEnabled: false,
        networkMonitoringEnabled: false,
      },
    ]);

    const res = await app.request('/devices/network', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.data[0];
    expect(row.hostname).toBe('gw-01');
    expect(row.status).toBe('offline');
    expect(row.assetType).toBe('router');
    expect(row.tags).toEqual([]);
  });

  it('returns total only when includeTotal=true', async () => {
    rigNetworkRows([], 7);

    const withTotal = await app.request('/devices/network?includeTotal=true', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });
    const withTotalBody = await withTotal.json();
    expect(withTotalBody.pagination.total).toBe(7);

    rigNetworkRows([]);
    const withoutTotal = await app.request('/devices/network', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });
    const withoutTotalBody = await withoutTotal.json();
    expect(withoutTotalBody.pagination.total).toBeUndefined();
  });

  it('rejects a single-org filter the caller cannot access with 403', async () => {
    rigNetworkRows([]);
    const res = await app.request('/devices/network?orgId=00000000-0000-4000-8000-000000000000', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/denied/i);
  });

  it('rejects an invalid assetType value via the query schema (400)', async () => {
    rigNetworkRows([]);
    const res = await app.request('/devices/network?assetType=bogus', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(400);
  });

  // --- Site-isolation branch (#1322 specialist-panel HIGH) -----------------
  // The list-level site-scoping in network.ts (403 on an out-of-scope site,
  // narrow via inArray(discoveredAssets.siteId, effectiveSiteIds), and the
  // empty-allowlist lockout via sql`false`) is the most isolation-critical
  // code in the route. It only runs when the caller is site-restricted
  // (`permissions.allowedSiteIds` is a real array). Every test above ran with
  // `allowedSiteIds === undefined`, so this branch was NEVER exercised — a
  // site-restricted user could have seen every site's network assets and
  // nothing would have caught it. These tests drive a restricted caller.

  const SITE_A = '11111111-1111-4111-8111-111111111111'; // in the allowlist
  const SITE_B = '22222222-2222-4222-8222-222222222222'; // in the allowlist
  const SITE_OUT = '99999999-9999-4999-8999-999999999999'; // NOT allowed

  it('403s a site-restricted caller requesting a site outside their allowlist', async () => {
    allowedSiteIds = [SITE_A, SITE_B];
    rigNetworkRows([]);

    const res = await app.request(`/devices/network?siteId=${SITE_OUT}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/site denied/i);
    // The query must never have been built — the 403 short-circuits first.
    expect(capturedRowWhere).toBeUndefined();
  });

  it('narrows results to the caller\'s allowed sites when no explicit site filter is given', async () => {
    allowedSiteIds = [SITE_A, SITE_B];
    rigNetworkRows([]);

    const res = await app.request('/devices/network', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    expect(capturedRowWhere).toBeDefined();
    const sqlText = new PgDialect().sqlToQuery(capturedRowWhere as never).sql.toLowerCase();
    const params = new PgDialect().sqlToQuery(capturedRowWhere as never).params;
    // Effective site filter is an `IN (...)` over the allowlist — both allowed
    // sites are bound; no all-rows-allowed and no `false` lockout.
    expect(sqlText).toMatch(/site_id" in \(/);
    expect(params).toContain(SITE_A);
    expect(params).toContain(SITE_B);
    expect(sqlText).not.toContain('false');
  });

  it('narrows to the requested site only when it is inside the allowlist', async () => {
    allowedSiteIds = [SITE_A, SITE_B];
    rigNetworkRows([]);

    const res = await app.request(`/devices/network?siteId=${SITE_A}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    const built = new PgDialect().sqlToQuery(capturedRowWhere as never);
    // Only the requested in-allowlist site is bound — NOT the caller's whole
    // allowlist (a restricted user asking for SITE_A must not leak SITE_B rows
    // they didn't ask for, and must never widen past their allowlist).
    expect(built.params).toContain(SITE_A);
    expect(built.params).not.toContain(SITE_B);
    expect(built.params).not.toContain(SITE_OUT);
  });

  it('locks an empty-allowlist caller out of every row (sql`false`)', async () => {
    // A site-restricted caller whose allowlist is empty must see NOTHING — not
    // every org row. The route encodes this as an unconditional `false`
    // predicate. If this regresses to "no site filter", the caller would see
    // all accessible-org assets (a cross-site isolation breach).
    allowedSiteIds = [];
    rigNetworkRows([
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        orgId: 'org-1',
        siteId: 'site-x',
        assetType: 'printer',
        hostname: 'should-not-leak',
        label: null,
        ipAddress: '10.0.0.5',
        macAddress: null,
        manufacturer: null,
        model: null,
        isOnline: true,
        responseTimeMs: null,
        openPorts: null,
        lastSeenAt: new Date('2026-06-13T10:00:00.000Z'),
        firstSeenAt: new Date('2026-06-01T10:00:00.000Z'),
        tags: null,
        snmpMonitoringEnabled: false,
        networkMonitoringEnabled: false,
      },
    ]);

    const res = await app.request('/devices/network', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    expect(capturedRowWhere).toBeDefined();
    const sqlText = new PgDialect().sqlToQuery(capturedRowWhere as never).sql.toLowerCase();
    // The unconditional false lockout must be present.
    expect(sqlText).toContain('false');
    // And it must NOT have degraded into an `IN (...)` site narrowing.
    expect(sqlText).not.toMatch(/site_id" in \(/);
  });

  // --- Auth-context guard (#1322 review: missing authMiddleware) -----------
  // The shipped route forgot `networkRoutes.use('*', authMiddleware)`, so
  // every real request 401'd because requireScope read an `auth` context that
  // nothing established. The handler-logic tests above all passed because the
  // old mock had requireScope inject the auth itself — a false-confidence
  // blind spot. These two tests close it.

  it('applies authMiddleware on the real route chain (returns 200, not 401)', async () => {
    // Routed through the ACTUAL `networkRoutes` (which self-applies
    // authMiddleware). If `networkRoutes.use('*', authMiddleware)` is removed,
    // the mocked authMiddleware never runs, no auth context is set, and the
    // mocked requireScope 401s — flipping this assertion red.
    expect(vi.mocked(authMiddleware)).toHaveBeenCalledTimes(0);
    rigNetworkRows([]);

    const res = await app.request('/devices/network', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    // Prove the route's middleware stack actually invoked authMiddleware —
    // this is what establishes the auth context the handler depends on.
    expect(vi.mocked(authMiddleware)).toHaveBeenCalled();
  });

  it('401s when authMiddleware is NOT in the chain (proves the guard bites)', async () => {
    // Build the same handler stack as network.ts but DELIBERATELY omit
    // `use('*', authMiddleware)`. This reproduces the original bug: with no
    // authMiddleware, requireScope finds no auth context and 401s. This test
    // fails (200 instead of 401) if requireScope ever stops depending on the
    // auth context authMiddleware sets — i.e. it locks the dependency in place.
    rigNetworkRows([]);
    const bare = new Hono();
    bare.get(
      '/network',
      requireScope('organization', 'partner', 'system'),
      requirePermission('devices', 'read'),
      zValidator('query', listNetworkDevicesSchema),
      (c) => c.json({ data: [], pagination: { page: 1, limit: 500 } }),
    );
    const app2 = new Hono();
    app2.route('/devices', bare);

    const res = await app2.request('/devices/network', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(401);
  });
});
