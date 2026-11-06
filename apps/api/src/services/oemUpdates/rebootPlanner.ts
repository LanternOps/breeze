/**
 * Overnight reboot planner for vendor updates (#11065 W06, spec §4.5).
 *
 * `executeReboot` alone does not hold a maintenance window: an inherited patch
 * grace can be 1440 minutes, and `computeRebootDeadline` never pulls the
 * deadline in front of the scheduled time. The overnight rules are:
 *
 * - The restart begins inside the window. A policy grace that does not fit is
 *   replaced by the 15-minute default, or what is left of the window, never
 *   by the window's last minute.
 * - The deadline is the window close, with `deadlineAction: 'hold'`: an agent
 *   that cannot begin the restart by then drops it and reports it held. It is
 *   never forced into the working day.
 * - No room left, or outside the window, is a hold until the next opening:
 *   tomorrow night's, computed in device time, not next month's occurrence.
 * - An agent too old to honour the hold is never sent one: it ignores the key
 *   and would force the restart late.
 *
 * Grace, deferral and prompt text come from `resolveRebootPlan` and are passed
 * through; nothing here copies them. Pure: no DB, no clock, no queue. The
 * scheduler (W07) is the caller.
 */
import { agentSupportsOemRebootHold } from '@breeze/shared';
import { clampRebootDelayMinutes, type RebootDeferralSettings } from '../patchRebootHandler';

/** The overnight grace when the patch policy's does not fit the window (spec §4.5). */
export const OEM_REBOOT_GRACE_MINUTES = 15;

/** Less room than this before the margin is no room: the restart waits for tomorrow. */
export const OEM_REBOOT_MIN_GRACE_MINUTES = 5;

/**
 * Kept free at the end of the window, for delivery and a device clock a little
 * behind ours, so a restart scheduled to fit is not dropped as held on arrival.
 */
export const OEM_REBOOT_WINDOW_MARGIN_MINUTES = 5;

const MINUTE_MS = 60_000;

export type OvernightRebootInput = {
  now: Date;
  /** Tonight's window, as instants. */
  windowStart: Date;
  windowEnd: Date;
  /** The device's effective timezone: the next night is computed in it. */
  timezone: string;
  /** From `resolveRebootPlan(...).delayMinutes`. */
  patchDelayMinutes: number;
  /** From `resolveRebootPlan(...).deferral`; passed through unchanged. */
  deferral: RebootDeferralSettings;
  agentVersion: string | null | undefined;
};

export type OvernightRebootHoldReason = 'outside_window' | 'no_room' | 'agent_too_old';

export type OvernightRebootPlan =
  | {
      action: 'dispatch';
      delayMinutes: number;
      deferral: RebootDeferralSettings;
      /** The deadline the agent holds to (executeReboot's `windowEndsAt`). */
      windowEndsAt: Date;
      deadlineAction: 'hold';
    }
  | { action: 'hold'; reason: OvernightRebootHoldReason; retryAt: Date };

export function planOvernightReboot(input: OvernightRebootInput): OvernightRebootPlan {
  const { now, windowStart, windowEnd, timezone } = input;
  if (!(windowEnd.getTime() > windowStart.getTime())) {
    throw new RangeError(
      `overnight reboot window ends (${windowEnd.toISOString()}) before it starts (${windowStart.toISOString()})`,
    );
  }
  const nowMs = now.getTime();

  if (nowMs < windowStart.getTime()) {
    // Tonight's window has not opened: wait for it rather than skip a night.
    return { action: 'hold', reason: 'outside_window', retryAt: windowStart };
  }
  const tomorrow = nextWindowStartAfter(windowStart, timezone, now);
  if (!agentSupportsOemRebootHold(input.agentVersion)) {
    return { action: 'hold', reason: 'agent_too_old', retryAt: tomorrow };
  }
  if (nowMs >= windowEnd.getTime()) {
    return { action: 'hold', reason: 'outside_window', retryAt: tomorrow };
  }

  const roomMinutes = Math.floor((windowEnd.getTime() - nowMs) / MINUTE_MS) - OEM_REBOOT_WINDOW_MARGIN_MINUTES;
  if (roomMinutes < OEM_REBOOT_MIN_GRACE_MINUTES) {
    return { action: 'hold', reason: 'no_room', retryAt: tomorrow };
  }

  // clampRebootDelayMinutes turns an unusable value into the safe default, never
  // into the shortest notice.
  const policyGrace = clampRebootDelayMinutes(input.patchDelayMinutes);
  const delayMinutes =
    policyGrace <= roomMinutes ? policyGrace : Math.min(OEM_REBOOT_GRACE_MINUTES, roomMinutes);

  return {
    action: 'dispatch',
    delayMinutes,
    deferral: input.deferral,
    windowEndsAt: windowEnd,
    deadlineAction: 'hold',
  };
}

/**
 * The first opening of this window strictly after `after`: the same wall-clock
 * time as `windowStart` on a later night, in the device's timezone. A night
 * whose wall-clock start falls in a spring-forward gap opens at the next valid
 * instant.
 */
export function nextWindowStartAfter(windowStart: Date, timezone: string, after: Date): Date {
  const start = localParts(windowStart, timezone);
  // Begin from whichever local date is later, so a window several nights old
  // does not walk forward one night at a time.
  const from = after.getTime() > windowStart.getTime() ? localParts(after, timezone) : start;
  for (let offset = -1; offset <= 3; offset += 1) {
    const day = new Date(Date.UTC(from.year, from.month - 1, from.day + offset));
    const candidate = zonedWallClockToUtc(
      {
        year: day.getUTCFullYear(),
        month: day.getUTCMonth() + 1,
        day: day.getUTCDate(),
        hour: start.hour,
        minute: start.minute,
      },
      timezone,
    );
    if (candidate.getTime() > after.getTime() && candidate.getTime() > windowStart.getTime()) return candidate;
  }
  // Unreachable for any IANA zone: four consecutive nights cannot all be at or before `after`.
  throw new RangeError(`no window opening after ${after.toISOString()} in ${timezone}`);
}

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number };

function localParts(instant: Date, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string) => Number.parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') };
}

function zoneOffsetMsAt(instant: number, timezone: string): number {
  const p = localParts(new Date(instant), timezone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0) - Math.floor(instant / MINUTE_MS) * MINUTE_MS;
}

/**
 * The instant of a wall-clock time in `timezone`. The same rule as the patch
 * scheduler's (jobs/patchSchedulerWorker.ts): a time inside a spring-forward gap
 * moves forward into it, and an ambiguous fall-back time is its first occurrence.
 */
function zonedWallClockToUtc(parts: LocalParts, timezone: string): Date {
  const wallAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  const firstOffset = zoneOffsetMsAt(wallAsUtc, timezone);
  const firstCandidate = wallAsUtc - firstOffset;
  const secondOffset = zoneOffsetMsAt(firstCandidate, timezone);
  if (secondOffset === firstOffset) return new Date(firstCandidate);
  const secondCandidate = wallAsUtc - secondOffset;
  if (zoneOffsetMsAt(secondCandidate, timezone) === secondOffset) return new Date(secondCandidate);
  return new Date(Math.max(firstCandidate, secondCandidate));
}
