/**
 * #6096 finding 6 — `authorizeAssignmentTarget` early-returns "valid" whenever
 * `auth.allowedSiteIds` is unset, and at level `device` / `device_group` it only
 * ever checked the resolved SITE. A device-bound AI run could therefore apply
 * (or remove) a configuration policy on a sibling device at its own site, and a
 * device-LESS analysis run could do it anywhere in the org.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
  readWithPartnerAxisVisibility: vi.fn(),
}));
vi.mock('../db/partnerAxisRead', () => ({ readWithPartnerAxisVisibility: vi.fn() }));

import { db } from '../db';
import { authorizeAssignmentTarget } from './configurationPolicy';
import type { AuthContext } from '../middleware/auth';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function auth(allowedDeviceIds?: string[], allowedSiteIds?: string[]): AuthContext {
  return {
    principal: { kind: 'ai_agent' },
    user: { id: 'u1' },
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedDeviceIds,
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
  } as unknown as AuthContext;
}

/** device read = select({siteId}); group read = select({siteId}); members = select({deviceId}) */
function mockReads(opts: { deviceSiteId?: string | null; groupSiteId?: string | null; memberIds?: string[] }) {
  mockDb.select.mockImplementation((cols?: any) => {
    const keys = cols ? Object.keys(cols) : [];
    if (keys.includes('deviceId')) {
      return { from: () => ({ where: () => Promise.resolve((opts.memberIds ?? []).map((id) => ({ deviceId: id }))) }) };
    }
    return {
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ siteId: opts.deviceSiteId !== undefined ? opts.deviceSiteId : opts.groupSiteId ?? null }]),
        }),
      }),
    };
  });
}

describe('authorizeAssignmentTarget — exact-device axis', () => {
  beforeEach(() => vi.clearAllMocks());

  it('denies a device target outside the allowlist, even at an allowed site', async () => {
    mockReads({ deviceSiteId: 'site-1' });
    const r = await authorizeAssignmentTarget(auth(['dev-1'], ['site-1']), 'device', 'dev-2');
    expect(r.valid).toBe(false);
  });

  it('denies it for a device-LESS analysis run (no allowedSiteIds)', async () => {
    mockReads({ deviceSiteId: 'site-1' });
    const r = await authorizeAssignmentTarget(auth(['dev-1'], undefined), 'device', 'dev-2');
    expect(r.valid).toBe(false);
  });

  it('still allows the run\'s OWN device', async () => {
    mockReads({ deviceSiteId: 'site-1' });
    const r = await authorizeAssignmentTarget(auth(['dev-1'], ['site-1']), 'device', 'dev-1');
    expect(r.valid).toBe(true);
  });

  it('denies a device_group whose membership reaches outside the allowlist', async () => {
    mockReads({ deviceSiteId: undefined, groupSiteId: 'site-1', memberIds: ['dev-1', 'dev-2'] });
    const r = await authorizeAssignmentTarget(auth(['dev-1'], ['site-1']), 'device_group', 'grp-1');
    expect(r.valid).toBe(false);
  });

  it('allows a device_group whose membership is entirely inside the allowlist', async () => {
    mockReads({ deviceSiteId: undefined, groupSiteId: 'site-1', memberIds: ['dev-1'] });
    const r = await authorizeAssignmentTarget(auth(['dev-1'], ['site-1']), 'device_group', 'grp-1');
    expect(r.valid).toBe(true);
  });

  it('denies a SITE target for a device-restricted caller (fans out past the allowlist)', async () => {
    mockReads({});
    const r = await authorizeAssignmentTarget(auth(['dev-1'], undefined), 'site', 'site-1');
    expect(r.valid).toBe(false);
  });

  it('denies organization level for a device-restricted caller with no site ceiling', async () => {
    mockReads({});
    const r = await authorizeAssignmentTarget(auth(['dev-1'], undefined), 'organization', 'org-1');
    expect(r.valid).toBe(false);
  });

  it('is a no-op for an unrestricted caller', async () => {
    mockReads({});
    expect((await authorizeAssignmentTarget(auth(undefined, undefined), 'organization', 'org-1')).valid).toBe(true);
    expect((await authorizeAssignmentTarget(auth(undefined, undefined), 'device', 'dev-2')).valid).toBe(true);
  });
});
