import { describe, expect, it } from 'vitest';

import {
  concernActionFailureCopy,
  concernFeedbackState,
  feedbackFailureCopy,
  severityLabel,
  snoozeOptions,
  statusLabel,
} from './wispConcernCopy';

const rec = (nudgeCount: number, feedback: 'useful' | 'not_useful' | null = null) => ({
  recipient: { nudgeCount, snoozedUntil: null, feedback },
});

describe('labels', () => {
  it('severity and status', () => {
    expect((['info', 'low', 'medium', 'high'] as const).map(severityLabel)).toEqual(['Info', 'Low', 'Medium', 'High']);
    expect((['open', 'snoozed', 'resolved', 'dismissed'] as const).map(statusLabel)).toEqual([
      'Open',
      'Snoozed',
      'Resolved',
      'Dismissed',
    ]);
  });
});

describe('snoozeOptions', () => {
  const day = 24 * 3600 * 1000;
  it('three ascending future options', () => {
    const now = new Date('2026-10-19T12:00:00Z'); // Monday
    const o = snoozeOptions(now);
    expect(o).toHaveLength(3);
    expect(o.map((x) => x.label)).toEqual(['1 hour', 'Tomorrow 9:00', 'Next Monday 9:00']);
    expect(Date.parse(o[0].until)).toBe(now.getTime() + 3600_000);
    const t = o.map((x) => Date.parse(x.until));
    expect(t[0]).toBeGreaterThan(now.getTime());
    expect(t[1]).toBeGreaterThan(t[0]);
    expect(t[2]).toBeGreaterThan(t[1]);
  });
  it('Monday gives Monday a week later', () => {
    const d = new Date(snoozeOptions(new Date('2026-10-19T12:00:00Z'))[2].until);
    expect(d.getDay()).toBe(1);
    expect(d.getDate()).toBe(26);
    expect(d.getHours()).toBe(9);
  });
  it('Sunday pushes Next Monday a week past Tomorrow', () => {
    const o = snoozeOptions(new Date('2026-10-18T16:00:00Z')); // Sun 12:00 NY
    const tomorrow = new Date(o[1].until);
    const mon = new Date(o[2].until);
    expect(tomorrow.getDay()).toBe(1);
    expect(mon.getDay()).toBe(1);
    expect(Math.round((mon.getTime() - tomorrow.getTime()) / day)).toBe(7);
  });
  it('mid-week next Monday', () => {
    const mon = new Date(snoozeOptions(new Date('2026-10-21T16:00:00Z'))[2].until); // Wed
    expect(mon.getDay()).toBe(1);
    expect(mon.getDate()).toBe(26);
  });
  it('stays at local 09:00 across the DST fall-back', () => {
    const o = snoozeOptions(new Date('2026-11-01T03:30:00Z')); // Sat Oct 31 23:30 NY
    const tomorrow = new Date(o[1].until);
    expect(tomorrow.getDate()).toBe(1);
    expect(tomorrow.getHours()).toBe(9);
    expect(new Date(o[2].until).getHours()).toBe(9);
  });
  it('shortly after local midnight still means the next calendar day', () => {
    const t = new Date(snoozeOptions(new Date('2026-10-19T04:30:00Z'))[1].until); // Mon 00:30 NY
    expect(t.getDate()).toBe(20);
    expect(t.getHours()).toBe(9);
  });
});

describe('failure copy', () => {
  it('concern action', () => {
    expect(concernActionFailureCopy(409)).toBe('Already handled elsewhere.');
    expect(concernActionFailureCopy(404)).toBe('Already handled elsewhere.');
    expect(concernActionFailureCopy(500)).toBe('Could not update this concern.');
    expect(concernActionFailureCopy(undefined)).toBe('Could not update this concern.');
  });
  it('feedback', () => {
    expect(feedbackFailureCopy(409)).toBe('Feedback already recorded.');
    expect(feedbackFailureCopy(404)).toBe('Already handled elsewhere.');
    expect(feedbackFailureCopy(500)).toBe('Could not send feedback.');
    expect(feedbackFailureCopy(undefined)).toBe('Could not send feedback.');
  });
});

describe('concernFeedbackState', () => {
  it('cases', () => {
    expect(concernFeedbackState({ recipient: null })).toEqual({ show: false, chosen: null, canChange: true });
    expect(concernFeedbackState(rec(0))).toMatchObject({ show: false });
    expect(concernFeedbackState(rec(2))).toEqual({ show: true, chosen: null, canChange: true });
    expect(concernFeedbackState(rec(1, 'useful'))).toEqual({ show: true, chosen: 'useful', canChange: false });
  });
});
