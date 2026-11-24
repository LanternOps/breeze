import { describe, expect, it } from 'vitest';
import type { JwtClaimsState } from '@/lib/authScope';
import {
  createOwnerBody,
  creatorKind,
  offersMspOwner,
  offersOrgChoice,
  ownerDefault,
  type CreatorKind,
} from './policyOwner';

const partner = (): JwtClaimsState => ({
  status: 'resolved',
  claims: { scope: 'partner', orgId: null, partnerId: 'p-1' },
});
const orgUser = (orgId = 'org-own'): JwtClaimsState => ({
  status: 'resolved',
  claims: { scope: 'organization', orgId, partnerId: null },
});

describe('creatorKind', () => {
  it('a partner user with full org access is full_partner', () => {
    expect(creatorKind(partner(), true)).toBe('full_partner');
  });
  it('a partner user without full access is limited_partner, and so is one whose access is still loading', () => {
    expect(creatorKind(partner(), false)).toBe('limited_partner');
    expect(creatorKind(partner(), undefined)).toBe('limited_partner');
  });
  it('an org-scope user is org, whatever the partner-wide flag says', () => {
    expect(creatorKind(orgUser(), true)).toBe('org');
  });
  it('unresolved claims are unknown', () => {
    expect(creatorKind({ status: 'unresolved' }, true)).toBe('unknown');
  });
});

describe('the owner default follows the caller\'s access (Decision 1)', () => {
  const cases: Array<[CreatorKind, string | null, string | null, ReturnType<typeof ownerDefault>]> = [
    ['full_partner', 'org-a', null, { kind: 'msp' }],
    ['full_partner', null, null, { kind: 'msp' }],
    ['limited_partner', 'org-a', null, { kind: 'org', orgId: 'org-a' }],
    ['limited_partner', null, null, { kind: 'org', orgId: null }],
    ['org', 'org-switcher', 'org-own', { kind: 'org', orgId: 'org-own' }],
    ['org', 'org-switcher', null, { kind: 'org', orgId: 'org-switcher' }],
    ['unknown', 'org-a', null, { kind: 'org', orgId: 'org-a' }],
  ];
  it.each(cases)('%s with switcher %s (own org %s)', (kind, currentOrgId, ownOrgId, expected) => {
    expect(ownerDefault(kind, currentOrgId, ownOrgId)).toEqual(expected);
  });
});

describe('who may be offered which owner', () => {
  it('only a full-access partner is offered MSP-managed', () => {
    expect(offersMspOwner('full_partner')).toBe(true);
    expect(offersMspOwner('limited_partner')).toBe(false);
    expect(offersMspOwner('org')).toBe(false);
    expect(offersMspOwner('unknown')).toBe(false);
  });
  it('partner users choose an organization; an org user cannot', () => {
    expect(offersOrgChoice('full_partner')).toBe(true);
    expect(offersOrgChoice('limited_partner')).toBe(true);
    expect(offersOrgChoice('org')).toBe(false);
  });
});

describe('createOwnerBody', () => {
  it('MSP-managed sends ownerScope partner only, for a full-access partner', () => {
    expect(createOwnerBody({ kind: 'msp' }, 'full_partner')).toEqual({ ownerScope: 'partner' });
  });
  it('never sends ownerScope partner for a caller who may not manage MSP-wide policies', () => {
    expect(createOwnerBody({ kind: 'msp' }, 'limited_partner')).toBeNull();
    expect(createOwnerBody({ kind: 'msp' }, 'org')).toBeNull();
    expect(createOwnerBody({ kind: 'msp' }, 'unknown')).toBeNull();
  });
  it('org-managed sends the org id, and nothing without one', () => {
    expect(createOwnerBody({ kind: 'org', orgId: 'org-a' }, 'limited_partner')).toEqual({ orgId: 'org-a' });
    expect(createOwnerBody({ kind: 'org', orgId: null }, 'limited_partner')).toBeNull();
  });
});
