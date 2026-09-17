import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../middleware/auth';

const mocks = vi.hoisted(() => ({ rows: [] as { id: string; siteId: string | null }[], where: vi.fn() }));
vi.mock('../db', () => ({
  db: { select: vi.fn(() => ({ from: vi.fn(() => ({ where: mocks.where })) })) },
}));
import { db } from '../db';
import { deviceIdSiteDenied, deviceSiteDenied, resolveSiteAllowedDeviceIds, resolveSiteDevicePartition } from './aiToolsSiteScope';

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

  it('requires an in-scope device ID for indirect device or site-only resources', () => {
    const ctx = auth({ allowedDeviceIds: ['target'] });
    expect(deviceSiteDenied(ctx, 'site-1', 'target')).toBe(false);
    expect(deviceSiteDenied(ctx, 'site-2', 'target')).toBe(true);
    expect(deviceSiteDenied(ctx, 'site-1', 'sibling')).toBe(true);
    expect(deviceSiteDenied(ctx, 'site-1')).toBe(true);
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
