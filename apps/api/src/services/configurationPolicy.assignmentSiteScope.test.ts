import { describe, it, expect, vi, beforeEach } from 'vitest';

// authorizeAssignmentTarget (SR5-07) gates whether a SITE-restricted caller may
// touch a given assignment target. It's a separate concern from
// validateAssignmentTarget (org/partner ownership). The db is mocked: site/group
// resolution ends in `.limit(1)`; org/partner denials must short-circuit BEFORE
// any query runs.
const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));
vi.mock('../db', () => ({
  db: { select: selectMock },
}));

import { authorizeAssignmentTarget } from './configurationPolicy';
import type { AuthContext } from '../middleware/auth';

function mockSelectResolving(rows: unknown[]) {
  const chain: any = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  selectMock.mockReturnValue(chain);
}

// Site-restricted org-scope caller allowed to see `allowedSiteIds`.
function restricted(allowedSiteIds: string[]): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) => !!s && allowedSiteIds.includes(s),
  } as unknown as AuthContext;
}

// Unrestricted caller (no site allowlist).
function unrestricted(): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: 'p1', orgId: null, scope: 'partner',
    accessibleOrgIds: null, orgCondition: () => undefined, canAccessOrg: () => true,
    allowedSiteIds: undefined, canAccessSite: () => true,
  } as unknown as AuthContext;
}

const SITE_A = '44444444-4444-4444-4444-444444444444';
const SITE_B = '55555555-5555-5555-5555-555555555555';
const GROUP_ID = '66666666-6666-6666-6666-666666666666';
const DEVICE_ID = '77777777-7777-7777-7777-777777777777';
const ORG_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => selectMock.mockReset());

describe('authorizeAssignmentTarget — site sub-axis (SR5-07)', () => {
  it('is a no-op (allow) for an unrestricted caller, without querying', async () => {
    const r = await authorizeAssignmentTarget(unrestricted(), 'organization', ORG_ID);
    expect(r.valid).toBe(true);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('denies an organization-level target for a site-restricted caller (no query)', async () => {
    const r = await authorizeAssignmentTarget(restricted([SITE_A]), 'organization', ORG_ID);
    expect(r.valid).toBe(false);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('denies a partner-level target for a site-restricted caller (no query)', async () => {
    const r = await authorizeAssignmentTarget(restricted([SITE_A]), 'partner', 'p1');
    expect(r.valid).toBe(false);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('allows a site target inside the caller allowlist', async () => {
    const r = await authorizeAssignmentTarget(restricted([SITE_A]), 'site', SITE_A);
    expect(r.valid).toBe(true);
    // Site membership is decided purely by the allowlist — no DB round-trip.
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('denies a site target outside the caller allowlist', async () => {
    const r = await authorizeAssignmentTarget(restricted([SITE_A]), 'site', SITE_B);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/outside your site access/i);
  });

  it('allows a device_group whose site is in the allowlist', async () => {
    mockSelectResolving([{ siteId: SITE_A }]);
    const r = await authorizeAssignmentTarget(restricted([SITE_A]), 'device_group', GROUP_ID);
    expect(r.valid).toBe(true);
  });

  it('denies a device_group whose site is outside the allowlist', async () => {
    mockSelectResolving([{ siteId: SITE_B }]);
    const r = await authorizeAssignmentTarget(restricted([SITE_A]), 'device_group', GROUP_ID);
    expect(r.valid).toBe(false);
  });

  it('denies a device_group with no site (org-wide) for a restricted caller (fail closed)', async () => {
    mockSelectResolving([{ siteId: null }]);
    const r = await authorizeAssignmentTarget(restricted([SITE_A]), 'device_group', GROUP_ID);
    expect(r.valid).toBe(false);
  });

  it('denies an unknown device_group (fail closed)', async () => {
    mockSelectResolving([]);
    const r = await authorizeAssignmentTarget(restricted([SITE_A]), 'device_group', GROUP_ID);
    expect(r.valid).toBe(false);
  });

  it('allows a device whose site is in the allowlist', async () => {
    mockSelectResolving([{ siteId: SITE_A }]);
    const r = await authorizeAssignmentTarget(restricted([SITE_A]), 'device', DEVICE_ID);
    expect(r.valid).toBe(true);
  });

  it('denies a device whose site is outside the allowlist', async () => {
    mockSelectResolving([{ siteId: SITE_B }]);
    const r = await authorizeAssignmentTarget(restricted([SITE_A]), 'device', DEVICE_ID);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/outside your site access/i);
  });

  it('denies an unknown device (fail closed)', async () => {
    mockSelectResolving([]);
    const r = await authorizeAssignmentTarget(restricted([SITE_A]), 'device', DEVICE_ID);
    expect(r.valid).toBe(false);
  });
});
