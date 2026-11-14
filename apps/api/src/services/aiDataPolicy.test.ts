import { describe, expect, it } from 'vitest';
import { mergeAiDataPolicies, levelRank } from './aiDataPolicy';
import type { AiDataPolicyRow } from '../db/schema/aiDataPolicies';

const row = (p: Partial<AiDataPolicyRow>): AiDataPolicyRow => ({
  id: 'x', orgId: null, partnerId: null, deviceFileReadLevel: null, toolOutputRetentionDays: null, transcriptRetentionDays: null,
  createdBy: null, createdAt: new Date(), updatedAt: new Date(), ...p,
});

describe('mergeAiDataPolicies', () => {
  it('defaults when no rows', () => {
    expect(mergeAiDataPolicies(null, null)).toEqual({
      deviceFileReadLevel: 'no_user_profiles', toolOutputRetentionDays: 30, transcriptRetentionDays: 365,
      source: { deviceFileReadLevel: 'default', toolOutputRetentionDays: 'default', transcriptRetentionDays: 'default' },
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
      deviceFileReadLevel: 'off', toolOutputRetentionDays: 7, transcriptRetentionDays: null,
      source: { deviceFileReadLevel: 'org', toolOutputRetentionDays: 'org', transcriptRetentionDays: 'partner' },
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

describe('mergeAiDataPolicies — transcriptRetentionDays (#4342 W4)', () => {
  const t = (partner: Partial<AiDataPolicyRow> | null, org: Partial<AiDataPolicyRow> | null) => {
    const r = mergeAiDataPolicies(partner ? row({ partnerId: 'p', ...partner }) : null, org ? row({ orgId: 'o', ...org }) : null);
    return [r.transcriptRetentionDays, r.source.transcriptRetentionDays];
  };
  it('no partner row → 365 default', () => expect(t(null, null)).toEqual([365, 'default']));
  it('partner 90 → 90 partner', () => expect(t({ transcriptRetentionDays: 90 }, null)).toEqual([90, 'partner']));
  it('partner NULL → null (keep forever)', () => expect(t({ transcriptRetentionDays: null }, null)).toEqual([null, 'partner']));
  it('partner 90 + org 30 → 30 org', () => expect(t({ transcriptRetentionDays: 90 }, { transcriptRetentionDays: 30 })).toEqual([30, 'org']));
  it('partner 90 + org 200 → 90 (an org cannot loosen)', () => expect(t({ transcriptRetentionDays: 90 }, { transcriptRetentionDays: 200 })).toEqual([90, 'partner']));
  it('partner NULL + org 60 → 60 org', () => expect(t({ transcriptRetentionDays: null }, { transcriptRetentionDays: 60 })).toEqual([60, 'org']));
  it('no partner row + org 30 → 30 org; org 400 → 365 default', () => {
    expect(t(null, { transcriptRetentionDays: 30 })).toEqual([30, 'org']);
    expect(t(null, { transcriptRetentionDays: 400 })).toEqual([365, 'default']);
  });
  it('does not change toolOutputRetentionDays', () => {
    const r = mergeAiDataPolicies(
      row({ partnerId: 'p', toolOutputRetentionDays: 45, transcriptRetentionDays: 10 }),
      row({ orgId: 'o', toolOutputRetentionDays: 20, transcriptRetentionDays: 400 }),
    );
    expect([r.toolOutputRetentionDays, r.source.toolOutputRetentionDays]).toEqual([20, 'org']);
    expect([r.transcriptRetentionDays, r.source.transcriptRetentionDays]).toEqual([10, 'partner']);
  });
});
