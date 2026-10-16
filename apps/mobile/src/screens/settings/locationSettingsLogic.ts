import type { LocationPermissionState } from '../../services/locationPermission';

/**
 * Copy and visibility rules for the Settings "Location suggestions" row and
 * the first-run explainer card. Pure: the components render these and run the
 * action; the OS dialog only ever appears from the row's or the card's own tap.
 *
 * Copy rule: never say "tracking".
 */

export type LocationRowAction = 'request' | 'open-settings' | 'none';

export type LocationRowCopy =
  | { visible: false }
  | { visible: true; status: string; description: string; action: LocationRowAction };

const DESCRIPTION =
  'Suggest a timer when you arrive at a client site. Your location is checked on this phone only.';

export function locationRowCopy(
  state: LocationPermissionState,
  partnerEnabled: boolean
): LocationRowCopy {
  if (!partnerEnabled) return { visible: false };
  switch (state) {
    case 'granted':
      return { visible: true, status: 'On', description: DESCRIPTION, action: 'none' };
    case 'granted-approximate':
      return {
        visible: true,
        status: 'Precise location is off — suggestions need it',
        description: DESCRIPTION,
        action: 'open-settings',
      };
    case 'denied-blocked':
      return {
        visible: true,
        status: 'Location is off for Breeze — open Settings',
        description: DESCRIPTION,
        action: 'open-settings',
      };
    case 'services-off':
      return {
        visible: true,
        status: 'Location is off on this phone — open Settings',
        description: DESCRIPTION,
        action: 'open-settings',
      };
    case 'undetermined':
    case 'denied-can-ask':
      return { visible: true, status: 'Turn on', description: DESCRIPTION, action: 'request' };
  }
}

export const EXPLAINER_REOFFER_MS = 30 * 24 * 3600_000;

export const EXPLAINER_COPY = {
  title: 'Suggest a timer on arrival',
  body: 'Breeze can suggest starting a timer when you arrive at a client site. Your location is checked on this phone only and never sent to Breeze.',
  primary: 'Turn on',
  secondary: 'Not now',
} as const;

export function explainerVisible(input: {
  partnerEnabled: boolean;
  state: LocationPermissionState;
  dismissedAtMs: number | null;
  nowMs: number;
}): boolean {
  if (!input.partnerEnabled || input.state !== 'undetermined') return false;
  return input.dismissedAtMs === null || input.nowMs - input.dismissedAtMs >= EXPLAINER_REOFFER_MS;
}
