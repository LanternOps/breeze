import { describe, it, expect, vi, beforeEach } from 'vitest';

// aiTools.ts transitively imports commandQueue/db helpers, so the db mock must
// expose the context helpers too (not just `db`).
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

import { db } from '../db';
import { verifyDeviceAccess } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function mockDeviceRow(row: Record<string, unknown> | undefined): void {
  mockDb.select.mockReturnValue({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(row ? [row] : []),
      }),
    }),
  });
}

// Mirrors how the request/MCP paths build the site axis onto AuthContext:
// undefined allowlist => unrestricted; otherwise membership check, null site denied.
function makeAuth(overrides?: Partial<AuthContext>): AuthContext {
  const allowedSiteIds = overrides?.allowedSiteIds;
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedSiteIds,
    canAccessSite: (siteId: string | null | undefined) => {
      if (!allowedSiteIds) return true;
      if (!siteId) return false;
      return allowedSiteIds.includes(siteId);
    },
    ...overrides,
  };
}

describe('verifyDeviceAccess — site scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('denies a device in a site outside the user site allowlist', async () => {
    mockDeviceRow({ id: 'd1', orgId: 'org-1', siteId: 'site-B', hostname: 'h', status: 'online' });
    const auth = makeAuth({ allowedSiteIds: ['site-A'] });
    const result = await verifyDeviceAccess('d1', auth);
    expect(result).toEqual({ error: 'Device not found or access denied' });
  });

  it('allows a device within the user site allowlist', async () => {
    const row = { id: 'd1', orgId: 'org-1', siteId: 'site-A', hostname: 'h', status: 'online' };
    mockDeviceRow(row);
    const auth = makeAuth({ allowedSiteIds: ['site-A'] });
    const result = await verifyDeviceAccess('d1', auth);
    expect(result).toEqual({ device: row });
  });

  it('denies a device with no site assignment for a site-restricted user', async () => {
    mockDeviceRow({ id: 'd1', orgId: 'org-1', siteId: null, hostname: 'h', status: 'online' });
    const auth = makeAuth({ allowedSiteIds: ['site-A'] });
    const result = await verifyDeviceAccess('d1', auth);
    expect(result).toEqual({ error: 'Device not found or access denied' });
  });

  it('allows any site for an unrestricted user (no regression)', async () => {
    const row = { id: 'd1', orgId: 'org-1', siteId: 'site-Z', hostname: 'h', status: 'online' };
    mockDeviceRow(row);
    const auth = makeAuth(); // allowedSiteIds undefined => unrestricted
    const result = await verifyDeviceAccess('d1', auth);
    expect(result).toEqual({ device: row });
  });
});
