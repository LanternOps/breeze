import {
  MAX_FIX_ACCURACY_M,
  decideArrival,
  decideStillHere,
  shouldReadPosition,
  type CachedSite,
  type Fix,
  type SiteCandidate,
} from '../../services/arrivalMatch';
import type { ArrivalMemory, FarRead } from '../../services/arrivalMemory';
import { haversineMeters } from '../../services/geo';
import {
  canReadForArrival,
  toLocationPermissionState,
  type LocationPermissionInput,
  type PrecisionTracker,
} from '../../services/locationPermission';
import type { LocationSitesSnapshot } from '../../services/locationSites';

/**
 * The foreground check, as one injectable function: cheap checks first, the
 * position read last, and never a permission dialog. `useArrivalPrompt` wires
 * the real dependencies; this file is what the tests drive.
 *
 * The position is compared in memory against the cached sites and discarded.
 */

export type RunningInfo = {
  id: string | null;
  localId: string | null;
  source: string | null;
  siteId: string | null;
  startedAt: string;
};

export type ArrivalCheckResult =
  | {
      kind: 'none';
      reason:
        | 'flag-off'
        | 'timer-running'
        | 'permission'
        | 'debounced'
        | 'no-fix'
        | 'still-there'
        | 'poor-accuracy'
        | 'no-candidates'
        | 'all-suppressed';
    }
  | { kind: 'arrival'; candidates: SiteCandidate[]; preselectSiteId: string | null }
  | { kind: 'stop'; siteId: string; placeName: string; runningMinutes: number };

export interface ArrivalCheckDeps {
  nowMs: () => number;
  getSnapshot: () => Promise<LocationSitesSnapshot | null>;
  /** The running timer in the Redux store, read live. */
  running: () => RunningInfo | null;
  /** A device-only timer that has not reached the store yet. */
  localTimerRunning: () => Promise<boolean>;
  /** `getForegroundPermissionsAsync` + `hasServicesEnabledAsync` — never a request. */
  getPermission: () => Promise<{ perm: LocationPermissionInput; servicesEnabled: boolean }>;
  readFix: () => Promise<Fix | null>;
  readMemory: () => Promise<ArrivalMemory>;
  readFarReads: (entryKey: string) => Promise<FarRead[]>;
  recordFarRead: (entryKey: string, read: FarRead) => Promise<void>;
  clearFarReads: (entryKey: string) => Promise<void>;
  getLastReadMs: () => number | null;
  setLastReadMs: (ms: number) => void;
  precision: PrecisionTracker;
}

type SharedChecked =
  | { ok: true; fix: Fix; snapshot: LocationSitesSnapshot }
  | { ok: false; result: ArrivalCheckResult };

/** Permission gate, debounce and the read — shared by the arrival and stop paths. */
async function readIfAllowed(
  deps: ArrivalCheckDeps,
  snapshot: LocationSitesSnapshot,
  manual: boolean
): Promise<SharedChecked> {
  const { perm, servicesEnabled } = await deps.getPermission();
  // `observedReducedPrecision` is deliberately NOT fed in here: gating reads on
  // it would stop us ever noticing the technician turned Precise back on. It is
  // surfaced by the Settings row instead; `decideArrival` already rejects a fix
  // worse than MAX_FIX_ACCURACY_M.
  const state = toLocationPermissionState(perm, servicesEnabled, false);
  if (!canReadForArrival(state)) return { ok: false, result: { kind: 'none', reason: 'permission' } };

  const now = deps.nowMs();
  if (!shouldReadPosition(deps.getLastReadMs(), now, manual)) {
    return { ok: false, result: { kind: 'none', reason: 'debounced' } };
  }
  deps.setLastReadMs(now);

  const fix = await deps.readFix();
  if (fix === null) return { ok: false, result: { kind: 'none', reason: 'no-fix' } };
  deps.precision.note(fix.accuracyM);
  return { ok: true, fix, snapshot };
}

async function stillHere(
  deps: ArrivalCheckDeps,
  snapshot: LocationSitesSnapshot,
  running: RunningInfo,
  manual: boolean
): Promise<ArrivalCheckResult> {
  const site: CachedSite | null = snapshot.sites.find((s) => s.id === running.siteId) ?? null;
  if (site === null || site.latitude === null || site.longitude === null) {
    return { kind: 'none', reason: 'timer-running' };
  }

  const checked = await readIfAllowed(deps, snapshot, manual);
  if (!checked.ok) return checked.result;
  const { fix } = checked;

  const entryKey = running.id ?? running.localId;
  if (entryKey === null) return { kind: 'none', reason: 'timer-running' };

  // A fix too coarse to say where we are says nothing about leaving.
  if (fix.accuracyM === null || fix.accuracyM > MAX_FIX_ACCURACY_M) {
    return { kind: 'none', reason: 'poor-accuracy' };
  }

  const distanceM = haversineMeters(fix, { latitude: site.latitude, longitude: site.longitude });
  const farThresholdM = 2 * (site.geofenceRadiusM ?? snapshot.defaultRadiusM);
  if (distanceM <= farThresholdM) {
    // Back on site: a brief trip away must not add up to a prompt.
    await deps.clearFarReads(entryKey);
    return { kind: 'none', reason: 'still-there' };
  }

  await deps.recordFarRead(entryKey, { atMs: fix.atMs, distanceM });
  const decision = decideStillHere({
    running: { source: running.source, siteId: running.siteId },
    site,
    defaultRadiusM: snapshot.defaultRadiusM,
    farReads: await deps.readFarReads(entryKey),
  });
  if (decision.kind !== 'prompt') return { kind: 'none', reason: 'still-there' };

  const startedMs = Date.parse(running.startedAt);
  const runningMinutes = Number.isFinite(startedMs)
    ? Math.max(0, Math.round((deps.nowMs() - startedMs) / 60_000))
    : 0;
  return { kind: 'stop', siteId: decision.siteId, placeName: site.orgName, runningMinutes };
}

export async function runArrivalCheck(
  deps: ArrivalCheckDeps,
  opts: { manual: boolean }
): Promise<ArrivalCheckResult> {
  const snapshot = await deps.getSnapshot();
  if (snapshot === null || !snapshot.enabled) return { kind: 'none', reason: 'flag-off' };

  const running = deps.running();
  if (running !== null) {
    // The one case a running timer still reads the position: a location-started
    // timer, to offer "Still at Acme?". Anything else is simply busy.
    if (running.source === 'location' && running.siteId !== null) {
      return stillHere(deps, snapshot, running, opts.manual);
    }
    return { kind: 'none', reason: 'timer-running' };
  }
  if (await deps.localTimerRunning()) return { kind: 'none', reason: 'timer-running' };

  const checked = await readIfAllowed(deps, snapshot, opts.manual);
  if (!checked.ok) return checked.result;

  const memory = await deps.readMemory();
  const decision = decideArrival({
    enabled: snapshot.enabled,
    timerRunning: false,
    fix: checked.fix,
    sites: snapshot.sites,
    defaultRadiusM: snapshot.defaultRadiusM,
    dismissedAt: memory.dismissedAt,
    lastStopAt: memory.lastStopAt,
    lastPick: memory.lastPick,
    nowMs: deps.nowMs(),
  });
  if (decision.kind === 'none') return { kind: 'none', reason: decision.reason as never };
  return {
    kind: 'arrival',
    candidates: decision.candidates,
    preselectSiteId: decision.preselectSiteId,
  };
}
