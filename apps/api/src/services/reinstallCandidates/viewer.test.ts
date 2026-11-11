import { describe, expect, it } from 'vitest';
import { canViewReattachCandidate, canViewReattachSource, type CandidatesViewer } from './viewer';

// #8318 §7.3 "No leaks", §9: who sees a source's reattach candidates.

const PARTNER = 'partner-1';

function viewer(over: Partial<CandidatesViewer> & { orgs?: string[] } = {}): CandidatesViewer {
  const orgs = over.orgs ?? ['org-a', 'org-b'];
  return {
    scope: 'partner',
    partnerId: PARTNER,
    partnerOrgAccess: 'all',
    canAccessOrg: (orgId: string) => orgs.includes(orgId),
    allowedSiteIds: undefined,
    canAccessSite: undefined,
    allowedDeviceIds: undefined,
    ...over,
  } as CandidatesViewer;
}

const realSource = { id: 'dev-src', orgId: 'org-a', siteId: 'site-a', orgType: 'customer', partnerId: PARTNER };
const parkedSource = { id: 'dev-parked', orgId: 'holding', siteId: 'site-h', orgType: 'unassigned_pool', partnerId: PARTNER };
const target = { id: 'dev-old', orgId: 'org-b', siteId: 'site-b' };

describe('canViewReattachSource', () => {
  it('a parked source is seen by a full partner admin of its partner only', () => {
    expect(canViewReattachSource(viewer(), parkedSource)).toBe(true);
    expect(canViewReattachSource(viewer({ partnerId: 'partner-2' }), parkedSource)).toBe(false);
    // A technician limited to selected orgs: not until wave H's switch.
    expect(canViewReattachSource(viewer({ partnerOrgAccess: 'selected' }), parkedSource)).toBe(false);
    // An organization user never sees the holding area.
    expect(canViewReattachSource(viewer({ scope: 'organization', partnerOrgAccess: null }), parkedSource)).toBe(false);
  });

  it('a real source needs its org, its site and (for a device-bound run) the device', () => {
    expect(canViewReattachSource(viewer(), realSource)).toBe(true);
    expect(canViewReattachSource(viewer({ orgs: ['org-b'] }), realSource)).toBe(false);
    expect(canViewReattachSource(viewer({ allowedSiteIds: ['site-x'] }), realSource)).toBe(false);
    expect(canViewReattachSource(viewer({ allowedSiteIds: ['site-a'] }), realSource)).toBe(true);
    expect(canViewReattachSource(viewer({ canAccessSite: (s) => s === 'site-x' }), realSource)).toBe(false);
    expect(canViewReattachSource(viewer({ allowedDeviceIds: ['dev-other'] }), realSource)).toBe(false);
  });
});

describe('canViewReattachCandidate', () => {
  it('lists a candidate only to a partner user who reaches its org and site', () => {
    expect(canViewReattachCandidate(viewer(), target)).toBe(true);
    expect(canViewReattachCandidate(viewer({ orgs: ['org-a'] }), target)).toBe(false);
    expect(canViewReattachCandidate(viewer({ allowedSiteIds: ['site-a'] }), target)).toBe(false);
    expect(canViewReattachCandidate(viewer({ allowedDeviceIds: ['dev-src'] }), target)).toBe(false);
  });

  it('never lists a candidate to an organization user, even in their own org', () => {
    expect(canViewReattachCandidate(viewer({ scope: 'organization', partnerOrgAccess: null }), target)).toBe(false);
  });
});
