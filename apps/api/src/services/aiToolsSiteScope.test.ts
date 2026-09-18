import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../middleware/auth';

const mocks = vi.hoisted(() => ({ rows: [] as { id: string; siteId: string | null }[], where: vi.fn() }));
vi.mock('../db', () => ({
  db: { select: vi.fn(() => ({ from: vi.fn(() => ({ where: mocks.where })) })) },
}));
import { db } from '../db';
import {
  deviceIdSiteDenied, deviceSiteDenied, resolveSiteAllowedDeviceIds, resolveSiteDevicePartition,
  scopeDeviceIdsToCaller, siteScopeCondition,
} from './aiToolsSiteScope';
import { PgDialect } from 'drizzle-orm/pg-core';
import { devices } from '../db/schema/devices';

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    orgId: 'org-1', allowedSiteIds: ['site-1'],
    canAccessSite: (siteId: string | null | undefined) => siteId === 'site-1',
    ...overrides,
  } as AuthContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows = [
    { id: 'target', siteId: 'site-1' },
    { id: 'sibling', siteId: 'site-1' },
    { id: 'outside', siteId: 'site-2' },
    { id: 'no-site', siteId: null },
  ];
  mocks.where.mockImplementation(() => Object.assign(Promise.resolve(mocks.rows), {
    limit: async () => mocks.rows.slice(0, 1),
  }));
});

describe('exact device scope intersects site scope', () => {
  it('narrows site enumeration to the run device, excluding siblings', async () => {
    expect(await resolveSiteAllowedDeviceIds('org-1', auth({ allowedDeviceIds: ['target', 'outside'] })))
      .toEqual(['target']);
  });

  it('partitions same-site siblings into forbidden device IDs', async () => {
    expect(await resolveSiteDevicePartition('org-1', auth({ allowedDeviceIds: ['target'] })))
      .toEqual({ allowed: ['target'], forbidden: ['sibling', 'outside', 'no-site'] });
  });

  it('does not change human site scope', async () => {
    expect(await resolveSiteAllowedDeviceIds('org-1', auth())).toEqual(['target', 'sibling']);
  });

  it('does not query for unrestricted human callers', async () => {
    expect(await resolveSiteAllowedDeviceIds('org-1', auth({ allowedSiteIds: undefined, canAccessSite: undefined })))
      .toBeNull();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('honors a frozen device set with no site axis', async () => {
    expect(await resolveSiteAllowedDeviceIds('org-1', auth({
      allowedSiteIds: undefined, canAccessSite: undefined, allowedDeviceIds: ['outside'],
    }))).toEqual(['outside']);
  });

  it('empty device scope matches nothing and missing site authorization fails closed', async () => {
    expect(await resolveSiteAllowedDeviceIds('org-1', auth({ allowedDeviceIds: [] }))).toEqual([]);
    expect(await resolveSiteAllowedDeviceIds('org-1', auth({ canAccessSite: undefined }))).toEqual([]);
  });

  it('requires an in-scope device ID for a device-keyed resource', () => {
    const ctx = auth({ allowedDeviceIds: ['target'] });
    expect(deviceSiteDenied(ctx, 'site-1', 'target')).toBe(false);
    expect(deviceSiteDenied(ctx, 'site-2', 'target')).toBe(true);
    expect(deviceSiteDenied(ctx, 'site-1', 'sibling')).toBe(true);
    // An unresolvable device on a device-keyed resource fails closed.
    expect(deviceSiteDenied(ctx, 'site-1', null)).toBe(true);
  });

  // #6096 D2: `agentAuthContext` pins `allowedDeviceIds` on EVERY device-bound
  // run, and the site-only fleet resources (groups, deployments, alert rules)
  // pass no device id. Denying those on the device axis made every such
  // resource "not found" for every device-bound full run.
  it('falls through to the site check for a site-only resource', () => {
    const ctx = auth({ allowedDeviceIds: ['target'] });
    expect(deviceSiteDenied(ctx, 'site-1')).toBe(false);
    expect(deviceSiteDenied(ctx, 'site-2')).toBe(true);
    expect(deviceSiteDenied(ctx, null)).toBe(true);
  });

  it('rejects indirect access to sibling alerts/snapshots before querying the device', async () => {
    expect(await deviceIdSiteDenied(auth({ allowedDeviceIds: ['target'] }), 'sibling')).toBe(true);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('checks the current site and fails closed for a missing indirect device', async () => {
    expect(await deviceIdSiteDenied(auth({ allowedDeviceIds: ['target'] }), 'target')).toBe(false);
    mocks.rows = [{ id: 'target', siteId: 'site-2' }];
    expect(await deviceIdSiteDenied(auth({ allowedDeviceIds: ['target'] }), 'target')).toBe(true);
    mocks.rows = [];
    expect(await deviceIdSiteDenied(auth({ allowedDeviceIds: ['target'] }), 'target')).toBe(true);
  });
});

// ── Direct coverage for the two primitives every caller-side guard leans on ──
// Both were only ever exercised through their consumers, so a regression in
// either (dropping an axis, or collapsing "unrestricted" with "nothing in
// scope") would surface as a leak in some distant tool rather than here.

describe('scopeDeviceIdsToCaller', () => {
  it('intersects BOTH axes — a device in the allowlist but outside the site is dropped', async () => {
    // 'outside' passes the exact-device filter and then fails the site scan.
    expect(await scopeDeviceIdsToCaller(
      auth({ allowedDeviceIds: ['target', 'outside'] }), 'org-1', ['target', 'outside'],
    )).toEqual(['target']);
  });

  it('drops ids outside the exact-device allowlist without a site scan', async () => {
    expect(await scopeDeviceIdsToCaller(
      auth({ allowedSiteIds: undefined, canAccessSite: undefined, allowedDeviceIds: ['target'] }),
      'org-1', ['target', 'sibling'],
    )).toEqual(['target']);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('drops ids outside the site allowlist for a site-restricted human', async () => {
    expect(await scopeDeviceIdsToCaller(auth(), 'org-1', ['target', 'outside', 'no-site']))
      .toEqual(['target']);
  });

  it('returns [] — never null — for a restricted caller with nothing in scope', async () => {
    // `canAccessSite` is derived from `allowedSiteIds` in a real AuthContext, so
    // an empty allowlist must reject every site here too.
    expect(await scopeDeviceIdsToCaller(
      auth({ allowedSiteIds: [], canAccessSite: () => false }), 'org-1', ['target'],
    )).toEqual([]);
    expect(await scopeDeviceIdsToCaller(auth({ allowedDeviceIds: [] }), 'org-1', ['target'])).toEqual([]);
  });

  it('returns null and issues zero queries for an unrestricted caller', async () => {
    expect(await scopeDeviceIdsToCaller(
      auth({ allowedSiteIds: undefined, canAccessSite: undefined }), 'org-1', ['target', 'outside'],
    )).toBeNull();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('ignores non-string and non-array inputs rather than trusting them', async () => {
    expect(await scopeDeviceIdsToCaller(auth(), 'org-1', ['target', 42, null])).toEqual(['target']);
    expect(await scopeDeviceIdsToCaller(auth(), 'org-1', 'target')).toEqual([]);
    expect(await scopeDeviceIdsToCaller(auth(), 'org-1', undefined)).toEqual([]);
  });
});

describe('siteScopeCondition', () => {
  const render = (cond: unknown) => new PgDialect().sqlToQuery(cond as never);

  it('returns undefined — no narrowing, no cost — for an unrestricted caller', () => {
    expect(siteScopeCondition(auth({ allowedSiteIds: undefined, canAccessSite: undefined }), devices.siteId))
      .toBeUndefined();
  });

  it('renders an IN over the allowlist for a site-restricted caller', () => {
    const q = render(siteScopeCondition(auth({ allowedSiteIds: ['site-1', 'site-2'] }), devices.siteId));
    expect(q.sql).toMatch(/site_id/);
    expect(q.params).toEqual(['site-1', 'site-2']);
  });

  it('renders SQL false — matching nothing — for an EMPTY allowlist', () => {
    const q = render(siteScopeCondition(auth({ allowedSiteIds: [] }), devices.siteId));
    expect(q.sql).toMatch(/\bfalse\b/);
    expect(q.params).toEqual([]);
  });
});
