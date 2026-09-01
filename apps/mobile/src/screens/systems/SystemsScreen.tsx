import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Clipboard, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Svg, { Circle, Line } from 'react-native-svg';

import { useApprovalTheme, palette, spacing, type } from '../../theme';
import type { Alert, Device } from '../../services/api';
import type { SystemsStackParamList, MainTabParamList } from '../../navigation/MainNavigator';
import { useAppDispatch } from '../../store';
import { acknowledgeAlertAsync } from '../../store/alertsSlice';
import { acknowledgeAlerts } from '../../services/api';
import { loadHistory, setError as setChatError } from '../../store/aiChatSlice';
import { getAiSessionMessages } from '../../services/aiChat';
import { historyToMessages } from '../chat/historyAdapter';
import { Toast } from '../../components/Toast';
import { SearchSheet } from '../search/SearchSheet';
import type { MobileSearchResult } from '../../services/search';
import { haptic } from '../../lib/motion';
import { track } from '../../lib/analytics';
import { reportInternalError } from '../../lib/errorReporting';

import { AlertActionSheet } from './components/AlertActionSheet';
import {
  beginAck,
  bulkActionLabel,
  emptyPendingAcks,
  endAck,
  markAckConfirmed,
  reconcileSelection,
  releaseStaleAcks,
  toggleSelection,
  visibleAlerts,
} from './pendingAcks';
import {
  cancelUndo,
  emptyUndo,
  flushAllUndo,
  flushUndo,
  scheduleUndo,
  undoToastLabel,
} from './undoAck';
import { UndoToast } from '../../components/UndoToast';
import { FilterChip } from './components/FilterChip';
import { Hero } from './components/Hero';
import { IssueRow } from './components/IssueRow';
import { OrgRow } from './components/OrgRow';
import { RecentRow } from './components/RecentRow';
import { SectionHeader } from './components/SectionHeader';
import { SkeletonRow } from './components/SkeletonRow';
import { deriveHeroState } from './heroCopy';
import { useSystemsData } from './useSystemsData';

type Nav = NativeStackNavigationProp<SystemsStackParamList, 'Systems'>;

/**
 * How long an acknowledge stays retractable before the request is sent.
 *
 * The acknowledge is no longer instant, which is a real cost against a feature
 * about not waiting — but "without waiting" was about not tapping through a
 * detail screen and sitting on a 15-second write, not about the row clearing
 * inside a second. The gesture is still one swipe and the list stays
 * responsive; only the request is deferred. What it buys is that a stray swipe
 * on a phone, one-handed, in a list, stops being unrecoverable.
 */
const UNDO_WINDOW_MS = 5000;

/**
 * Bounded retry schedule for the post-ack refresh that satisfies the
 * fetch-generation release condition (#3782). A single `refresh()` call can
 * itself fail to land a fresh `activeAlerts` snapshot (transient rejection,
 * or coalescing into an in-flight fetch that also rejects) — this retries a
 * few times before giving up and deferring to the ambient triggers
 * (push/WS/focus/pull), rather than leaving a confirmed-acknowledged row
 * hidden with no time bound.
 */
const ACK_REFRESH_RETRY_DELAYS_MS = [0, 2000, 5000];

// Inline magnifying glass — see SearchSheet for the input-decorating sibling.
// 16px sizing here matches the right-edge of the Hero copy block.
function HeaderSearchIcon({ color, size = 16 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16">
      <Circle cx={7} cy={7} r={4.5} stroke={color} strokeWidth={1.6} fill="none" />
      <Line x1={10.4} y1={10.4} x2={14} y2={14} stroke={color} strokeWidth={1.6} strokeLinecap="round" />
    </Svg>
  );
}

// Builds a mobile Alert object out of a search result so AlertDetailScreen
// can render with what we have without re-fetching. Fields the screen does
// not display fall back to safe defaults.
function alertFromSearch(result: Extract<MobileSearchResult, { kind: 'alert' }>): Alert {
  const sev = result.meta.severity as Alert['severity'];
  // The mobile Alert type doesn't include 'info'; map it like services/api does.
  const severity: Alert['severity'] = sev === 'info' ? 'low' : sev;
  const triggered = result.meta.triggeredAt ?? new Date().toISOString();
  return {
    id: result.id,
    title: result.title,
    message: result.meta.message ?? '',
    severity,
    type: 'alert',
    deviceId: result.meta.deviceId ?? undefined,
    deviceName: result.meta.deviceName ?? undefined,
    acknowledged:
      result.meta.status === 'acknowledged' || result.meta.status === 'resolved',
    createdAt: triggered,
    updatedAt: triggered,
    metadata: { orgId: result.meta.orgId, status: result.meta.status },
  };
}

function deviceFromSearch(result: Extract<MobileSearchResult, { kind: 'device' }>): Device {
  const status: Device['status'] =
    result.meta.status === 'online'
      ? 'online'
      : result.meta.status === 'offline' || result.meta.status === 'decommissioned'
        ? 'offline'
        : 'warning';
  const fallbackTime = new Date(0).toISOString();
  return {
    id: result.id,
    name: result.meta.displayName?.trim() || result.meta.hostname || result.id,
    hostname: result.meta.hostname ?? undefined,
    os: result.meta.osType ?? undefined,
    status,
    lastSeen: result.meta.lastSeenAt ?? undefined,
    organizationId: result.meta.orgId,
    siteId: result.meta.siteId ?? undefined,
    siteName: result.meta.siteName ?? undefined,
    createdAt: fallbackTime,
    updatedAt: fallbackTime,
  };
}

export function SystemsScreen() {
  const insets = useSafeAreaInsets();
  const theme = useApprovalTheme('dark');
  const navigation = useNavigation<Nav>();
  const dispatch = useAppDispatch();

  const [sheetAlert, setSheetAlert] = useState<Alert | null>(null);
  const [pendingAcks, setPendingAcks] = useState(emptyPendingAcks);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [searchOpen, setSearchOpen] = useState(false);
  const [undo, setUndo] = useState(emptyUndo);
  const [toast, setToast] = useState<
    { kind: 'success' | 'error'; text: string } | null
  >(null);

  const {
    summary,
    activeIssues,
    recent,
    orgRollups,
    filterOrgId,
    filterOrgName,
    setFilterOrgId,
    loading,
    refreshing,
    error,
    activeAlertsTruncated,
    devicesTruncated,
    refresh,
    refreshIfStale,
    activeAlertsGeneration,
    getActiveAlertsGeneration,
  } = useSystemsData();

  // Release any pending ack whose confirmed generation has been superseded,
  // whenever a fresh `activeAlerts` snapshot lands — from ANY caller (push,
  // WS, tab-focus, or the acknowledge's own refresh). See #3782 and the
  // `pendingAcks` module doc for why this can't just be "after refresh()
  // resolves".
  useEffect(() => {
    setPendingAcks((p) => releaseStaleAcks(p, activeAlertsGeneration));
  }, [activeAlertsGeneration]);

  const onRefresh = useCallback(() => {
    track('systems_pulled_to_refresh');
    refresh();
  }, [refresh]);

  const onApplyOrgFilter = useCallback(
    (orgId: string) => {
      track('systems_org_filter_applied');
      setFilterOrgId(orgId);
    },
    [setFilterOrgId],
  );

  // Hero stays whole-fleet even when filtered, so the user keeps the
  // global context. Filter affects issues + recent + the orgs section
  // visibility only.
  const hero = deriveHeroState(summary, activeIssues);

  useFocusEffect(
    useCallback(() => {
      refreshIfStale();
    }, [refreshIfStale]),
  );

  const onPressIssue = useCallback(
    (alert: Alert) => {
      navigation.navigate('SystemsAlertDetail', { alert });
    },
    [navigation],
  );

  const onLongPressAlert = useCallback((alert: Alert) => {
    setSheetAlert(alert);
  }, []);

  const onCloseSheet = useCallback(() => {
    setSheetAlert(null);
  }, []);

  // Rows mid-acknowledge are hidden immediately; the request runs behind them.
  const visibleIssues = visibleAlerts(activeIssues, pendingAcks);

  // Narrowed once so the JSX below can use it without re-checking. The token
  // that matters is the one this RENDER saw: the toast's callbacks close over
  // it, so a timer or tap belonging to a replaced batch passes the old token
  // and `flushUndo`/`cancelUndo` correctly release nothing. (Reading
  // `undoRef.current` in those callbacks instead would read the live batch and
  // defeat exactly that guard.)
  const undoBatch = undo.batch;

  /**
   * Acknowledge one or many, optimistically.
   *
   * The rows disappear immediately and the request runs behind them: a single
   * acknowledge has been measured at 13-15s on a real deployment, and a bulk
   * call scales with the batch, so blocking the UI on it makes triage unusable.
   * A failure puts the rows back and says so.
   */
  const dispatchAcknowledge = useCallback(
    async (ids: readonly string[]) => {
      if (ids.length === 0) return;
      // NOTE: the rows are ALREADY hidden — `scheduleAcknowledge` called
      // `beginAck` when the undo window opened. Hiding again here would double
      // the reference count and leave them hidden after this call releases one.
      // Restore only what actually failed, so a partial outcome is honest.
      let toRestore: readonly string[] = ids;
      try {
        const { acknowledged, failed, unknown, errors } = await acknowledgeAlerts([...ids]);
        // Per-id failures never throw, so they would otherwise bypass the
        // catch below and be reported nowhere. Without this, a systematic
        // failure (every id aborting at the same deadline) is invisible in
        // telemetry and looks like ordinary partial failure on screen.
        for (const err of errors) reportInternalError(err, 'acknowledge-alert');
        // Restore ONLY confirmed failures. `unknown` ids stay hidden: the
        // request may well have committed them server-side, and acknowledging
        // is irreversible, so putting the row back invites a second
        // acknowledge. The next authoritative fetch is what resolves them.
        toRestore = failed;
        if (unknown.length > 0) {
          setToast({
            kind: 'error',
            text: `Couldn't confirm ${unknown.length}. Checking again.`,
          });
        } else if (failed.length === 0) {
          // Deliberately silent on success. The undo toast already said
          // "acknowledged" when the rows disappeared; a second toast seconds
          // later, after the operator has moved on, is noise announcing
          // something they were already told.
        } else if (acknowledged.length === 0) {
          setToast({ kind: 'error', text: 'Could not acknowledge. Restored.' });
        } else {
          // Never claim the full count when some were refused.
          setToast({
            kind: 'error',
            text: `Acknowledged ${acknowledged.length}, ${failed.length} failed.`,
          });
        }
        // Successful ids stay hidden until a fresh fetch supplies the new
        // truth, so the list cannot flash the old rows back.
        setPendingAcks((p) => endAck(p, failed));
        // Mark the confirmed AND unknown ids to release once a strictly NEWER
        // activeAlerts snapshot lands than the one current right now — proof
        // the server's true state for these ids has actually been observed,
        // rather than trusting `refresh()` resolving (unreliable: it swallows
        // its own failures and can coalesce into an unrelated in-flight
        // call). `unknown` ids are included for the same reason as before:
        // the request may well have committed them server-side, and holding
        // them past a fresh fetch would conceal a still-active alert for the
        // life of the screen. Read via the ref-backed getter, not a value
        // captured when this callback was created — acknowledgeAlerts can
        // take 13-15s, during which an unrelated fetch may have already
        // bumped the generation, and stamping with a stale pre-await value
        // would let that earlier fetch (which predates this ack's own
        // confirmation) wrongly satisfy the release condition. See #3782.
        const generationAtConfirm = getActiveAlertsGeneration();
        setPendingAcks((p) =>
          markAckConfirmed(p, [...acknowledged, ...unknown], generationAtConfirm)
        );
        // Kick a refresh so the release condition above gets satisfied.
        // Un-hiding itself happens automatically via the generation-watching
        // effect, off whichever fetch actually lands the fresh snapshot,
        // coalesced or not — this call's return value is never used for
        // that. But THIS specific fetch can itself fail to advance the
        // generation (a transient rejection on `activeAlerts`, or coalescing
        // into an in-flight fetch that also rejects it), and nothing else is
        // guaranteed to retry soon: WS/push only fire on unrelated activity,
        // and focus-refresh is behind a 60s debounce. Left unbounded, that
        // is a permanently concealed active alert — the exact outcome #3782
        // exists to prevent, just moved one step later. So retry with a
        // short bounded backoff until the generation clears the bar just
        // recorded, then give up and defer to those ambient triggers.
        void (async () => {
          for (const delayMs of ACK_REFRESH_RETRY_DELAYS_MS) {
            if (delayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
            await refresh();
            if (getActiveAlertsGeneration() > generationAtConfirm) return;
          }
        })();
        return;
      } catch (err) {
        reportInternalError(err, 'bulk-acknowledge');
        setToast({ kind: 'error', text: 'Could not acknowledge. Restored.' });
        setPendingAcks((p) => endAck(p, toRestore));
      }
    },
    [refresh, getActiveAlertsGeneration]
  );

  // The dispatch path is reached from a timer, an unmount and a replacing
  // batch, none of which re-render first. A ref keeps those callbacks pointed
  // at the current closure instead of the one captured when the window opened.
  //
  // Published from an effect, not the render body: a concurrent render that
  // React abandons must not be able to publish its callback through a ref that
  // a live timer is about to read.
  const dispatchRef = useRef(dispatchAcknowledge);
  useEffect(() => {
    dispatchRef.current = dispatchAcknowledge;
  }, [dispatchAcknowledge]);

  /**
   * THE REF IS THE SOURCE OF TRUTH; `undo` state exists only to render.
   *
   * Sending an acknowledge is irreversible, so the decision to send must happen
   * exactly once. React may invoke a `useState` updater more than once and keep
   * only the returned value — StrictMode does this deliberately — so an updater
   * is the wrong place for a network call: the state stays correct while the
   * request goes out twice. Every transition therefore runs here, synchronously,
   * against a ref that only one caller can win, and the state update afterwards
   * is pure.
   */
  const undoRef = useRef(undo);

  /** Atomically take the ids a transition releases. Returns [] if it lost. */
  const takeUndo = useCallback(
    (apply: (s: typeof emptyUndo) => { state: typeof emptyUndo; ids: readonly string[] }) => {
      const { state, ids } = apply(undoRef.current);
      undoRef.current = state;
      setUndo(state);
      return ids;
    },
    []
  );

  /**
   * Hide the rows and open an undo window. Does NOT send anything yet.
   *
   * There is no unacknowledge route, so the only way to make a stray swipe
   * recoverable is to not have sent the request. `scheduleUndo` keeps exactly
   * one window open — a second acknowledge commits the first rather than
   * stacking a toast per row, which for a 30-alert selection would be its own
   * bug.
   */
  const scheduleAcknowledge = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      setPendingAcks((p) => beginAck(p, ids));
      const { state, flush } = scheduleUndo(undoRef.current, ids);
      undoRef.current = state;
      setUndo(state);
      // The window this one replaced is now committed.
      if (flush.length > 0) void dispatchRef.current(flush);
    },
    []
  );

  // Both handlers take the token of the batch that OWNS them, not whatever is
  // current. A timer or a tap belonging to a replaced batch must release
  // nothing — otherwise batch A's expiry commits batch B, or A's Undo button
  // retracts B. The token guards in `undoAck` exist for exactly this, and
  // reading the live token here would defeat them.
  const onUndoAcknowledge = useCallback(
    (token: number) => {
      const ids = takeUndo((s) => cancelUndo(s, token));
      // Never sent, so there is nothing to reverse — just show them again.
      if (ids.length > 0) setPendingAcks((p) => endAck(p, ids));
    },
    [takeUndo]
  );

  const onUndoWindowExpired = useCallback(
    (token: number) => {
      const ids = takeUndo((s) => flushUndo(s, token));
      if (ids.length > 0) void dispatchRef.current(ids);
    },
    [takeUndo]
  );

  // Closing the undo window early splits by whether the SCREEN IS STILL THERE.
  //
  // Both paths take the batch through the same atomic `flushAllUndo`, so an
  // expiry landing at the same moment cannot also send it.

  // MOUNTED (backgrounding): close the ref AND the rendered state together, then
  // dispatch through the normal path so the result is reconciled.
  //
  // Clearing only the ref was a bug: the toast stayed mounted offering an UNDO
  // that `cancelUndo` could no longer retract, and nothing released
  // `pendingAcks`, so a failed alert stayed hidden with no error shown.
  // `dispatchAcknowledge` already does that reconciliation — surfaces errors,
  // restores the failed ids, and releases the successful ones once a fresh
  // activeAlerts fetch proves it (#3782) — so the fix is to route through it
  // rather than re-implement it here.
  const flushHeldAcknowledgesMounted = useCallback(() => {
    const { state, ids } = flushAllUndo(undoRef.current);
    undoRef.current = state;
    setUndo(state);
    if (ids.length > 0) void dispatchRef.current(ids);
  }, []);

  // UNMOUNT: the ref only. Calling setState on an unmounted component is
  // pointless, and there is no UI left to reconcile, so this fires the request
  // bare and reports failures to telemetry.
  useEffect(() => {
    return () => {
      const { state, ids } = flushAllUndo(undoRef.current);
      undoRef.current = state;
      if (ids.length === 0) return;
      void acknowledgeAlerts([...ids])
        .then(({ errors }) => {
          for (const err of errors) reportInternalError(err, 'acknowledge-alert');
        })
        .catch((err) => reportInternalError(err, 'bulk-acknowledge-unmount'));
    };
  }, []);

  // Commit on `background`, NOT on `inactive`.
  //
  // The hazard is real: iOS suspends JS timers when the app leaves the
  // foreground, so swipe → switch apps means the 5s expiry never fires, and if
  // the OS reclaims the process the acknowledge is lost after the toast already
  // said it was done.
  //
  // But `inactive` is the wrong boundary for it. Apple's documented order is
  // willResignActive → didEnterBackground → snapshot → (maybe) suspend, so
  // `background` always precedes suspension and waiting for it misses nothing.
  // `inactive` alone fires for a call banner, Control Centre, Notification
  // Centre, Face ID and system alerts — none of which suspend the app — and
  // committing there would make an IRREVERSIBLE acknowledge on a Control Centre
  // pull. This repo already reasons the same way in
  // `services/appLockMachine.test.ts` ("inactive must never start the lock
  // clock"), because the Face ID sheet itself fires `inactive`.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') flushHeldAcknowledgesMounted();
    });
    return () => sub.remove();
  }, [flushHeldAcknowledgesMounted]);

  const exitSelection = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
  }, []);

  const onAcknowledgeSelected = useCallback(async () => {
    // Drop ids whose rows are gone — another operator may have acknowledged one
    // in the meantime. The per-alert mobile route REJECTS a stale id with HTTP
    // 400 (`mobile.ts:905`), so submitting it would surface a failure toast for
    // something the user did not do wrong. (The `/alerts/bulk` route does skip
    // silently, but this PR does not use it.)
    const ids = [...reconcileSelection(selected, visibleIssues)];
    exitSelection();
    scheduleAcknowledge(ids);
  }, [selected, visibleIssues, exitSelection, scheduleAcknowledge]);

  const onAcknowledgeFromSheet = useCallback(async () => {
    if (!sheetAlert) return;
    const targetId = sheetAlert.id;
    setSheetAlert(null);
    try {
      await dispatch(acknowledgeAlertAsync(targetId)).unwrap();
      setToast({ kind: 'success', text: 'Acknowledged.' });
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : 'Could not acknowledge alert.';
      setToast({ kind: 'error', text: msg });
    }
  }, [dispatch, sheetAlert]);

  const onCopyIdFromSheet = useCallback(() => {
    if (!sheetAlert) return;
    Clipboard.setString(sheetAlert.id);
    setSheetAlert(null);
    setToast({ kind: 'success', text: 'Copied alert ID.' });
  }, [sheetAlert]);

  const onSelectSearchResult = useCallback(
    async (result: MobileSearchResult) => {
      // Dismiss the sheet first so the navigation transition is the next
      // visible thing the user sees.
      setSearchOpen(false);

      if (result.kind === 'device') {
        navigation.navigate('SystemsDeviceDetail', { device: deviceFromSearch(result) });
        return;
      }

      if (result.kind === 'alert') {
        navigation.navigate('SystemsAlertDetail', { alert: alertFromSearch(result) });
        return;
      }

      // Session: load history into the chat slice and jump to HomeTab.
      // Errors are surfaced via a toast — not the chat slice — because the
      // user is still on the Systems screen at this point.
      try {
        const { messages: rows } = await getAiSessionMessages(result.id);
        const messages = historyToMessages(rows);
        dispatch(loadHistory({ sessionId: result.id, messages }));
        const parent = navigation.getParent<NativeStackNavigationProp<MainTabParamList>>();
        if (parent) parent.navigate('HomeTab');
      } catch (err) {
        // The raw message is internal (function name + HTTP status) — report it
        // to Sentry and show the user a static string instead (issue #3141).
        // Distinct tag from the HomeTab history paths: this open comes from
        // Systems search and surfaces as a toast, not the chat error banner.
        reportInternalError(err, 'ai-session-open-from-search');
        const msg = 'Could not load that conversation.';
        dispatch(setChatError(msg));
        setToast({ kind: 'error', text: msg });
      }
    },
    [dispatch, navigation],
  );

  const showOrgs = !filterOrgId && orgRollups.length > 0;
  const showRecent = recent.length > 0;
  const showActiveIssues = visibleIssues.length > 0;
  const showActiveSkeleton = loading && activeIssues.length === 0;
  // Every section can hide independently, and the org filter suppresses the
  // Organizations list outright — so a filtered org with nothing outstanding
  // rendered a completely blank page under the chip, indistinguishable from a
  // failed load. Say what is actually true instead.
  // Gated on error and refreshing too: with all fetches failed the hook sets
  // loading=false with empty slices, and an ungated banner would assert
  // "everything is clear" directly beneath the failure notice.
  const showNothingState =
    !loading
    && !refreshing
    && !error
    && !showOrgs
    && !showRecent
    && !showActiveIssues
    && !showActiveSkeleton;

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg0 }}>
      {/* Search trigger floats top-right above the Hero. Sized to match
          the Hero's right-edge padding (spacing[6]) so it lines up with
          the copy block below it. */}
      <View
        style={{
          position: 'absolute',
          top: insets.top + spacing[3],
          right: spacing[4],
          zIndex: 10,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Search devices, alerts, conversations"
          hitSlop={10}
          onPress={() => {
            haptic.tap();
            setSearchOpen(true);
          }}
          style={({ pressed }) => ({
            width: 36,
            height: 36,
            borderRadius: 18,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: pressed ? theme.bg2 : 'transparent',
          })}
        >
          <HeaderSearchIcon color={theme.textMd} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top,
          paddingBottom: insets.bottom + spacing[8],
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.brand}
          />
        }
      >
        <Hero
          copy={hero.copy}
          segments={hero.segments}
          legend={hero.legend}
          loading={loading}
        />

        <Pressable
          onPress={() =>
            navigation.navigate('SystemsDevices', {
              orgId: filterOrgId,
              orgName: filterOrgName,
            })
          }
          accessibilityRole="button"
          accessibilityLabel="View all devices"
          style={{
            marginHorizontal: spacing[6],
            marginTop: spacing[3],
            paddingVertical: spacing[3],
            paddingHorizontal: spacing[4],
            borderRadius: 10,
            borderWidth: 1,
            borderColor: theme.border,
            backgroundColor: theme.bg1,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Text style={{ ...type.bodyMd, color: theme.textHi }}>
            {filterOrgName ? `${filterOrgName} devices` : 'All devices'}
          </Text>
          <Text style={{ ...type.meta, color: theme.textLo }}>View</Text>
        </Pressable>

        {filterOrgId && filterOrgName ? (
          <FilterChip label={filterOrgName} onClear={() => setFilterOrgId(null)} />
        ) : null}

        {/*
          Renders the message the hook computed rather than one hardcoded
          string. `ALL_FAILED_MESSAGE` ("nothing loaded") and
          `PARTIAL_FAILED_MESSAGE` ("some of this is stale") were being
          collapsed into the same sentence, so a screen showing NO real data
          and a screen showing MOSTLY real data read identically.
        */}
        {error ? (
          <View
            style={{
              paddingHorizontal: spacing[6],
              paddingTop: spacing[4],
            }}
          >
            <Text style={[type.meta, { color: palette.deny.base }]}>
              {error} Pull to try again.
            </Text>
          </View>
        ) : null}

        {/*
          Truncation is not an error — the rows shown are real. It still has to
          be said, because Active Issues and every org issue count are computed
          over this list, and a capped list renders as a confident total.
        */}
        {activeAlertsTruncated || devicesTruncated ? (
          <View
            style={{
              paddingHorizontal: spacing[6],
              paddingTop: spacing[4],
            }}
          >
            <Text style={[type.meta, { color: palette.dark.textLo }]}>
              {activeAlertsTruncated && devicesTruncated
                ? 'Showing part of the fleet and part of the active alerts. Counts below are a partial view.'
                : activeAlertsTruncated
                  ? 'Showing the most recent active alerts only. Issue counts below are a partial view.'
                  : 'Showing part of the fleet. Device counts below are a partial view.'}
            </Text>
          </View>
        ) : null}

        {showActiveSkeleton ? (
          <>
            <SectionHeader label="ACTIVE ISSUES" />
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </>
        ) : null}

        {showActiveIssues ? (
          <>
            <SectionHeader label="ACTIVE ISSUES" />
            {visibleIssues.map((alert, idx) => (
              <IssueRow
                key={alert.id}
                alert={alert}
                onPress={() =>
                  selecting
                    ? setSelected((prev) => toggleSelection(prev, alert.id))
                    : onPressIssue(alert)
                }
                onLongPress={() => {
                  if (selecting) return;
                  // Long-press is the way in, and it ticks the row you pressed
                  // so the gesture is never a wasted step.
                  setSelecting(true);
                  setSelected(new Set([alert.id]));
                }}
                onSwipeAcknowledge={() => scheduleAcknowledge([alert.id])}
                selectable={selecting}
                selected={selected.has(alert.id)}
                showDivider={idx < visibleIssues.length - 1}
                dividerColor={theme.border}
              />
            ))}
          </>
        ) : null}

        {showOrgs ? (
          <>
            <SectionHeader label="ORGANIZATIONS" />
            {orgRollups.map((org, idx) => (
              <OrgRow
                key={org.id}
                org={org}
                onPress={() => onApplyOrgFilter(org.id)}
                showDivider={idx < orgRollups.length - 1}
                dividerColor={theme.border}
              />
            ))}
          </>
        ) : null}

        {showRecent ? (
          <>
            <SectionHeader label="RECENT (24H)" />
            {recent.map((alert, idx) => (
              <RecentRow
                key={alert.id}
                alert={alert}
                onPress={() => onPressIssue(alert)}
                onLongPress={() => onLongPressAlert(alert)}
                showDivider={idx < recent.length - 1}
                dividerColor={theme.border}
              />
            ))}
          </>
        ) : null}

        {showNothingState ? (
          <View style={{ paddingHorizontal: spacing[6], paddingTop: spacing[8] }}>
            <Text
              style={{ ...type.bodyMd, color: theme.textHi, textAlign: 'center' }}
              accessibilityRole="text"
            >
              {filterOrgName ? `${filterOrgName} is all clear` : 'Everything is clear'}
            </Text>
            <Text
              style={{
                ...type.meta,
                color: theme.textLo,
                textAlign: 'center',
                marginTop: spacing[2],
              }}
            >
              {filterOrgName
                ? 'No active issues for this organization. Clear the filter to see the rest of the fleet.'
                : 'No active issues across your fleet.'}
            </Text>
          </View>
        ) : null}
      </ScrollView>

      {selecting ? (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            paddingHorizontal: spacing[4],
            paddingTop: spacing[3],
            paddingBottom: spacing[6],
            borderTopWidth: 1,
            borderTopColor: theme.border,
            backgroundColor: theme.bg1,
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing[3],
          }}
        >
          <Pressable
            onPress={exitSelection}
            accessibilityRole="button"
            style={{ paddingVertical: spacing[2], paddingHorizontal: spacing[3] }}
          >
            <Text style={{ ...type.meta, color: theme.textMd }}>Cancel</Text>
          </Pressable>
          <View style={{ flex: 1 }} />
          <Pressable
            onPress={() => void onAcknowledgeSelected()}
            disabled={selected.size === 0}
            accessibilityRole="button"
            accessibilityState={{ disabled: selected.size === 0 }}
            style={{
              paddingVertical: spacing[3],
              paddingHorizontal: spacing[4],
              borderRadius: 10,
              backgroundColor: palette.approve.base,
              opacity: selected.size === 0 ? 0.5 : 1,
            }}
          >
            <Text style={{ ...type.bodyMd, color: palette.approve.onBase }}>
              {bulkActionLabel(selected.size)}
            </Text>
          </Pressable>
        </View>
      ) : null}

      <AlertActionSheet
        visible={!!sheetAlert}
        alert={sheetAlert}
        onClose={onCloseSheet}
        onAcknowledge={onAcknowledgeFromSheet}
        onCopyId={onCopyIdFromSheet}
      />

      <SearchSheet
        visible={searchOpen}
        onCancel={() => setSearchOpen(false)}
        onSelect={onSelectSearchResult}
      />

      <Toast
        visible={!!toast}
        text={toast?.text ?? ''}
        kind={toast?.kind ?? 'success'}
        onHidden={() => setToast(null)}
        bottomOffset={insets.bottom + spacing[16]}
      />
      {undoBatch ? (
        <UndoToast
          // Keyed by token so a replacing batch remounts the timer instead of
          // inheriting the remainder of the window it displaced.
          key={undoBatch.token}
          text={undoToastLabel(undoBatch.ids.length)}
          windowMs={UNDO_WINDOW_MS}
          // The token is captured HERE, in the render that owns this batch, so
          // a callback surviving from a replaced toast releases nothing.
          onUndo={() => onUndoAcknowledge(undoBatch.token)}
          onExpire={() => onUndoWindowExpired(undoBatch.token)}
          bottomOffset={insets.bottom + spacing[16]}
        />
      ) : null}
    </View>
  );
}
