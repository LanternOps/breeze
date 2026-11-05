import type { OemOutcome } from '@breeze/shared';
import type { DeviceOemUpdateStatus } from '../../db/schema';

export type OemDisplayState =
  | 'up_to_date'
  | 'overdue'
  | 'failing'
  | 'not_supported'
  | 'not_managed'
  | 'waiting_for_reboot'
  | 'reboot_overdue';

export type OemDisplayStatus = Pick<
  DeviceOemUpdateStatus,
  'applicability' | 'lastOutcome' | 'occurrenceKey' | 'lastSuccessAt' | 'rebootPendingSince'
>;

/** Nights a pending vendor reboot is held and retried before the tech sees **Reboot overdue** (spec 4.5). */
export const OEM_REBOOT_OVERDUE_NIGHTS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The vendor's tool answered and the run counts for its occurrence. */
const FINISHED_OUTCOMES: ReadonlySet<OemOutcome> = new Set(['success', 'success_reboot_required', 'no_updates']);

/** A tech has to look. `blocked_on_battery` and `retry_later` retry by themselves, so they are not here. */
const FAILING_OUTCOMES: ReadonlySet<OemOutcome> = new Set([
  'failed',
  'partial',
  'tool_unavailable',
  'interrupted',
  'blocked_no_recovery_key',
]);

/**
 * What one device shows, from its status row, whether a policy link applies, and
 * where the schedule is. Pure, so the device section and the fleet view count the
 * same way. Reboot states come ahead of the policy check because a Run Now can
 * leave a reboot owed on a device no policy manages.
 *
 * A device with a policy that has never run and still has nights left has no
 * evidence either way, so it reads `not_managed` rather than up to date or overdue.
 */
export function deriveOemDisplayState(input: {
  status: OemDisplayStatus | null;
  linkEnabled: boolean;
  occurrence: { occurrenceKey: string; isPastLastNight: boolean } | null;
  now: Date;
}): OemDisplayState {
  const { status, linkEnabled, occurrence, now } = input;

  if (status?.applicability === 'not_supported') return 'not_supported';

  if (status?.rebootPendingSince) {
    const heldMs = now.getTime() - status.rebootPendingSince.getTime();
    return heldMs >= OEM_REBOOT_OVERDUE_NIGHTS * DAY_MS ? 'reboot_overdue' : 'waiting_for_reboot';
  }

  if (!linkEnabled || status?.applicability === 'not_applicable') return 'not_managed';

  if (status?.lastOutcome && FAILING_OUTCOMES.has(status.lastOutcome)) return 'failing';

  const finishedThisOccurrence = Boolean(
    status?.lastOutcome
    && FINISHED_OUTCOMES.has(status.lastOutcome)
    && occurrence
    && status.occurrenceKey === occurrence.occurrenceKey,
  );
  if (finishedThisOccurrence) return 'up_to_date';
  if (occurrence?.isPastLastNight) return 'overdue';
  return status?.lastSuccessAt ? 'up_to_date' : 'not_managed';
}
