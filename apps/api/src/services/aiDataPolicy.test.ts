import { describe, expect, it } from 'vitest';
import { mergeAiDataPolicies, levelRank } from './aiDataPolicy';
import type { AiDataPolicyRow } from '../db/schema/aiDataPolicies';

const row = (p: Partial<AiDataPolicyRow>): AiDataPolicyRow => ({
  id: 'x', orgId: null, partnerId: null, deviceFileReadLevel: null, toolOutputRetentionDays: null,
  createdBy: null, createdAt: new Date(), updatedAt: new Date(), ...p,
});

describe('mergeAiDataPolicies', () => {
  it('defaults when no rows', () => {
    expect(mergeAiDataPolicies(null, null)).toEqual({
      deviceFileReadLevel: 'no_user_profiles', toolOutputRetentionDays: 30,
      source: { deviceFileReadLevel: 'default', toolOutputRetentionDays: 'default' },
    });
  });
  it('partner row overrides defaults, NULL retention means keep forever', () => {
    const r = mergeAiDataPolicies(row({ partnerId: 'p', deviceFileReadLevel: 'any_with_approval', toolOutputRetentionDays: null }), null);
    expect(r.deviceFileReadLevel).toBe('any_with_approval');
    expect(r.toolOutputRetentionDays).toBeNull();
    expect(r.source.toolOutputRetentionDays).toBe('partner');
  });
  it('org row tightens', () => {
    const r = mergeAiDataPolicies(
      row({ partnerId: 'p', deviceFileReadLevel: 'any_with_approval', toolOutputRetentionDays: 90 }),
      row({ orgId: 'o', deviceFileReadLevel: 'off', toolOutputRetentionDays: 7 }),
    );
    expect(r).toEqual({
      deviceFileReadLevel: 'off', toolOutputRetentionDays: 7,
      source: { deviceFileReadLevel: 'org', toolOutputRetentionDays: 'org' },
    });
  });
  it('a looser org row is ignored (partner tightened after the org row was written)', () => {
    const r = mergeAiDataPolicies(
      row({ partnerId: 'p', deviceFileReadLevel: 'off', toolOutputRetentionDays: 7 }),
      row({ orgId: 'o', deviceFileReadLevel: 'any_with_approval', toolOutputRetentionDays: 90 }),
    );
    expect(r.deviceFileReadLevel).toBe('off');
    expect(r.source.deviceFileReadLevel).toBe('partner');
    expect(r.toolOutputRetentionDays).toBe(7);
  });
  it('org retention always wins over a partner NULL (unbounded)', () => {
    const r = mergeAiDataPolicies(row({ partnerId: 'p', toolOutputRetentionDays: null }), row({ orgId: 'o', toolOutputRetentionDays: 14 }));
    expect(r.toolOutputRetentionDays).toBe(14);
  });
  it('org NULL inherits', () => {
    const r = mergeAiDataPolicies(row({ partnerId: 'p', deviceFileReadLevel: 'off' }), row({ orgId: 'o' }));
    expect(r.deviceFileReadLevel).toBe('off');
    expect(r.source.deviceFileReadLevel).toBe('partner');
  });
  it('levelRank orders off < no_user_profiles < any_with_approval', () => {
    expect(levelRank('off')).toBeLessThan(levelRank('no_user_profiles'));
    expect(levelRank('no_user_profiles')).toBeLessThan(levelRank('any_with_approval'));
  });
});
