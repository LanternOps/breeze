import { describe, it, expect, vi, beforeEach } from 'vitest';

// Two SELECTs per resolve: organizations (partner lookup) then policies.
// The stub answers by call order, which is the only thing the resolver
// depends on — the OR predicate is exercised for real by the live-DB suite
// (aiScriptPoliciesPartnerRls.integration.test.ts).
const rows: Array<Record<string, unknown>> = [];
let partnerLookup: Array<{ partnerId: string | null }> = [{ partnerId: 'partner-1' }];
let selectCalls = 0;
vi.mock('../../db', () => ({
  db: {
    select: () => {
      const call = selectCalls++;
      return {
        from: () => ({
          where: () => ({ limit: async () => (call % 2 === 0 ? partnerLookup : rows) }),
        }),
      };
    },
  },
}));

import { mergeScriptPolicies, resolveEffectiveScriptPolicy, resolvePartnerCeiling } from './policy';

function partnerRow(over: Record<string, unknown> = {}) {
  return {
    id: 'p-row', orgId: null, partnerId: 'partner-1', proposingEnabled: true, unattendedAllowed: true,
    unattendedEnabled: false, maxUnattendedRiskTier: 'medium',
    unattendedAllowedClasses: ['services', 'processes', 'temp_files'], maxUnattendedPerHour: 10,
    protectedResources: { services: ['Spooler'], paths: [], registryKeys: [], deviceTags: [] },
    reviewerModel: null, ...over,
  };
}
function orgRow(over: Record<string, unknown> = {}) {
  return {
    id: 'o-row', orgId: 'org-1', partnerId: null, proposingEnabled: true, unattendedAllowed: false,
    unattendedEnabled: true, maxUnattendedRiskTier: 'medium',
    unattendedAllowedClasses: ['services', 'printing'], maxUnattendedPerHour: 4,
    protectedResources: { services: [], paths: ['C:\\Windows'], registryKeys: [], deviceTags: [] },
    reviewerModel: 'claude-sonnet-x', ...over,
  };
}

beforeEach(() => {
  rows.length = 0;
  selectCalls = 0;
  partnerLookup = [{ partnerId: 'partner-1' }];
});

describe('resolveEffectiveScriptPolicy', () => {
  it('a missing org row means the lane is OFF even with a permissive partner ceiling', async () => {
    rows.push(partnerRow());
    const eff = await resolveEffectiveScriptPolicy('org-1');
    expect(eff.unattendedEnabled).toBe(false);
    expect(eff.source.orgRowId).toBeNull();
    expect(eff.source.partnerRowId).toBe('p-row');
  });

  it('a missing partner row means the lane is OFF even with an org grant', async () => {
    rows.push(orgRow());
    const eff = await resolveEffectiveScriptPolicy('org-1');
    expect(eff.unattendedEnabled).toBe(false);
  });

  it('a partner row with unattended_allowed=false keeps the lane OFF despite an org grant', async () => {
    rows.push(partnerRow({ unattendedAllowed: false }), orgRow());
    expect((await resolveEffectiveScriptPolicy('org-1')).unattendedEnabled).toBe(false);
  });

  it('booleans AND, tiers min, classes intersect, per-hour min, protected resources union', async () => {
    rows.push(partnerRow(), orgRow());
    const eff = await resolveEffectiveScriptPolicy('org-1');
    expect(eff.unattendedEnabled).toBe(true);
    expect(eff.maxUnattendedRiskTier).toBe('medium');
    expect(eff.unattendedAllowedClasses).toEqual(['services']); // intersection, sorted
    expect(eff.maxUnattendedPerHour).toBe(4);
    expect(eff.protectedResources.services).toEqual(['Spooler']);
    expect(eff.protectedResources.paths).toEqual(['C:\\Windows']);
    expect(eff.source).toEqual({ partnerRowId: 'p-row', orgRowId: 'o-row' });
  });

  it('the org can only TIGHTEN the tier, never raise it', async () => {
    rows.push(partnerRow({ maxUnattendedRiskTier: 'low' }), orgRow({ maxUnattendedRiskTier: 'medium' }));
    expect((await resolveEffectiveScriptPolicy('org-1')).maxUnattendedRiskTier).toBe('low');
  });

  it('proposingEnabled is an AND of both rows', async () => {
    rows.push(partnerRow({ proposingEnabled: false }), orgRow({ proposingEnabled: true }));
    expect((await resolveEffectiveScriptPolicy('org-1')).proposingEnabled).toBe(false);
  });

  it('an org reviewerModel overrides the partner default; null falls back', async () => {
    rows.push(partnerRow({ reviewerModel: 'partner-model' }), orgRow({ reviewerModel: null }));
    expect((await resolveEffectiveScriptPolicy('org-1')).reviewerModel).toBe('partner-model');
    rows.length = 0;
    selectCalls = 0;
    rows.push(partnerRow({ reviewerModel: 'partner-model' }), orgRow({ reviewerModel: 'org-model' }));
    expect((await resolveEffectiveScriptPolicy('org-1')).reviewerModel).toBe('org-model');
  });

  it('with neither row present everything is off and proposing still defaults on', async () => {
    const eff = await resolveEffectiveScriptPolicy('org-1');
    expect(eff.unattendedEnabled).toBe(false);
    expect(eff.proposingEnabled).toBe(true);
    expect(eff.maxUnattendedRiskTier).toBe('low');
    expect(eff.maxUnattendedPerHour).toBe(10);
  });

  it('a missing org row narrows NOTHING: the partner ceiling passes through untouched (identity, not the defaults)', async () => {
    rows.push(partnerRow({ maxUnattendedRiskTier: 'medium', unattendedAllowedClasses: ['services', 'packages', 'browser'], maxUnattendedPerHour: 40 }));
    const eff = await resolveEffectiveScriptPolicy('org-1');
    expect(eff.unattendedEnabled).toBe(false);
    expect(eff.maxUnattendedRiskTier).toBe('medium');
    expect(eff.unattendedAllowedClasses).toEqual(['browser', 'packages', 'services']);
    expect(eff.maxUnattendedPerHour).toBe(40);
  });

  it('resolvePartnerCeiling ignores the org row entirely', async () => {
    rows.push(partnerRow({ maxUnattendedPerHour: 10, unattendedAllowedClasses: ['services', 'processes'] }));
    const ceiling = await resolvePartnerCeiling('org-1');
    expect(ceiling.maxUnattendedPerHour).toBe(10);
    expect(ceiling.unattendedAllowedClasses).toEqual(['processes', 'services']);
    expect(ceiling.unattendedEnabled).toBe(false);
  });

  it('an org with no partner still resolves (org row only, lane off)', async () => {
    partnerLookup = [{ partnerId: null }];
    rows.push(orgRow());
    const eff = await resolveEffectiveScriptPolicy('org-1');
    expect(eff.unattendedEnabled).toBe(false);
    expect(eff.source.orgRowId).toBe('o-row');
  });
});

describe('mergeScriptPolicies', () => {
  it('is the pure core the resolver and the settings routes share', () => {
    const eff = mergeScriptPolicies(partnerRow() as never, orgRow() as never);
    expect(eff.unattendedEnabled).toBe(true);
    expect(eff.unattendedAllowedClasses).toEqual(['services']);
  });
});
