import { describe, expect, it } from 'vitest';
import type { AuthContext } from '../../middleware/auth';
import type { UserPermissions } from '../permissions';
import type { TopologyRequestContext } from './access';
import { siteVisibility } from './presenceVisibility';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const perms = (allowedSiteIds?: string[]) => ({ permissions: [], allowedSiteIds } as unknown as UserPermissions);
const ctx = (request?: string[], ceiling?: string[]): TopologyRequestContext => ({
  auth: { allowedSiteIds: ceiling } as unknown as AuthContext,
  permissions: perms(request),
  scope: { orgId: '00000000-0000-4000-8000-000000000001', siteId: A },
});

describe('siteVisibility (spec S§8)', () => {
  it('requires the live permissions, the request permissions AND the token ceiling', () => {
    expect(siteVisibility(ctx(), perms())(B)).toBe(true); // unrestricted on every axis
    expect(siteVisibility(ctx(), perms([A]))(B)).toBe(false); // live re-read narrowed since the request started
    expect(siteVisibility(ctx([A]), perms())(B)).toBe(false); // request permissions
    expect(siteVisibility(ctx(undefined, [A]), perms())(B)).toBe(false); // token ceiling narrower than the role
    expect(siteVisibility(ctx([A, B], [A, B]), perms([A, B]))(B)).toBe(true);
  });

  it('fails closed on a missing site id and on a malformed allowlist', () => {
    expect(siteVisibility(ctx(), perms())(null)).toBe(false);
    expect(siteVisibility(ctx(), perms(null as unknown as string[]))(B)).toBe(false);
  });
});
