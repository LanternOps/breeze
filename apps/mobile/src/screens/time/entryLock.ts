import type { TimeEntry } from '../../services/timeEntries';

/**
 * Which edits the server will still accept on a timesheet row.
 *
 * Rendering a control the API refuses wastes the technician's time and reads as
 * a bug — but hiding one the API allows strands them, which is the mistake this
 * module fixes. `BILLED_LOCKED_ENTRY_FIELDS` (apps/api/src/services/
 * timeEntryService.ts) is `startedAt, endedAt, isBillable, hourlyRate,
 * billingStatus, ticketId`: `description` is deliberately excluded, and the
 * 409 says so in as many words — "This entry has been invoiced; only its
 * description can change". An approved row is different: `assertCanMutate`
 * rejects EVERY field for a non-approver, so it is fully read-only.
 *
 * Pure module so the affordance matrix is unit-testable.
 */
export interface EntryLock {
  canEditDescription: boolean;
  canToggleBillable: boolean;
  /** Short badge for the row's meta line, or null when nothing is locked. */
  badge: string | null;
  /** Sentence explaining what is still possible, or null. */
  note: string | null;
}

export function entryLock(entry: Pick<TimeEntry, 'isApproved' | 'billingStatus'>): EntryLock {
  if (entry.isApproved) {
    return {
      canEditDescription: false,
      canToggleBillable: false,
      badge: 'Approved',
      note: 'Approved — locked. Ask an approver to reopen it.',
    };
  }

  if (entry.billingStatus === 'billed') {
    return {
      canEditDescription: true,
      canToggleBillable: false,
      badge: 'Billed',
      note: 'Invoiced — the times and billable flag are frozen, but the description can still be corrected.',
    };
  }

  return { canEditDescription: true, canToggleBillable: true, badge: null, note: null };
}
