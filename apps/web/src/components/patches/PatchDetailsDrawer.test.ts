import { describe, expect, it } from 'vitest';
import { projectRingAutoApproval } from './PatchDetailsDrawer';
import type { Patch } from './PatchList';
import type { UpdateRingItem } from './UpdateRingList';

const patch = (o: Partial<Patch> = {}): Patch => ({
  id: 'p', title: 't', severity: 'critical', source: 'microsoft', os: 'windows',
  releaseDate: '2026-04-01T00:00:00.000Z', approvalStatus: 'pending', ...o,
});
const ring = (a: Partial<NonNullable<UpdateRingItem['autoApprove']>> = {}, o: Partial<UpdateRingItem> = {}): UpdateRingItem => ({
  id: 'r', name: 'R', enabled: true, ringOrder: 0, deferralDays: 0, gracePeriodHours: 0,
  autoApprove: { enabled: true, severities: ['critical'], deferralDays: 7, ...a }, ...o,
});

describe('projectRingAutoApproval (#9544)', () => {
  it('anchors on release date + deferral days', () => {
    const r = projectRingAutoApproval(patch(), ring());
    expect(r).toEqual({ kind: 'date', at: new Date('2026-04-08T00:00:00.000Z'), days: 7 });
  });

  it('is manual for disabled ring, disabled gate, empty or non-matching severities', () => {
    expect(projectRingAutoApproval(patch(), ring({}, { enabled: false })).kind).toBe('manual');
    expect(projectRingAutoApproval(patch(), ring({ enabled: false })).kind).toBe('manual');
    expect(projectRingAutoApproval(patch(), ring({ severities: [] })).kind).toBe('manual');
    expect(projectRingAutoApproval(patch({ severity: 'low' }), ring()).kind).toBe('manual');
  });

  it('handles unrated only with the opt-in', () => {
    expect(projectRingAutoApproval(patch({ severity: 'unrated' }), ring()).kind).toBe('manual');
    expect(projectRingAutoApproval(patch({ severity: 'unrated' }), ring({ autoApproveUnrated: true })).kind).toBe('date');
  });

  it('is immediate with no deferral (even with no release date)', () => {
    expect(projectRingAutoApproval(patch({ releaseDate: '' }), ring({ deferralDays: 0 })).kind).toBe('immediate');
  });

  it('third-party needs the toggle, skips severity, and uses its own deferral (0 is respected)', () => {
    const tp = patch({ source: 'third_party', severity: 'low' });
    expect(projectRingAutoApproval(tp, ring({ thirdPartyApps: false })).kind).toBe('manual');
    expect(projectRingAutoApproval(tp, ring({ thirdPartyApps: true, thirdPartyDeferralDays: 3 }))).toMatchObject({ kind: 'date', days: 3 });
    expect(projectRingAutoApproval(tp, ring({ thirdPartyApps: true, thirdPartyDeferralDays: null }))).toMatchObject({ kind: 'date', days: 7 });
    expect(projectRingAutoApproval(tp, ring({ thirdPartyApps: true, thirdPartyDeferralDays: 0 })).kind).toBe('immediate');
  });

  it('first-seen fallback applies to linux/third-party only; release date wins', () => {
    const seen = '2026-05-01T00:00:00.000Z';
    expect(projectRingAutoApproval(patch({ source: 'linux', releaseDate: '', firstSeenAt: seen }), ring()))
      .toMatchObject({ kind: 'date', at: new Date('2026-05-08T00:00:00.000Z') });
    expect(projectRingAutoApproval(patch({ releaseDate: '', firstSeenAt: seen }), ring()).kind).toBe('needsDate');
    expect(projectRingAutoApproval(patch({ source: 'linux', firstSeenAt: seen }), ring()))
      .toMatchObject({ at: new Date('2026-04-08T00:00:00.000Z') });
    expect(projectRingAutoApproval(patch({ releaseDate: 'garbage' }), ring()).kind).toBe('needsDate');
  });
});
