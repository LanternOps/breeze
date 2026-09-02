import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { palette, radii, spacing, type } from '../theme';
import { useAppDispatch, useAppSelector } from '../store';
import {
  elapsedSeconds,
  needsAttentionChanged,
  pendingWritesChanged,
  runningTimerAdopted,
  stoppedTimer,
  timeAccessDenied,
} from '../store/timeSlice';
import {
  createTimeEntry,
  getRunningTimer,
  getTimesheet,
  stopTimer,
  updateTimeEntry,
} from '../services/timeEntries';
import {
  drain,
  enqueue,
  parkNeedsAttention,
  readNeedsAttention,
  readQueue,
  reconcileQueueOwner,
  type QueuedWrite,
} from '../services/timeEntryQueue';
import { makeReplaySender } from '../services/timeEntryReplay';
import { confirmSuggestion, dismissSuggestion } from '../services/timeSuggestions';
import { serverNowMs } from '../services/serverClock';
import {
  clearLocalTimer,
  readLocalTimer,
  stampNow,
  writeLocalTimer,
} from '../services/localTimer';
import {
  makeReconciledSender,
  needsReconciliation,
  planReconciliation,
  type ReconcilePlan,
} from '../services/timerReconcile';
import { weekStartFor } from '../screens/time/timesheetWeek';
import { classifyTimeEntryDenial, isAccountLevelDenial } from '../services/timeEntryAccess';
import { stopRunningTimer } from '../screens/tickets/timerActions';
import { stopOutcomeEffects } from '../screens/tickets/timerOutcomeEffects';
import { isQueueWedged, isTimerBarVisible, shouldReplayNow } from './timerBarLogic';
import { useNetworkConnected } from '../lib/useNetworkConnected';
import { formatElapsed } from '../lib/timeFormat';
import { ticketRef } from '../screens/tickets/ticketCopy';
import { Toast } from './Toast';

/**
 * Persistent running-timer affordance, mounted above the tab bar.
 *
 * It is also the app's single queue-replay owner: it is the one component
 * alive for the whole signed-in session, so subscribing here means a
 * reconnection replays the backlog no matter which tab the technician is on.
 */
export function TimerBar({ onOpenTimesheet }: { onOpenTimesheet?: () => void } = {}) {
  const dispatch = useAppDispatch();
  const connected = useNetworkConnected();
  const running = useAppSelector((state) => state.time.running);
  const pendingCount = useAppSelector((state) => state.time.pendingCount);
  const denial = useAppSelector((state) => state.time.denial);
  const tickets = useAppSelector((state) => state.tickets.tickets);
  const userId = useAppSelector((state) => state.auth.user?.id ?? null);
  /**
   * Standing count, not a toast. A toast for work that could not be saved is
   * gone in four seconds and takes the only notice of unbilled minutes with it.
   * It lives in the store because the ticket screen can park a row too.
   */
  const needsAttentionCount = useAppSelector((state) => state.time.needsAttentionCount);

  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  /**
   * The head write keeps failing on a status the queue (correctly) retains —
   * usually a 403, which issue #4251 makes the ORDINARY state for a default
   * Partner Technician, not an exotic one. `headAttempts` was added as this
   * signal and had no consumer, so a wedged queue replayed silently forever.
   */
  const [wedged, setWedged] = useState(false);
  /** A local timer whose start request may also have landed on the server. */
  const [startUnconfirmed, setStartUnconfirmed] = useState(false);

  const mounted = useRef(true);
  const stopInFlight = useRef(false);
  const wasConnected = useRef(connected);
  // Read by the cold-start effect, which must not re-run on every reconnection.
  const connectedRef = useRef(connected);
  /**
   * No drain may run before the queue's owner has been established. Otherwise a
   * reconnection landing first would replay the PREVIOUS technician's unsent
   * writes under this session's bearer token — the leak that keeping the queue
   * across an involuntary session loss would otherwise open.
   */
  const ownerReady = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Returns the depth, or null when storage could not be read. */
  const refreshQueueDepth = useCallback(async (): Promise<number | null> => {
    try {
      const queued = await readQueue();
      if (mounted.current) dispatch(pendingWritesChanged(queued.length));
      return queued.length;
    } catch {
      // QueueStorageError — keep the last known depth. Reporting zero would
      // tell the technician their unsent minutes are already saved.
      return null;
    }
  }, [dispatch]);

  // 1s tick, only while something is actually running.
  useEffect(() => {
    if (running === null) return;
    setNow(new Date());
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, [running]);

  const refreshNeedsAttention = useCallback(async (): Promise<void> => {
    const rows = await readNeedsAttention().catch(() => null);
    if (rows !== null && mounted.current) dispatch(needsAttentionChanged(rows.length));
  }, [dispatch]);

  /**
   * Resolves what the server actually has before replaying anything that could
   * duplicate it.
   *
   * Only runs when this device is holding something ambiguous — an unconfirmed
   * local start, or a queued `create` flagged `unconfirmedStart` — so the
   * ordinary reconnect still costs exactly one drain.
   */
  const reconcile = useCallback(async (queue: QueuedWrite[]): Promise<ReconcilePlan> => {
    const empty: ReconcilePlan = { adopt: null, substitute: null };
    const localTimer = await readLocalTimer().catch(() => null);
    if (mounted.current) setStartUnconfirmed(localTimer !== null && !localTimer.startConfirmed);
    if (!needsReconciliation(localTimer, queue)) return empty;

    let server;
    try {
      server = await getRunningTimer();
    } catch {
      // Never block a drain on the reconciliation probe: the writes are safe to
      // send, and the worst case is a duplicate the technician can delete.
      return empty;
    }

    const plan = planReconciliation({ localTimer, queue, server });
    if (plan.adopt !== null && localTimer !== null) {
      const adopted = {
        ...localTimer,
        serverEntryId: plan.adopt.serverEntryId,
        startedAtWall: plan.adopt.startedAt,
        startConfirmed: true,
      };
      await writeLocalTimer(adopted).catch(() => undefined);
      if (mounted.current) {
        setStartUnconfirmed(false);
        dispatch(
          runningTimerAdopted({
            id: plan.adopt.serverEntryId,
            localId: null,
            ticketId: adopted.ticketId,
            startedAt: plan.adopt.startedAt,
            description: adopted.description,
          })
        );
      }
    }
    return plan;
  }, [dispatch]);

  const replay = useCallback(async () => {
    let queue: QueuedWrite[];
    try {
      queue = await readQueue();
    } catch {
      // QueueStorageError: the queue is intact and untouched, so the next
      // reconnect tries again rather than draining a view we could not read.
      return;
    }
    const plan = await reconcile(queue);

    const base = makeReplaySender({
      createTimeEntry,
      updateTimeEntry,
      // W06 (#3900). Both carry their own timestamps, so they satisfy the same
      // rule as the two above: nothing here defers a time stamp to drain.
      confirmSuggestion,
      dismissSuggestion,
      serverNow: () => serverNowMs().ms,
    });
    const send = makeReconciledSender({
      base,
      plan,
      updateTimeEntry,
      lookupWeekEntries: async (write) => {
        const startedAt = write.payload.startedAt;
        if (typeof startedAt !== 'string') return null;
        const week = await getTimesheet(weekStartFor(new Date(startedAt))).catch(() => null);
        return week === null ? null : week.days.flatMap((day) => day.entries);
      },
    });

    try {
      const result = await drain(send);
      if (!mounted.current) return;
      dispatch(pendingWritesChanged(result.remaining));
      dispatch(needsAttentionChanged(result.needsAttentionTotal));
      // A retained failure that has burned several attempts is not "offline":
      // nothing behind it can move until somebody acts.
      setWedged(isQueueWedged(result));
      if (result.needsAttention.length > 0) {
        setToast({
          kind: 'error',
          text:
            result.needsAttention.length === 1
              ? '1 time entry needs attention. Re-enter it from the timesheet.'
              : `${result.needsAttention.length} time entries need attention. Re-enter them from the timesheet.`,
        });
      } else if (result.sent > 0) {
        // Only writes that actually reached the server are reported as synced —
        // never ones that merely moved to needs-attention.
        setToast({ kind: 'success', text: `Synced ${result.sent} offline time ${result.sent === 1 ? 'entry' : 'entries'}` });
      }
      // A reconciled or externally started entry can be running without the
      // store knowing, so the server stays the authority on what is live.
      try {
        const timer = await getRunningTimer();
        if (mounted.current && timer !== null) dispatch(runningTimerAdopted(timer));
        else if (mounted.current && timer === null) {
          const stillLocal = await readLocalTimer().catch(() => null);
          // Do NOT clear a device-only timer just because the server has none:
          // it is not supposed to be there yet.
          if (stillLocal === null) dispatch(runningTimerAdopted(null));
        }
      } catch {
        // Leave the local view alone rather than clearing a real timer.
      }
    } catch {
      await refreshQueueDepth();
      await refreshNeedsAttention();
    }
  }, [dispatch, reconcile, refreshQueueDepth, refreshNeedsAttention]);

  useEffect(() => {
    const previous = wasConnected.current;
    wasConnected.current = connected;
    connectedRef.current = connected;
    if (
      ownerReady.current &&
      shouldReplayNow({ coldStart: false, previousConnected: previous, connected, pendingCount })
    ) {
      void replay();
    }
  }, [connected, pendingCount, replay]);

  // Cold start: the authority on "is a timer running" is the server, not this
  // process. A timer started from the web dashboard, or before a reinstall,
  // must appear here rather than being invisible until the next start 409s.
  //
  // It is also the only chance a backlog from a PREVIOUS launch gets to drain:
  // `useNetworkConnected` seeds `true`, so an app relaunched at the office on
  // strong WiFi never sees the false -> true edge the effect above waits for,
  // and the unsent entries would sit behind their badge indefinitely. Declared
  // after that effect so `connectedRef` already holds this render's value.
  useEffect(() => {
    let cancelled = false;
    ownerReady.current = false;
    void (async () => {
      // Claim the queue for THIS account before anything can replay it. An
      // unowned queue is adopted; one left by a different technician is parked
      // and cleared. This — not the sign-out hook — is what makes a
      // cross-account replay impossible, because it runs on every path into a
      // session, including a re-login after a token expiry.
      if (userId !== null) await reconcileQueueOwner(userId).catch(() => null);
      ownerReady.current = true;
      const depth = await refreshQueueDepth();
      await refreshNeedsAttention();
      // A device-only timer survives a relaunch, and nothing on the server can
      // reveal it — without this the bar would be blank until the next tap.
      const localTimer = await readLocalTimer().catch(() => null);
      if (localTimer !== null && localTimer.serverEntryId === null && !cancelled && mounted.current) {
        setStartUnconfirmed(!localTimer.startConfirmed);
        dispatch(
          runningTimerAdopted({
            id: null,
            localId: localTimer.localId,
            ticketId: localTimer.ticketId,
            startedAt: localTimer.startedAtWall,
            description: localTimer.description,
          })
        );
      }
      try {
        const timer = await getRunningTimer();
        // A null answer must not clear a device-only timer: the server is not
        // supposed to know about one yet.
        if (!cancelled && mounted.current && (timer !== null || localTimer === null)) {
          dispatch(runningTimerAdopted(timer));
        }
      } catch (error) {
        const denied = classifyTimeEntryDenial(error);
        // Only an account-shaped verdict is a wall. Recording a per-row 403
        // here would withdraw time tracking app-wide until sign-out.
        if (denied !== null && isAccountLevelDenial(denied) && !cancelled && mounted.current) {
          // Record it once so every time surface reports the same explicit
          // reason instead of a blank screen.
          dispatch(timeAccessDenied(denied));
        }
        // Any other failure is transient; the bar simply stays hidden.
      }
      if (
        !cancelled &&
        mounted.current &&
        shouldReplayNow({
          coldStart: true,
          previousConnected: wasConnected.current,
          connected: connectedRef.current,
          pendingCount: depth ?? 0,
        })
      ) {
        await replay();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dispatch, refreshQueueDepth, refreshNeedsAttention, replay, userId]);

  const onStop = useCallback(async () => {
    if (stopInFlight.current) return;
    stopInFlight.current = true;
    setBusy(true);
    try {
      const outcome = await stopRunningTimer(
        { running },
        {
          stopTimer,
          enqueue,
          readLocalTimer,
          clearLocalTimer,
          parkNeedsAttention,
          isConnected: () => connected,
          stamp: stampNow,
        }
      );
      if (!mounted.current) return;
      // One decision table, shared with TicketDetailScreen — see
      // screens/tickets/timerOutcomeEffects.ts.
      const effects = stopOutcomeEffects(outcome);
      if (effects.clearRunning) {
        dispatch(stoppedTimer());
        setStartUnconfirmed(false);
      }
      if (effects.accountDenial !== null) dispatch(timeAccessDenied(effects.accountDenial));
      if (effects.refreshQueueDepth) await refreshQueueDepth();
      if (effects.refreshNeedsAttention) await refreshNeedsAttention();
      if (mounted.current) setToast(effects.toast);
    } finally {
      stopInFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [connected, dispatch, refreshQueueDepth, refreshNeedsAttention, running]);

  // The toast is a child of this bar, not a portal: unmounting on an emptied
  // queue would swallow the "N offline time entries could not be saved"
  // warning in exactly the case it exists for.
  const visible = isTimerBarVisible({
    hasRunningTimer: running !== null,
    // A standing "needs attention" count keeps the bar mounted on its own: it
    // is the only place unbilled work is reported once the toast has gone.
    pendingCount: pendingCount + needsAttentionCount,
    hasToast: toast !== null,
  });
  if (!visible) return null;

  const ticket = running?.ticketId
    ? tickets.find((candidate) => candidate.id === running.ticketId)
    : undefined;
  const label = running?.ticketId
    ? (ticketRef({ internalNumber: ticket?.internalNumber ?? null }) ?? ticket?.subject ?? 'Ticket')
    : 'No ticket';

  const bar = (
    <View style={styles.bar} accessibilityRole="summary">
      <View style={styles.left}>
        {running !== null ? (
          <>
            <Text style={styles.clock} accessibilityLabel="Elapsed time">
              {formatElapsed(elapsedSeconds(running, now))}
            </Text>
            <Text style={styles.ticket} numberOfLines={1}>
              {label}
            </Text>
            {running.id === null ? (
              <Text style={styles.chip} accessibilityLabel="Not yet synced">
                Not yet synced
              </Text>
            ) : null}
          </>
        ) : (
          <Text style={styles.ticket}>Time entries waiting to sync</Text>
        )}
      </View>

      {pendingCount > 0 ? (
        <View style={styles.badge} accessibilityLabel={`${pendingCount} unsent time entries`}>
          <Text style={styles.badgeText}>{pendingCount}</Text>
        </View>
      ) : null}

      {running !== null && denial === null ? (
        <Pressable
          onPress={() => void onStop()}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Stop timer"
          accessibilityState={{ disabled: busy }}
          style={[styles.stop, busy && styles.stopDisabled]}
        >
          <Text style={styles.stopText}>{busy ? '…' : 'Stop'}</Text>
        </Pressable>
      ) : null}

      <Toast
        visible={toast !== null}
        text={toast?.text ?? ''}
        kind={toast?.kind ?? 'success'}
        onHidden={() => setToast(null)}
        bottomOffset={spacing['16']}
      />
    </View>
  );

  const notices = (
    <>
      {startUnconfirmed ? (
        <Text style={styles.notice}>
          Start not confirmed — a timer may also be running on the server.
        </Text>
      ) : null}
      {needsAttentionCount > 0 ? (
        <Pressable
          onPress={onOpenTimesheet}
          disabled={onOpenTimesheet === undefined}
          accessibilityRole="button"
          accessibilityLabel={`${needsAttentionCount} time ${needsAttentionCount === 1 ? 'entry needs' : 'entries need'} attention`}
        >
          <Text style={styles.noticeAlarm}>
            {needsAttentionCount === 1
              ? '1 time entry needs attention — open the timesheet'
              : `${needsAttentionCount} time entries need attention — open the timesheet`}
          </Text>
        </Pressable>
      ) : null}
      {wedged ? (
        <Text style={styles.noticeAlarm}>
          Time entries are not syncing. Your role may be missing the time-entries permission.
        </Text>
      ) : null}
    </>
  );

  return (
    <View>
      {notices}
      {bar}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing['3'],
    paddingHorizontal: spacing['4'],
    paddingVertical: spacing['2'],
    backgroundColor: palette.dark.bg1,
    borderTopWidth: 1,
    borderTopColor: palette.dark.border,
  },
  left: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing['2'] },
  clock: { ...type.monoMd, color: palette.dark.textHi },
  ticket: { ...type.meta, color: palette.dark.textMd, flexShrink: 1 },
  badge: {
    minWidth: 22,
    paddingHorizontal: spacing['2'],
    paddingVertical: 2,
    borderRadius: radii.full,
    backgroundColor: palette.warning.base,
    alignItems: 'center',
  },
  badgeText: { ...type.meta, color: palette.dark.bg0 },
  stop: {
    paddingHorizontal: spacing['3'],
    paddingVertical: spacing['2'],
    borderRadius: radii.md,
    backgroundColor: palette.deny.base,
  },
  stopDisabled: { opacity: 0.5 },
  chip: {
    ...type.meta,
    color: palette.warning.base,
    borderWidth: 1,
    borderColor: palette.warning.base,
    borderRadius: radii.full,
    paddingHorizontal: spacing['2'],
  },
  notice: {
    ...type.meta,
    color: palette.dark.textMd,
    backgroundColor: palette.dark.bg1,
    paddingHorizontal: spacing['4'],
    paddingVertical: spacing['1'],
  },
  noticeAlarm: {
    ...type.meta,
    color: palette.deny.base,
    backgroundColor: palette.dark.bg1,
    paddingHorizontal: spacing['4'],
    paddingVertical: spacing['1'],
  },
  stopText: { ...type.meta, color: palette.deny.onBase },
});
