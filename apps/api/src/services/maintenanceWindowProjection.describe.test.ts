/**
 * #10397 — `describeMaintenanceSchedule` turns stored maintenance settings into
 * the schedule the evaluator actually runs, so the AI never has to infer it
 * from a blank `windowStart` or guess which weekday a weekly window opens on.
 * Every expectation here is checked against `isInMaintenanceWindow`, the
 * function that decides suppression, rather than against a restated rule.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));

import { isInMaintenanceWindow } from './featureConfigResolver';
import { describeMaintenanceSchedule } from './maintenanceWindowProjection';

function settings(overrides: Record<string, unknown> = {}): any {
  return {
    recurrence: 'weekly',
    windowStart: null,
    durationHours: 2,
    timezone: 'UTC',
    suppressAlerts: true,
    suppressPatching: true,
    suppressAutomations: false,
    suppressScripts: false,
    rebootIfPending: false,
    ...overrides,
  };
}

// Wednesday 2026-10-28 12:00Z.
const NOW = new Date('2026-10-28T12:00:00Z');

describe('describeMaintenanceSchedule (#10397)', () => {
  it('weekly with a blank windowStart opens on Sunday at 00:00 and says the time was defaulted', () => {
    for (const windowStart of [null, '', '   ']) {
      const out = describeMaintenanceSchedule(settings({ windowStart }), NOW)!;
      expect(out.opensOn).toBe('Sunday');
      expect(out.startTime).toBe('00:00');
      expect(out.startTimeSource).toBe('default_midnight');
      expect(out.nextWindow).toEqual({ startsAt: '2026-11-01T00:00:00.000Z', endsAt: '2026-11-01T02:00:00.000Z' });
      // The evaluator agrees: open inside, closed just after.
      expect(isInMaintenanceWindow(settings({ windowStart }), new Date('2026-11-01T01:59:00Z')).active).toBe(true);
      expect(isInMaintenanceWindow(settings({ windowStart }), new Date('2026-11-01T02:00:00Z')).active).toBe(false);
    }
  });

  it('weekly 02:00 America/Denver: Sunday 02:00 local, next window as an instant', () => {
    const s = settings({ windowStart: '02:00', timezone: 'America/Denver' });
    const out = describeMaintenanceSchedule(s, NOW)!;
    expect(out).toMatchObject({
      recurrence: 'weekly',
      opensOn: 'Sunday',
      startTime: '02:00',
      startTimeSource: 'windowStart',
      durationHours: 2,
      timezone: 'America/Denver',
    });
    // 2026-11-01 is the US fall-back Sunday; 02:00 MST = 09:00Z.
    expect(out.nextWindow!.startsAt).toBe('2026-11-01T09:00:00.000Z');
    expect(isInMaintenanceWindow(s, new Date(out.nextWindow!.startsAt)).active).toBe(true);
    expect(out.summary).toBe('Every Sunday at 02:00 for 2h (America/Denver)');
  });

  it('monthly opens on the 1st', () => {
    const s = settings({ recurrence: 'monthly', windowStart: '03:30', durationHours: 4 });
    const out = describeMaintenanceSchedule(s, NOW)!;
    expect(out.opensOn).toBe('day 1 of each month');
    expect(out.startTime).toBe('03:30');
    expect(out.nextWindow).toEqual({ startsAt: '2026-11-01T03:30:00.000Z', endsAt: '2026-11-01T07:30:00.000Z' });
    expect(out.summary).toBe('Day 1 of each month at 03:30 for 4h (UTC)');
  });

  it('daily opens every day', () => {
    const out = describeMaintenanceSchedule(settings({ recurrence: 'daily', windowStart: '13:00' }), NOW)!;
    expect(out.opensOn).toBe('every day');
    expect(out.nextWindow!.startsAt).toBe('2026-10-28T13:00:00.000Z');
    expect(out.summary).toBe('Every day at 13:00 for 2h (UTC)');
  });

  it('an unparseable recurring windowStart is flagged as the midnight fallback the evaluator applies', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = settings({ windowStart: '2026-03-15T02:00Z' });
    const out = describeMaintenanceSchedule(s, NOW)!;
    expect(out.startTime).toBe('00:00');
    expect(out.startTimeSource).toBe('invalid_windowStart_fell_back_to_midnight');
    expect(isInMaintenanceWindow(s, new Date('2026-11-01T00:30:00Z')).active).toBe(true);
    warn.mockRestore();
  });

  it('once: opens on its date, and an already-past window has no next window', () => {
    const future = describeMaintenanceSchedule(settings({ recurrence: 'once', windowStart: '2026-11-05T22:15' }), NOW)!;
    expect(future.opensOn).toBe('2026-11-05');
    expect(future.startTime).toBe('22:15');
    expect(future.nextWindow!.startsAt).toBe('2026-11-05T22:15:00.000Z');
    expect(future.summary).toBe('Once on 2026-11-05 at 22:15 for 2h (UTC)');

    const past = describeMaintenanceSchedule(settings({ recurrence: 'once', windowStart: '2026-01-05T22:15' }), NOW)!;
    expect(past.nextWindow).toBeNull();
  });

  it('once without a windowStart never opens', () => {
    const out = describeMaintenanceSchedule(settings({ recurrence: 'once', windowStart: '' }), NOW)!;
    expect(out.opensOn).toBeNull();
    expect(out.startTime).toBeNull();
    expect(out.nextWindow).toBeNull();
    expect(out.summary).toMatch(/never opens/i);
  });

  it('returns null for settings that are not a maintenance shape', () => {
    expect(describeMaintenanceSchedule(null, NOW)).toBeNull();
    expect(describeMaintenanceSchedule({ recurrence: 'weekly' }, NOW)).toBeNull();
    expect(describeMaintenanceSchedule(settings({ durationHours: '2' }), NOW)).toBeNull();
  });
});
