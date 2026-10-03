import { describe, expect, it } from 'vitest';
import {
  isEligibleAccessReviewDecider,
  type AccessReviewDeciderCandidate,
  type AccessReviewOwner,
} from './accessReviewSelfDecision';

const partnerOwner: AccessReviewOwner = { scope: 'partner', partnerId: 'p-1' };
const orgOwner: AccessReviewOwner = { scope: 'organization', orgId: 'o-1' };

const usersWrite = [{ resource: 'users', action: 'write' }];

function candidate(over: Partial<AccessReviewDeciderCandidate> = {}): AccessReviewDeciderCandidate {
  return { userId: 'u-other', status: 'active', orgAccess: null, grants: usersWrite, ...over };
}

describe('isEligibleAccessReviewDecider', () => {
  it.each([
    ['active org member with users:write', orgOwner, candidate(), true],
    ['active org member with the *:* wildcard', orgOwner, candidate({ grants: [{ resource: '*', action: '*' }] }), true],
    ['active org member with users:* ', orgOwner, candidate({ grants: [{ resource: 'users', action: '*' }] }), true],
    ['org member with only users:read', orgOwner, candidate({ grants: [{ resource: 'users', action: 'read' }] }), false],
    ['org member with no grants', orgOwner, candidate({ grants: [] }), false],
    ['invited (never accepted) org member', orgOwner, candidate({ status: 'invited' }), false],
    ['disabled org member', orgOwner, candidate({ status: 'disabled' }), false],
    ['active partner member, orgAccess=all, users:write', partnerOwner, candidate({ orgAccess: 'all' }), true],
    ['partner member with orgAccess=selected', partnerOwner, candidate({ orgAccess: 'selected' }), false],
    ['partner member with orgAccess=none', partnerOwner, candidate({ orgAccess: 'none' }), false],
    ['disabled partner member, orgAccess=all', partnerOwner, candidate({ orgAccess: 'all', status: 'disabled' }), false],
  ] as const)('%s', (_label, owner, c, expected) => {
    expect(isEligibleAccessReviewDecider(owner, c)).toBe(expected);
  });
});
