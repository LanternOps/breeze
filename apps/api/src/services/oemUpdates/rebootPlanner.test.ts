import { describe, expect, it } from 'vitest';
import { computeRebootDeadline, DEFERRAL_OFF, type RebootDeferralSettings } from '../patchRebootHandler';
import {
  OEM_REBOOT_GRACE_MINUTES,
  OEM_REBOOT_MIN_GRACE_MINUTES,
  OEM_REBOOT_WINDOW_MARGIN_MINUTES,
  planOvernightReboot,
  type OvernightRebootInput,
} from './rebootPlanner';

const MIN = 60_000;
const AGENT = '0.127.0';

// A 01:00-05:00 window on a plain night, device in UTC.
const windowStart = new Date('2026-11-18T01:00:00Z');
const windowEnd = new Date('2026-11-18T05:00:00Z');

function input(over: Partial<OvernightRebootInput> = {}): OvernightRebootInput {
  return {
    now: new Date('2026-11-18T01:10:00Z'),
    windowStart,
    windowEnd,
    timezone: 'UTC',
    patchDelayMinutes: OEM_REBOOT_GRACE_MINUTES,
    deferral: DEFERRAL_OFF,
    agentVersion: AGENT,
    ...over,
  };
}

describe('planOvernightReboot', () => {
  it('uses the default 15-minute grace, deadline action hold, and the window close', () => {
    expect(OEM_REBOOT_GRACE_MINUTES).toBe(15);
    expect(planOvernightReboot(input())).toEqual({
      action: 'dispatch',
      delayMinutes: 15,
      deferral: DEFERRAL_OFF,
      windowEndsAt: windowEnd,
      deadlineAction: 'hold',
    });
  });

  it('keeps a policy grace that fits the window', () => {
    const plan = planOvernightReboot(input({ patchDelayMinutes: 60 }));
    expect(plan).toMatchObject({ action: 'dispatch', delayMinutes: 60 });
  });

  it('grace clamps to fit the window', () => {
    // 12 minutes left, less the margin the restart needs to begin inside it.
    const now = new Date(windowEnd.getTime() - 12 * MIN);
    const plan = planOvernightReboot(input({ now }));
    expect(plan).toMatchObject({ action: 'dispatch', delayMinutes: 12 - OEM_REBOOT_WINDOW_MARGIN_MINUTES });
    if (plan.action !== 'dispatch') throw new Error('unreachable');
    expect(now.getTime() + plan.delayMinutes * MIN).toBeLessThanOrEqual(windowEnd.getTime());
  });

  it('inherited 1440 is clamped', () => {
    // A day-long patch grace would land after the window: the overnight
    // restart takes the default grace instead, not the last minute of the window.
    const plan = planOvernightReboot(input({ patchDelayMinutes: 1440 }));
    expect(plan).toMatchObject({ action: 'dispatch', delayMinutes: OEM_REBOOT_GRACE_MINUTES });

    const late = new Date(windowEnd.getTime() - 15 * MIN);
    expect(planOvernightReboot(input({ now: late, patchDelayMinutes: 1440 }))).toMatchObject({
      action: 'dispatch',
      delayMinutes: 15 - OEM_REBOOT_WINDOW_MARGIN_MINUTES,
    });
  });

  it('an unusable policy grace falls back to the default, never the shortest', () => {
    for (const bad of [Number.NaN, null, undefined, 0] as const) {
      const plan = planOvernightReboot(input({ patchDelayMinutes: bad as unknown as number }));
      if (plan.action !== 'dispatch') throw new Error(`hold for ${String(bad)}`);
      expect(plan.delayMinutes).toBeGreaterThanOrEqual(1);
    }
    expect(planOvernightReboot(input({ patchDelayMinutes: null as unknown as number }))).toMatchObject({
      delayMinutes: OEM_REBOOT_GRACE_MINUTES,
    });
  });

  it("no room left is hold until tomorrow's windowStart, not next month's", () => {
    const now = new Date(windowEnd.getTime() - (OEM_REBOOT_WINDOW_MARGIN_MINUTES + OEM_REBOOT_MIN_GRACE_MINUTES - 1) * MIN);
    expect(planOvernightReboot(input({ now }))).toEqual({
      action: 'hold',
      reason: 'no_room',
      retryAt: new Date('2026-11-19T01:00:00Z'),
    });
  });

  it('exactly enough room still dispatches', () => {
    const now = new Date(windowEnd.getTime() - (OEM_REBOOT_WINDOW_MARGIN_MINUTES + OEM_REBOOT_MIN_GRACE_MINUTES) * MIN);
    expect(planOvernightReboot(input({ now }))).toMatchObject({
      action: 'dispatch',
      delayMinutes: OEM_REBOOT_MIN_GRACE_MINUTES,
    });
  });

  it('deferral budget cannot pass windowEnd', () => {
    const deferral: RebootDeferralSettings = { allowDeferral: true, maxDeferrals: 10, deferralMinutes: 1440 };
    const plan = planOvernightReboot(input({ deferral }));
    if (plan.action !== 'dispatch') throw new Error('expected dispatch');
    // The policy's budget rides through unchanged (it comes from resolveRebootPlan) ...
    expect(plan.deferral).toBe(deferral);
    // ... and the deadline it is clamped against is the window close.
    expect(plan.windowEndsAt).toEqual(windowEnd);
    const now = input().now;
    expect(computeRebootDeadline(now, plan.delayMinutes, plan.deferral, plan.windowEndsAt).getTime())
      .toBeLessThanOrEqual(windowEnd.getTime());
  });

  it('outside the window is hold', () => {
    // Before tonight's window: wait for it, do not skip it.
    expect(planOvernightReboot(input({ now: new Date('2026-11-18T00:30:00Z') }))).toEqual({
      action: 'hold',
      reason: 'outside_window',
      retryAt: windowStart,
    });
    // After it: tomorrow night.
    expect(planOvernightReboot(input({ now: new Date('2026-11-18T09:00:00Z') }))).toEqual({
      action: 'hold',
      reason: 'outside_window',
      retryAt: new Date('2026-11-19T01:00:00Z'),
    });
    // At the close exactly.
    expect(planOvernightReboot(input({ now: windowEnd }))).toMatchObject({ action: 'hold', reason: 'outside_window' });
  });

  it('a window several nights old retries at the next opening after now', () => {
    expect(planOvernightReboot(input({ now: new Date('2026-11-21T03:00:00Z') }))).toEqual({
      action: 'hold',
      reason: 'outside_window',
      retryAt: new Date('2026-11-22T01:00:00Z'),
    });
  });

  it("tomorrow's start computed in device time across spring forward", () => {
    // New York, 01:00 EST the night DST starts (08 Mar 2026). Tomorrow's 01:00
    // is EDT: 23 hours later in UTC, not 24.
    const start = new Date('2026-03-08T06:00:00Z');
    const end = new Date('2026-03-08T09:00:00Z');
    const plan = planOvernightReboot(input({
      timezone: 'America/New_York',
      windowStart: start,
      windowEnd: end,
      now: new Date('2026-03-08T12:00:00Z'),
    }));
    expect(plan).toEqual({ action: 'hold', reason: 'outside_window', retryAt: new Date('2026-03-09T05:00:00Z') });
  });

  it("tomorrow's start computed in device time across fall back", () => {
    // 22:00 EDT on 31 Oct 2026; DST ends on 1 Nov, so tomorrow's 22:00 EST is 25 hours later.
    const start = new Date('2026-11-01T02:00:00Z');
    const end = new Date('2026-11-01T06:00:00Z');
    const plan = planOvernightReboot(input({
      timezone: 'America/New_York',
      windowStart: start,
      windowEnd: end,
      now: new Date('2026-11-01T05:56:00Z'),
    }));
    expect(plan).toEqual({ action: 'hold', reason: 'no_room', retryAt: new Date('2026-11-02T03:00:00Z') });
  });

  it('a window opening inside the spring-forward gap retries at the next valid instant', () => {
    // 02:30 local does not exist on 8 Mar 2026 in New York: the next night after
    // 7 Mar's 02:30 EST window opens at 03:30 EDT.
    const plan = planOvernightReboot(input({
      timezone: 'America/New_York',
      windowStart: new Date('2026-03-07T07:30:00Z'),
      windowEnd: new Date('2026-03-07T09:30:00Z'),
      now: new Date('2026-03-07T12:00:00Z'),
    }));
    expect(plan).toEqual({ action: 'hold', reason: 'outside_window', retryAt: new Date('2026-03-08T07:30:00Z') });
  });

  it('an agent that cannot hold is never sent an overnight reboot', () => {
    // An older agent ignores deadlineAction and would force the restart late.
    for (const agentVersion of ['0.126.0', null, undefined, '', 'dev']) {
      expect(planOvernightReboot(input({ agentVersion }))).toEqual({
        action: 'hold',
        reason: 'agent_too_old',
        retryAt: new Date('2026-11-19T01:00:00Z'),
      });
    }
  });

  it('refuses a window that ends before it starts', () => {
    expect(() => planOvernightReboot(input({ windowEnd: windowStart }))).toThrow(RangeError);
  });
});
