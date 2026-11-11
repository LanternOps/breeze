import { OEM_DISPLAY_STATES, type OemDisplayState, type OemOutcome } from '@breeze/shared';
import type { DeviceOemUpdateStatus } from '../../db/schema';
import { OEM_MAX_ATTEMPTS_PER_OCCURRENCE } from './occurrence';

export { OEM_DISPLAY_STATES };
export type { OemDisplayState };

export type OemDisplayStatus = Pick<
  DeviceOemUpdateStatus,
  'applicability' | 'lastOutcome' | 'occurrenceKey' | 'lastSuccessAt' | 'rebootPendingSince'
> & Partial<Pick<DeviceOemUpdateStatus, 'attempts'>>;

/** Nights a pending vendor reboot is held and retried before the tech sees **Reboot overdue** (spec 4.5). */
export const OEM_REBOOT_OVERDUE_NIGHTS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The vendor's tool answered and the run counts for its occurrence. */
export const FINISHED_OUTCOMES: ReadonlySet<OemOutcome> = new Set(['success', 'success_reboot_required', 'no_updates']);

/** A tech has to look. `blocked_on_battery` and `retry_later` retry by themselves, so they are not here. */
export const FAILING_OUTCOMES: ReadonlySet<OemOutcome> = new Set([
  'failed',
  'partial',
  'tool_unavailable',
  'interrupted',
  'blocked_no_recovery_key',
]);

/** See `managedSince` below. Once past the last night, `windowStart` is that night's. */
export function hadAChanceAtLastNight(
  managedSince: Date | null | undefined,
  occurrence: { windowStart?: Date } | null | undefined,
): boolean {
  return !(managedSince && occurrence?.windowStart && managedSince >= occurrence.windowStart);
}

/**
 * What one device shows, from its status row, whether a policy link applies, and
 * where the schedule is. Pure, so the device section and the fleet view count the
 * same way. Reboot states come ahead of the policy check because a Run Now can
 * leave a reboot owed on a device no policy manages.
 *
 * A device with a policy that has never run and still has nights left has no
 * evidence either way, so it reads `not_managed` rather than up to date or overdue.
 *
 * `rebootMode: 'never'` is a policy that does not reboot, so there is no hold to
 * overrun: the device waits for someone else's restart, however long that takes.
 *
 * `managedSince` is when this device came under this schedule: the latest of the
 * link's last change, its assignment and the device's enrollment. An occurrence
 * whose last night had already opened by then gave the device no chance to run, so
 * it is no evidence of a miss: a policy armed on the 28th does not turn a fleet
 * overdue, or page anyone, for nights that had passed before it existed. Once past
 * the last night `occurrence.windowStart` is that night's.
 */
export function deriveOemDisplayState(input: {
  status: OemDisplayStatus | null;
  linkEnabled: boolean;
  rebootMode?: 'overnight' | 'never';
  occurrence: { occurrenceKey: string; isPastLastNight: boolean; windowStart?: Date } | null;
  managedSince?: Date | null;
  now: Date;
}): OemDisplayState {
  const { status, linkEnabled, rebootMode, occurrence, managedSince, now } = input;

  if (status?.applicability === 'not_supported') return 'not_supported';

  if (status?.rebootPendingSince) {
    if (rebootMode === 'never') return 'waiting_for_reboot';
    const heldMs = now.getTime() - status.rebootPendingSince.getTime();
    return heldMs >= OEM_REBOOT_OVERDUE_NIGHTS * DAY_MS ? 'reboot_overdue' : 'waiting_for_reboot';
  }

  if (!linkEnabled || status?.applicability === 'not_applicable') return 'not_managed';

  const inThisOccurrence = Boolean(occurrence && status?.occurrenceKey === occurrence.occurrenceKey);
  // Spec 4.2: out of attempts it shows as Overdue, even with nights left to run.
  if (inThisOccurrence && (status?.attempts ?? 0) >= OEM_MAX_ATTEMPTS_PER_OCCURRENCE
    && !(status?.lastOutcome && FINISHED_OUTCOMES.has(status.lastOutcome))) {
    return 'overdue';
  }

  if (status?.lastOutcome && FAILING_OUTCOMES.has(status.lastOutcome)) return 'failing';

  const finishedThisOccurrence = Boolean(
    inThisOccurrence && status?.lastOutcome && FINISHED_OUTCOMES.has(status.lastOutcome),
  );
  if (finishedThisOccurrence) return 'up_to_date';
  if (occurrence?.isPastLastNight && hadAChanceAtLastNight(managedSince, occurrence)) return 'overdue';
  return status?.lastSuccessAt ? 'up_to_date' : 'not_managed';
}
