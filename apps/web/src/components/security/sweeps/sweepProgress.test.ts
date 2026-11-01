import { describe, expect, it } from 'vitest';
import type { SweepProgress, SweepSummary } from '@breeze/shared';
import { describeSweepProgress } from './sweepProgress';

const zero: SweepProgress = {
  queued: 0, running: 0, completed: 0, timedOut: 0, failed: 0, cancelled: 0, expired: 0, degraded: 0, ruleSetChanged: 0, threatsFound: 0,
};

function sweep(over: Partial<Omit<SweepSummary, 'progress'>> & { progress?: Partial<SweepProgress> }): SweepSummary {
  const { progress, ...rest } = over;
  return {
    id: 's1', groupId: 'g1', orgId: 'o1', orgName: 'Org', ruleSets: [{ id: 'r1', name: 'Set', version: 1 }],
    scanType: 'quick', paths: null, state: 'active', targeted: 10, skipped: {}, origin: 'web', createdBy: null,
    createdAt: '2026-10-24T00:00:00Z', expiresAt: '2026-10-25T00:00:00Z', completedAt: null,
    ...rest,
    progress: { ...zero, ...progress },
  };
}

describe('describeSweepProgress', () => {
  it('running: terminal ÷ targeted, info tone', () => {
    const r = describeSweepProgress(sweep({ progress: { completed: 3, running: 2, queued: 5 } }));
    expect(r.percent).toBe(30);
    expect(r.tone).toBe('info');
    expect(r.label).toContain('3');
    expect(r.label).toContain('10');
  });

  it('completed: 100 %, success tone', () => {
    const r = describeSweepProgress(sweep({ state: 'completed', progress: { completed: 9, timedOut: 1 } }));
    expect(r.percent).toBe(100);
    expect(r.tone).toBe('success');
  });

  it('completed with degraded coverage warns', () => {
    const r = describeSweepProgress(sweep({ state: 'completed', progress: { completed: 10, degraded: 2 } }));
    expect(r.percent).toBe(100);
    expect(r.tone).toBe('warning');
  });

  it('a failed child warns even while active', () => {
    const r = describeSweepProgress(sweep({ progress: { completed: 4, failed: 1, queued: 5 } }));
    expect(r.percent).toBe(50);
    expect(r.tone).toBe('warning');
  });

  it('cancelled with a remainder warns and counts cancelled as terminal', () => {
    const r = describeSweepProgress(sweep({ state: 'cancelled', progress: { completed: 2, cancelled: 6, running: 2 } }));
    expect(r.percent).toBe(80);
    expect(r.tone).toBe('warning');
  });

  it('expired warns', () => {
    const r = describeSweepProgress(sweep({ state: 'expired', progress: { completed: 4, expired: 6 } }));
    expect(r.percent).toBe(100);
    expect(r.tone).toBe('warning');
  });

  it('zero targeted: 0 %, never NaN', () => {
    const r = describeSweepProgress(sweep({ targeted: 0 }));
    expect(r.percent).toBe(0);
    expect(Number.isNaN(r.percent)).toBe(false);
  });

  // #10078: cancelled / failed / expired children are finished, not "done".
  it('a cancelled sweep names its cancelled devices instead of "devices done"', () => {
    const r = describeSweepProgress(sweep({ state: 'cancelled', targeted: 2, progress: { completed: 1, cancelled: 1 } }));
    expect(r.percent).toBe(100);
    expect(r.tone).toBe('warning');
    expect(r.label).toBe('2 of 2 devices finished · 1 completed · 1 cancelled');
    expect(r.label).not.toMatch(/done/);
  });

  it('a cancelled-only sweep reports no completed devices', () => {
    const r = describeSweepProgress(sweep({ state: 'cancelled', targeted: 2, progress: { cancelled: 2 } }));
    expect(r.label).toBe('2 of 2 devices finished · 2 cancelled');
  });

  it('lists every non-zero terminal state separately', () => {
    const r = describeSweepProgress(
      sweep({ state: 'expired', targeted: 10, progress: { completed: 4, timedOut: 1, failed: 2, cancelled: 1, expired: 2 } }),
    );
    expect(r.label).toBe('10 of 10 devices finished · 4 completed · 1 timed out · 2 failed · 1 cancelled · 2 expired');
  });

  it('an active sweep with nothing finished shows only the finished count', () => {
    const r = describeSweepProgress(sweep({ targeted: 2, progress: { queued: 1, running: 1 } }));
    expect(r.percent).toBe(0);
    expect(r.label).toBe('0 of 2 devices finished');
  });

  it('a single-device sweep uses the singular', () => {
    const r = describeSweepProgress(sweep({ state: 'completed', targeted: 1, progress: { completed: 1 } }));
    expect(r.label).toBe('1 of 1 device finished · 1 completed');
  });
});
