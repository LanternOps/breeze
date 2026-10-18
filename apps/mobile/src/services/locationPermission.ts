/**
 * Foreground-location permission state, as one pure mapping.
 *
 * No `expo-location` import on purpose: the callers pass the plain fields of
 * the permission response, so this stays testable under the node test env.
 *
 * Foreground ("While Using") only. Nothing here knows about background
 * location — that is a separate, held wave.
 */
export type LocationPermissionState =
  | 'undetermined'
  | 'granted'
  | 'granted-approximate'
  | 'denied-can-ask'
  | 'denied-blocked'
  | 'services-off';

export interface LocationPermissionInput {
  status: 'granted' | 'denied' | 'undetermined';
  canAskAgain: boolean;
  ios?: { scope: 'whenInUse' | 'always' | 'none' };
  android?: { accuracy: 'fine' | 'coarse' | 'none' };
}

export function toLocationPermissionState(
  perm: LocationPermissionInput,
  servicesEnabled: boolean,
  /**
   * iOS has no accuracy field on the permission response. The caller passes
   * true after two consecutive granted reads with `coords.accuracy` above the
   * arrival accuracy cutoff.
   */
  observedReducedPrecision: boolean
): LocationPermissionState {
  if (!servicesEnabled) return 'services-off';
  if (perm.status === 'granted') {
    if (observedReducedPrecision || perm.android?.accuracy === 'coarse') {
      return 'granted-approximate';
    }
    return 'granted';
  }
  if (perm.status === 'denied') {
    return perm.canAskAgain ? 'denied-can-ask' : 'denied-blocked';
  }
  return 'undetermined';
}

export interface PrecisionTracker {
  /** Record the accuracy of a granted-permission read; null = no accuracy reported. */
  note(accuracyM: number | null): void;
  /** True after two consecutive reads worse than the arrival accuracy cutoff. */
  observedReducedPrecision(): boolean;
}

/** Cutoff shared with arrivalMatch.MAX_FIX_ACCURACY_M (kept here to stay a leaf module). */
const POOR_FIX_ACCURACY_M = 500;

/**
 * iOS reports no accuracy on the permission response, so "Precise location is
 * off" is inferred from the fixes themselves: two poor reads in a row.
 */
export function createPrecisionTracker(): PrecisionTracker {
  let poorRun = 0;
  return {
    note(accuracyM) {
      poorRun = accuracyM === null || accuracyM > POOR_FIX_ACCURACY_M ? poorRun + 1 : 0;
    },
    observedReducedPrecision: () => poorRun >= 2,
  };
}

/** The arrival prompt reads the position only when precise foreground access is on. */
export function canReadForArrival(state: LocationPermissionState): boolean {
  return state === 'granted';
}
