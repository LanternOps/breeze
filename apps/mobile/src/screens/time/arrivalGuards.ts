/**
 * Small pure guards for the arrival sheet's tap handlers, kept out of the hook
 * so the rules that protect a running timer are tested.
 */

/** Starting from the sheet auto-stops a running timer server-side, so be strict. */
export function canStartFromArrival(input: {
  storeRunning: boolean;
  /** 'unreadable' = the device-local timer record could not be read: fail closed. */
  localTimer: 'none' | 'present' | 'unreadable';
}): boolean {
  return !input.storeRunning && input.localTimer === 'none';
}

/** The "Still at X?" Stop must act on the timer the sheet was shown for, not whatever runs now. */
export function stopTargetMatches(
  running: { source?: string | null; siteId?: string | null } | null,
  siteId: string
): boolean {
  return running !== null && running.source === 'location' && running.siteId === siteId;
}

export function entryKeyOf(
  running: { id: string | null; localId: string | null } | null
): string | null {
  return running === null ? null : (running.id ?? running.localId);
}
