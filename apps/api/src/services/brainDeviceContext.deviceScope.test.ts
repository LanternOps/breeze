/**
 * Exact-device + site axis (#6086 finding 13a) for `resolveDeviceContext`.
 *
 * The tool resolves a context entry BY CONTEXT ID, so a device-bound run could
 * mutate (and confirm the existence of) an entry belonging to a sibling device
 * in the same org. The device behind the entry must be access-checked first.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

import { db } from '../db';
import { resolveDeviceContext } from './brainDeviceContext';
import type { AuthContext } from '../middleware/auth';

const mockDb = db as unknown as {
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

function makeAuth(opts: { allowedDeviceIds?: string[]; allowedSiteIds?: string[] }): AuthContext {
  const { allowedDeviceIds, allowedSiteIds } = opts;
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
    allowedDeviceIds,
    allowedSiteIds,
    canAccessSite: allowedSiteIds
      ? (s: string | null | undefined) => !!s && allowedSiteIds.includes(s)
      : undefined,
  } as unknown as AuthContext;
}

/** entry lookup → the entry's device; device lookup (site axis) → its site. */
function mockEntry(deviceId: string, siteId = 'site-1') {
  mockDb.select.mockImplementation((cols?: unknown) => {
    if (cols && typeof cols === 'object' && 'siteId' in (cols as object) && !('deviceId' in (cols as object))) {
      return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ siteId }]) }) }) };
    }
    return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ deviceId }]) }) }) };
  });
  mockDb.update.mockReturnValue({
    set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 'ctx-1' }]) }) }),
  });
}

describe('resolveDeviceContext — exact-device narrowing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('device-bound caller cannot resolve an entry belonging to a sibling device at the same site', async () => {
    mockEntry('dev-2');
    const res = await resolveDeviceContext('ctx-1', makeAuth({ allowedDeviceIds: ['dev-1'], allowedSiteIds: ['site-1'] }));
    expect(res.updated).toBe(false);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('device-LESS analysis run (no site axis at all) also cannot resolve the sibling entry', async () => {
    mockEntry('dev-2');
    const res = await resolveDeviceContext('ctx-1', makeAuth({ allowedDeviceIds: ['dev-1'] }));
    expect(res.updated).toBe(false);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('device-bound caller still resolves its OWN device entry (no over-blocking)', async () => {
    mockEntry('dev-1');
    const res = await resolveDeviceContext('ctx-1', makeAuth({ allowedDeviceIds: ['dev-1'], allowedSiteIds: ['site-1'] }));
    expect(res.updated).toBe(true);
    expect(mockDb.update).toHaveBeenCalled();
  });

  it('unrestricted caller resolves without any extra scope lookup (no regression)', async () => {
    mockEntry('dev-9');
    const res = await resolveDeviceContext('ctx-1', makeAuth({}));
    expect(res.updated).toBe(true);
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});
