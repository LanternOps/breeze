import type { CachedSite, Fix } from '../../services/arrivalMatch';
import type { LocationSitesSnapshot } from '../../services/locationSites';

/**
 * Pure rules for "Save my current location as <site>": which sites can be
 * pinned from this screen, whether the fix is precise enough, and the failure
 * copy. The only network write that ever carries a coordinate — and only on an
 * explicit tap.
 */

/** A pin is stored for everyone, so it has to be a good one. */
export const PIN_MAX_ACCURACY_M = 100;

/** The org's sites that have no pin yet — empty unless this user may pin and the feature is on. */
export function pinTargets(
  snapshot: LocationSitesSnapshot | null,
  orgId: string | null
): CachedSite[] {
  if (snapshot === null || orgId === null) return [];
  if (!snapshot.enabled || !snapshot.canSetLocation) return [];
  return snapshot.sites.filter(
    (s) => s.orgId === orgId && (s.latitude === null || s.longitude === null)
  );
}

export type PinOutcome = { ok: true } | { ok: false; message: string };

export function pinPreflight(fix: Fix | null): PinOutcome {
  if (fix === null || fix.accuracyM === null || fix.accuracyM > PIN_MAX_ACCURACY_M) {
    return {
      ok: false,
      message: "Location isn't precise enough here. Step outside or near a window and try again.",
    };
  }
  return { ok: true };
}

export function pinButtonLabel(site: Pick<CachedSite, 'name'>): string {
  return `Save my current location as ${site.name}`;
}

export const PIN_SUCCESS_TOAST = 'Saved. Breeze will suggest a timer next time you\'re here.';

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as { status?: unknown; statusCode?: unknown };
  if (typeof e.statusCode === 'number') return e.statusCode;
  return typeof e.status === 'number' ? e.status : undefined;
}

export function pinFailureMessage(error: unknown): { message: string; invalidate: boolean } {
  const status = statusOf(error);
  if (status === 403) {
    return { message: "You don't have permission to set site locations.", invalidate: true };
  }
  if (status === 404) {
    return { message: 'That site is no longer available.', invalidate: true };
  }
  return { message: "Couldn't save the location. Try again.", invalidate: false };
}
