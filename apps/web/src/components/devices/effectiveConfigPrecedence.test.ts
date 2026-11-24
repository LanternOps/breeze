import { describe, expect, it } from 'vitest';

import { canOpenPolicy, lostClauses, lostReason } from './effectiveConfigPrecedence';

const partnerClaims = {
  status: 'resolved' as const,
  claims: { scope: 'partner' as const, partnerId: 'p-1', orgId: null },
};
const orgClaims = {
  status: 'resolved' as const,
  claims: { scope: 'organization' as const, partnerId: null, orgId: 'org-1' },
};

const winner = (sourceLevel: string, sourcePriority: number) => ({
  sourceLevel: sourceLevel as 'device',
  sourcePriority,
});
const entry = (level: string, priority: number) => ({ level: level as 'device', priority });

describe('canOpenPolicy (#12306)', () => {
  it('links any policy for a partner-scope caller', () => {
    expect(canOpenPolicy('pol-1', { 'pol-1': 'partner' }, partnerClaims as never)).toBe(true);
    expect(canOpenPolicy('pol-1', undefined, partnerClaims as never)).toBe(true);
  });

  it('links only organization-owned policies for an org-scope caller', () => {
    expect(canOpenPolicy('pol-1', { 'pol-1': 'organization' }, orgClaims as never)).toBe(true);
    expect(canOpenPolicy('pol-1', { 'pol-1': 'partner' }, orgClaims as never)).toBe(false);
  });

  it('treats an unknown owner or unresolved claims as not openable', () => {
    expect(canOpenPolicy('pol-1', {}, orgClaims as never)).toBe(false);
    expect(canOpenPolicy('pol-1', undefined, orgClaims as never)).toBe(false);
    expect(canOpenPolicy('pol-1', { 'pol-1': 'partner' }, { status: 'unresolved' })).toBe(false);
    expect(canOpenPolicy('pol-1', { 'pol-1': 'organization' }, { status: 'unresolved' })).toBe(true);
  });
});

describe('lostClauses (#12306)', () => {
  const w = (policy: string, level: string, target: string, priority = 0) => ({
    sourcePolicyId: policy,
    sourcePolicyName: `Name ${policy}`,
    sourceLevel: level as 'device',
    sourceTargetId: target,
    sourcePriority: priority,
  });

  it('groups lost features by the winning assignment and skips what the row supplies', () => {
    const clauses = lostClauses(
      { level: 'partner', targetId: 'p-1', policyId: 'pol-p', priority: 0, featureTypes: ['a', 'b', 'c', 'd'] },
      {
        a: w('pol-o', 'organization', 'o-1'),
        b: w('pol-o', 'organization', 'o-1'),
        c: w('pol-p', 'partner', 'p-1'),
        d: w('pol-d', 'device', 'd-1'),
      },
    );
    expect(clauses).toEqual([
      { winnerPolicyId: 'pol-o', winnerPolicyName: 'Name pol-o', featureTypes: ['a', 'b'], reason: 'more_specific_level' },
      { winnerPolicyId: 'pol-d', winnerPolicyName: 'Name pol-d', featureTypes: ['d'], reason: 'more_specific_level' },
    ]);
  });

  it('ignores features with no winner or a Breeze Defaults winner', () => {
    expect(
      lostClauses(
        { level: 'site', targetId: 's', policyId: 'x', priority: 0, featureTypes: ['a', 'b'] },
        { b: w('breeze-defaults', 'default', 'default') },
      ),
    ).toEqual([]);
  });
});

describe('lostReason (#12306)', () => {
  it('a closer level wins first', () => {
    expect(lostReason(entry('organization', 0), winner('device', 9))).toBe('more_specific_level');
    expect(lostReason(entry('partner', 0), winner('organization', 5))).toBe('more_specific_level');
    expect(lostReason(entry('site', 0), winner('device_group', 0))).toBe('more_specific_level');
  });

  it('a lower priority number wins at the same level', () => {
    expect(lostReason(entry('site', 5), winner('site', 1))).toBe('lower_priority_number');
  });

  it('a tie on level and priority is decided by the earlier assignment', () => {
    expect(lostReason(entry('site', 1), winner('site', 1))).toBe('assigned_earlier');
  });
});
