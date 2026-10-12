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

/** The arrival prompt reads the position only when precise foreground access is on. */
export function canReadForArrival(state: LocationPermissionState): boolean {
  return state === 'granted';
}
