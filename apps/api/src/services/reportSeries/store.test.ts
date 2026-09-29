import { describe, expect, it } from 'vitest';
import { ccWidensDelivery, ruleWidensDelivery, seriesOrgState, seriesWriteAllowed, withoutEmailRecipients } from './store';

const OWNER = '11111111-1111-4111-8111-111111111111';
const child = (userId: string | null) => ({ id: 'r', orgId: 'o', seriesRevision: 1, archivedAt: null, executionScopeUserId: userId });
const base = {
  orgStatus: 'active', orgDeletedAt: null, targeted: true, ownerEligible: true,
  ownerUserId: OWNER, child: child(OWNER), customerCount: 2, ccCount: 1, detached: false,
};

describe('seriesWriteAllowed', () => {
  it('admits only a partner-scope, org_access=all caller with a partner id', () => {
    expect(seriesWriteAllowed({ scope: 'partner', partnerId: 'p', partnerOrgAccess: 'all' })).toBe(true);
    expect(seriesWriteAllowed({ scope: 'partner', partnerId: 'p', partnerOrgAccess: 'selected' })).toBe(false);
    expect(seriesWriteAllowed({ scope: 'organization', partnerId: 'p', partnerOrgAccess: null })).toBe(false);
    expect(seriesWriteAllowed({ scope: 'system', partnerId: null, partnerOrgAccess: null })).toBe(false);
  });
});

describe('delivery widening (INDEX recipient delivery gate)', () => {
  it('a new CC address widens; a removal or a case change does not', () => {
    expect(ccWidensDelivery(['a@x.test'], ['a@x.test', 'b@x.test'])).toBe(true);
    expect(ccWidensDelivery(['a@x.test', 'b@x.test'], ['a@x.test'])).toBe(false);
    expect(ccWidensDelivery(['a@x.test'], ['A@X.test'])).toBe(false);
  });
  it('turning primaryContact on or adding a role widens; narrowing does not', () => {
    expect(ruleWidensDelivery({ primaryContact: false, roles: [] }, { primaryContact: true, roles: [] })).toBe(true);
    expect(ruleWidensDelivery({ primaryContact: true, roles: ['billing'] }, { primaryContact: true, roles: ['billing', 'technical'] })).toBe(true);
    expect(ruleWidensDelivery({ primaryContact: true, roles: ['billing'] }, { primaryContact: false, roles: [] })).toBe(false);
  });
});

describe('seriesOrgState', () => {
  it.each([
    [{ ...base }, 'active'],
    [{ ...base, orgStatus: 'suspended' }, 'ineligible'],
    [{ ...base, orgDeletedAt: new Date() }, 'ineligible'],
    [{ ...base, targeted: false }, 'excluded'],
    // W03 final review: an org holding a live standalone detached from this
    // series is never targeted; say so rather than 'excluded' (Include would be a no-op).
    [{ ...base, targeted: false, detached: true }, 'detached'],
    [{ ...base, orgStatus: 'suspended', detached: true }, 'ineligible'],
    [{ ...base, ownerEligible: false }, 'blocked_no_authority'],
    [{ ...base, child: child(null) }, 'blocked_no_authority'],
    [{ ...base, child: child('someone-else') }, 'blocked_no_authority'],
    [{ ...base, child: undefined }, 'blocked_no_authority'],
    [{ ...base, customerCount: 0, ccCount: 0 }, 'blocked_no_recipients'],
    [{ ...base, customerCount: 0, ccCount: 1 }, 'active'],
  ] as const)('%j → %s', (input, expected) => {
    expect(seriesOrgState(input)).toBe(expected);
  });
});

describe('withoutEmailRecipients', () => {
  it('drops emailRecipients from a series config (internal CC is internal_cc)', () => {
    expect(withoutEmailRecipients({ a: 1, emailRecipients: ['x@y.test'] })).toEqual({ a: 1 });
  });
});
