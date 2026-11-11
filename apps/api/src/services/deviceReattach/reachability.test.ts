import { describe, expect, it } from 'vitest';
import type { ReattachActorAccess } from './access';
import { isReattachDeviceReachable, type ReattachDeviceLocation } from './reachability';

// #8318 wave 2-2 review: which devices a reattach requester may even name.

const PARTNER = 'partner-1';
const actor = (orgAccess: 'all' | 'selected' | 'none', reachableOrgIds: string[] = []): ReattachActorAccess => ({
  userId: 'user-1',
  status: 'active',
  partnerId: PARTNER,
  membership: { orgAccess, reachableOrgIds, grants: [] },
});
const at = (orgId: string, orgType = 'customer', orgPartnerId = PARTNER): ReattachDeviceLocation => ({ id: `dev-${orgId}`, orgId, orgType, orgPartnerId });

describe('isReattachDeviceReachable', () => {
  it('nothing is reachable that does not exist, belongs to another partner, or has no membership behind it', () => {
    expect(isReattachDeviceReachable(actor('all'), PARTNER, undefined, 'target')).toBe(false);
    expect(isReattachDeviceReachable(actor('all'), PARTNER, at('org-x', 'customer', 'partner-2'), 'target')).toBe(false);
    expect(isReattachDeviceReachable(null, PARTNER, at('org-a'), 'target')).toBe(false);
    expect(isReattachDeviceReachable({ ...actor('all'), membership: null }, PARTNER, at('org-a'), 'target')).toBe(false);
    expect(isReattachDeviceReachable(actor('none'), PARTNER, at('org-a'), 'target')).toBe(false);
  });

  it('a full partner admin reaches every org of the partner, hidden and suspended ones included', () => {
    for (const type of ['customer', 'unassigned_pool', 'quick_support']) {
      expect(isReattachDeviceReachable(actor('all'), PARTNER, at('org-any', type), 'source')).toBe(true);
      expect(isReattachDeviceReachable(actor('all'), PARTNER, at('org-any', type), 'target')).toBe(true);
    }
  });

  it('a technician reaches only their live orgs; a parked source passes on to full_admin_required', () => {
    const tech = actor('selected', ['org-a']);
    expect(isReattachDeviceReachable(tech, PARTNER, at('org-a'), 'target')).toBe(true);
    expect(isReattachDeviceReachable(tech, PARTNER, at('org-b'), 'target')).toBe(false);
    expect(isReattachDeviceReachable(tech, PARTNER, at('holding', 'unassigned_pool'), 'source')).toBe(true);
    expect(isReattachDeviceReachable(tech, PARTNER, at('holding', 'unassigned_pool'), 'target')).toBe(false);
    expect(isReattachDeviceReachable(tech, PARTNER, at('qs', 'quick_support'), 'source')).toBe(false);
    expect(isReattachDeviceReachable(tech, PARTNER, at('qs', 'quick_support'), 'target')).toBe(false);
  });
});
