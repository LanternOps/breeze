import { haversineMeters } from './geo';

/**
 * Pure arrival-matching and suppression rules. No storage, no native modules:
 * the caller feeds in the fix, the cached site list and the remembered
 * dismissals, and gets back a decision. The phone's position never leaves this
 * function — it is compared locally and discarded.
 */

/** A fix worse than this cannot say which site the technician is at. */
export const MAX_FIX_ACCURACY_M = 500;
export const DISMISS_SUPPRESS_MS = 4 * 3600_000;
export const RECENT_STOP_SUPPRESS_MS = 30 * 60_000;
export const READ_DEBOUNCE_MS = 5 * 60_000;

export type SiteCandidate = {
  siteId: string;
  orgId: string;
  orgName: string;
  siteName: string;
  distanceM: number;
};

export type Fix = {
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  atMs: number;
};

export type CachedSite = {
  id: string;
  orgId: string;
  orgName: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  geofenceRadiusM: number | null;
};

/** Key for "the same set of candidates", used to remember which one was picked last time. */
export function groupKey(siteIds: string[]): string {
  return [...siteIds].sort().join(',');
}

/** Sites within `max(radius, fix accuracy)` of the fix, nearest first. */
export function matchCandidates(
  fix: Fix,
  sites: CachedSite[],
  defaultRadiusM: number
): SiteCandidate[] {
  const out: SiteCandidate[] = [];
  for (const site of sites) {
    if (site.latitude === null || site.longitude === null) continue;
    const distanceM = haversineMeters(fix, { latitude: site.latitude, longitude: site.longitude });
    const radius = site.geofenceRadiusM ?? defaultRadiusM;
    if (distanceM <= Math.max(radius, fix.accuracyM ?? 0)) {
      out.push({
        siteId: site.id,
        orgId: site.orgId,
        orgName: site.orgName,
        siteName: site.name,
        distanceM,
      });
    }
  }
  return out.sort((a, b) => a.distanceM - b.distanceM || a.siteName.localeCompare(b.siteName));
}

export type ArrivalDecision =
  | {
      kind: 'none';
      reason: 'flag-off' | 'timer-running' | 'poor-accuracy' | 'no-candidates' | 'all-suppressed';
    }
  | { kind: 'prompt'; candidates: SiteCandidate[]; preselectSiteId: string | null };

export function decideArrival(input: {
  enabled: boolean;
  timerRunning: boolean;
  fix: Fix;
  sites: CachedSite[];
  defaultRadiusM: number;
  dismissedAt: Record<string, number>;
  lastStopAt: Record<string, number>;
  lastPick: Record<string, string>;
  nowMs: number;
}): ArrivalDecision {
  if (!input.enabled) return { kind: 'none', reason: 'flag-off' };
  // Starting while a timer runs would silently stop it server-side.
  if (input.timerRunning) return { kind: 'none', reason: 'timer-running' };
  if (input.fix.accuracyM === null || input.fix.accuracyM > MAX_FIX_ACCURACY_M) {
    return { kind: 'none', reason: 'poor-accuracy' };
  }

  const matched = matchCandidates(input.fix, input.sites, input.defaultRadiusM);
  if (matched.length === 0) return { kind: 'none', reason: 'no-candidates' };

  const candidates = matched.filter((c) => {
    const dismissed = input.dismissedAt[c.siteId];
    if (dismissed !== undefined && input.nowMs - dismissed < DISMISS_SUPPRESS_MS) return false;
    const stopped = input.lastStopAt[c.siteId];
    if (stopped !== undefined && input.nowMs - stopped < RECENT_STOP_SUPPRESS_MS) return false;
    return true;
  });
  if (candidates.length === 0) return { kind: 'none', reason: 'all-suppressed' };

  // Never auto-pick: a remembered pick only highlights a row.
  const remembered = input.lastPick[groupKey(candidates.map((c) => c.siteId))];
  const preselectSiteId =
    remembered !== undefined && candidates.some((c) => c.siteId === remembered)
      ? remembered
      : null;
  return { kind: 'prompt', candidates, preselectSiteId };
}

export function shouldReadPosition(
  lastReadMs: number | null,
  nowMs: number,
  manualRefresh: boolean
): boolean {
  if (manualRefresh || lastReadMs === null) return true;
  return nowMs - lastReadMs >= READ_DEBOUNCE_MS;
}

export type StopDecision = { kind: 'none' } | { kind: 'prompt'; siteId: string };

/** Offer to stop a location-started timer after two far reads at least one debounce apart. */
export function decideStillHere(input: {
  running: { source: string | null; siteId: string | null } | null;
  site: CachedSite | null;
  defaultRadiusM: number;
  /** Reads taken away from the site, oldest first. Re-checked here against 2× radius. */
  farReads: Array<{ atMs: number; distanceM: number }>;
}): StopDecision {
  const { running, site } = input;
  if (!running || running.source !== 'location' || !running.siteId || !site) {
    return { kind: 'none' };
  }
  const farThreshold = 2 * (site.geofenceRadiusM ?? input.defaultRadiusM);
  const far = input.farReads.filter((r) => r.distanceM > farThreshold);
  if (far.length < 2) return { kind: 'none' };
  const spanMs = far[far.length - 1].atMs - far[0].atMs;
  return spanMs >= READ_DEBOUNCE_MS ? { kind: 'prompt', siteId: running.siteId } : { kind: 'none' };
}
