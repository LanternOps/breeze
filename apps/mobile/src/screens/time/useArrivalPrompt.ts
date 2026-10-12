import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Location from 'expo-location';
import { useStore } from 'react-redux';

import { track } from '../../lib/analytics';
import { reportInternalError } from '../../lib/errorReporting';
import { useNetworkConnected } from '../../lib/useNetworkConnected';
import { useToast } from '../../components/toast/ToastHost';
import { useAppDispatch, type RootState } from '../../store';
import {
  pendingWritesChanged,
  runningTimerAdopted,
  stoppedTimer,
  timeAccessDenied,
} from '../../store/timeSlice';
import { groupKey, type Fix, type SiteCandidate } from '../../services/arrivalMatch';
import {
  clearFarReads,
  readArrivalMemory,
  readFarReads,
  recordDismiss,
  recordFarRead,
  recordPick,
  recordStopAtSite,
} from '../../services/arrivalMemory';
import { clearLocalTimer, readLocalTimer, stampNow, writeLocalTimer } from '../../services/localTimer';
import { createPrecisionTracker, type LocationPermissionInput } from '../../services/locationPermission';
import { getLocationSites, invalidateLocationSites } from '../../services/locationSites';
import { startTimer, stopTimer } from '../../services/timeEntries';
import { enqueue, parkNeedsAttention, readQueue } from '../../services/timeEntryQueue';
import { startForSite, stopRunningTimer } from '../tickets/timerActions';
import { startOutcomeEffects, stopOutcomeEffects } from '../tickets/timerOutcomeEffects';

import type { ArrivalSheetState } from './ArrivalSheet';
import { runArrivalCheck, type ArrivalCheckDeps, type ArrivalCheckResult } from './arrivalCheck';
import { afterSitePicked, initialStep, openTicketsForOrg } from './arrivalSheetLogic';
import { canStartFromArrival, entryKeyOf, stopTargetMatches } from './arrivalGuards';
import { isArrivalTab, subscribeArrivalCheck } from './arrivalTrigger';

export { isArrivalTab };

// Shared across mounts: the debounce and the precision inference outlive a
// remount of the navigator.
const precision = createPrecisionTracker();
let lastReadMs: number | null = null;

/** The precision tracker the Settings row reads ("Precise location is off"). */
export function getPrecisionTracker(): typeof precision {
  return precision;
}

type SheetData =
  | { kind: 'arrival'; candidates: SiteCandidate[]; state: ArrivalSheetState }
  | { kind: 'stop'; siteId: string; state: ArrivalSheetState };

/**
 * Foreground arrival prompt. Triggers: app returning to the foreground, Home /
 * Tickets focus, and Tickets pull-to-refresh. It never asks for permission —
 * that is the Settings row's explicit action — and it only reads the position
 * when the OS has already granted precise foreground access.
 */
export function useArrivalPrompt() {
  const dispatch = useAppDispatch();
  const store = useStore<RootState>();
  const connected = useNetworkConnected();
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  const { show: showToast } = useToast();

  const [sheet, setSheet] = useState<SheetData | null>(null);
  const [busy, setBusy] = useState(false);
  const sheetRef = useRef<SheetData | null>(null);
  sheetRef.current = sheet;
  const inFlight = useRef(false);
  /** Set synchronously on a Start/Stop tap: React state alone lets a double-tap through. */
  const actionInFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const ticketsForOrg = useCallback((orgId: string) => {
    const { tickets } = store.getState();
    // Only offer tickets when the list in memory is "my open tickets"; any
    // other filter would offer tickets that are not the technician's.
    if (tickets.queue !== 'open' || tickets.assignee !== 'me') return [];
    return openTicketsForOrg(tickets.tickets, orgId);
  }, [store]);

  const deps = useCallback((): ArrivalCheckDeps => ({
    nowMs: () => Date.now(),
    getSnapshot: () => getLocationSites({ nowMs: Date.now() }),
    running: () => {
      const r = store.getState().time.running;
      return r === null
        ? null
        : {
            id: r.id,
            localId: r.localId,
            source: r.source ?? null,
            siteId: r.siteId ?? null,
            startedAt: r.startedAt,
          };
    },
    localTimerRunning: async () => (await readLocalTimer().catch(() => null)) !== null,
    getPermission: async () => {
      const [perm, servicesEnabled] = await Promise.all([
        Location.getForegroundPermissionsAsync(),
        Location.hasServicesEnabledAsync(),
      ]);
      return { perm: perm as LocationPermissionInput, servicesEnabled };
    },
    readFix: async (): Promise<Fix | null> => {
      try {
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        return {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracyM: pos.coords.accuracy ?? null,
          atMs: Date.now(),
        };
      } catch {
        return null;
      }
    },
    readMemory: () => readArrivalMemory(Date.now()),
    readFarReads,
    recordFarRead,
    clearFarReads,
    getLastReadMs: () => lastReadMs,
    setLastReadMs: (ms) => {
      lastReadMs = ms;
    },
    precision,
  }), [store]);

  const applyResult = useCallback((result: ArrivalCheckResult) => {
    if (!mounted.current) return;
    if (result.kind === 'arrival') {
      const step = initialStep(result.candidates, result.preselectSiteId, ticketsForOrg);
      setSheet({
        kind: 'arrival',
        candidates: result.candidates,
        state: { kind: 'arrival', step },
      });
      // Counts only: no site, org, distance or coordinate ever goes to analytics.
      track('location_prompt_shown', { candidates: result.candidates.length });
    } else if (result.kind === 'stop') {
      setSheet({
        kind: 'stop',
        siteId: result.siteId,
        state: { kind: 'stop', placeName: result.placeName, runningMinutes: result.runningMinutes },
      });
    }
  }, [ticketsForOrg]);

  const check = useCallback(async (manual: boolean) => {
    if (inFlight.current || sheetRef.current !== null) return;
    inFlight.current = true;
    try {
      const result = await runArrivalCheck(deps(), { manual });
      // The store's running timer is hydrated by a separate request, so it can
      // land while the position was being read: re-check before showing anything.
      if (result.kind === 'arrival') {
        const local = (await readLocalTimer().catch(() => null)) !== null;
        if (
          !canStartFromArrival({
            storeRunning: store.getState().time.running !== null,
            localTimer: local ? 'present' : 'none',
          })
        ) {
          return;
        }
      } else if (result.kind === 'stop') {
        if (!stopTargetMatches(store.getState().time.running, result.siteId)) return;
      }
      applyResult(result);
    } catch (error) {
      reportInternalError(error, 'arrivalPrompt.check');
    } finally {
      inFlight.current = false;
    }
  }, [applyResult, deps, store]);

  useEffect(() => {
    void check(false);
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void check(false);
    });
    const off = subscribeArrivalCheck((manual) => void check(manual));
    return () => {
      sub.remove();
      off();
    };
  }, [check]);

  const refreshQueueDepth = useCallback(async () => {
    try {
      const queued = await readQueue();
      if (mounted.current) dispatch(pendingWritesChanged(queued.length));
    } catch {
      // Keep the last known depth: zero would claim billable minutes are safe.
    }
  }, [dispatch]);

  const close = useCallback(() => {
    setSheet(null);
    setBusy(false);
  }, []);

  const onPickSite = useCallback((site: SiteCandidate) => {
    setSheet((cur) =>
      cur?.kind === 'arrival'
        ? { ...cur, state: { kind: 'arrival', step: afterSitePicked(site, ticketsForOrg) } }
        : cur
    );
  }, [ticketsForOrg]);

  const onStart = useCallback(async (site: SiteCandidate, ticketId: string | null) => {
    const current = sheetRef.current;
    if (current?.kind !== 'arrival' || actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    try {
      // Re-check at tap time: /start auto-stops a running timer server-side, so
      // a timer that began while the sheet was open must never be replaced.
      const local = (await readLocalTimer().catch(() => null)) !== null;
      if (
        !canStartFromArrival({
          storeRunning: store.getState().time.running !== null,
          localTimer: local ? 'present' : 'none',
        })
      ) {
        showToast({ kind: 'error', text: 'A timer is already running, so none was started.' });
        close();
        return;
      }

      const outcome = await startForSite(
        { orgId: site.orgId, siteId: site.siteId, ticketId },
        {
          startTimer,
          writeLocalTimer,
          clearLocalTimer,
          isConnected: () => connectedRef.current,
          stamp: stampNow,
          invalidateLocationSites,
        }
      );
      // No mounted-guard before the dispatches: the store outlives this host,
      // and a started timer must be adopted even if the host unmounted.
      const effects = startOutcomeEffects(outcome);
      if (effects.startRunning !== null) dispatch(runningTimerAdopted(effects.startRunning));
      if (effects.accountDenial !== null) dispatch(timeAccessDenied(effects.accountDenial));
      if (effects.refreshQueueDepth) await refreshQueueDepth();
      if (outcome.ok === true || outcome.ok === 'local') {
        await recordPick(
          groupKey(current.candidates.map((c) => c.siteId)),
          site.siteId,
          Date.now()
        ).catch(() => undefined);
        track('location_prompt_started');
      }
      showToast(effects.toast);
      close();
    } catch (error) {
      reportInternalError(error, 'arrivalPrompt.start');
      showToast({ kind: 'error', text: 'Could not start the timer.' });
      close();
    } finally {
      actionInFlight.current = false;
    }
  }, [close, dispatch, refreshQueueDepth, showToast, store]);

  const onDismiss = useCallback(async () => {
    const current = sheetRef.current;
    close();
    if (current?.kind !== 'arrival') return;
    await recordDismiss(
      current.candidates.map((c) => c.siteId),
      Date.now()
    ).catch(() => undefined);
    track('location_prompt_dismissed');
  }, [close]);

  const onStop = useCallback(async () => {
    const current = sheetRef.current;
    if (current?.kind !== 'stop' || actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    try {
      const running = store.getState().time.running;
      // The timer may have changed while the sheet was open (stopped elsewhere,
      // or a different one started): never stop one the sheet was not about.
      if (!stopTargetMatches(running, current.siteId)) {
        close();
        return;
      }
      const outcome = await stopRunningTimer(
        { running },
        {
          stopTimer,
          enqueue,
          readLocalTimer,
          clearLocalTimer,
          parkNeedsAttention,
          isConnected: () => connectedRef.current,
          stamp: stampNow,
        }
      );
      const effects = stopOutcomeEffects(outcome);
      if (effects.clearRunning) {
        dispatch(stoppedTimer());
        const key = entryKeyOf(running);
        if (key !== null) await clearFarReads(key).catch(() => undefined);
        await recordStopAtSite(current.siteId, Date.now()).catch(() => undefined);
      }
      if (effects.accountDenial !== null) dispatch(timeAccessDenied(effects.accountDenial));
      if (effects.refreshQueueDepth) await refreshQueueDepth();
      showToast(effects.toast);
      close();
    } catch (error) {
      reportInternalError(error, 'arrivalPrompt.stop');
      showToast({ kind: 'error', text: 'Could not stop the timer.' });
      close();
    } finally {
      actionInFlight.current = false;
    }
  }, [close, dispatch, refreshQueueDepth, showToast, store]);

  const onKeepRunning = useCallback(async () => {
    const running = store.getState().time.running;
    close();
    const key = entryKeyOf(running);
    if (key !== null) await clearFarReads(key).catch(() => undefined);
  }, [close, store]);

  return {
    state: sheet?.state ?? null,
    busy,
    onPickSite,
    onStart: (site: SiteCandidate, ticketId: string | null) => void onStart(site, ticketId),
    onDismiss: () => void onDismiss(),
    onStop: () => void onStop(),
    onKeepRunning: () => void onKeepRunning(),
  };
}
