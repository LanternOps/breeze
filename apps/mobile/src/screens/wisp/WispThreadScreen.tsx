import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { useToast } from '../../components/toast/ToastHost';
import { safeReportInternalError as safeReport } from '../../lib/errorReporting';
import type { HomeStackParamList } from '../../navigation/MainNavigator';
import { navigateToTicket } from '../../navigation/navigationRef';
import { createAiSession, streamChat, type AiStreamEvent, type SseStreamHandle } from '../../services/aiChat';
import {
  dismissWispConcern,
  getWispActivity,
  getWispHome,
  getWispThread,
  listWispConcerns,
  pauseWispGrant,
  resumeWispGrant,
  sendWispConcernFeedback,
  snoozeWispConcern,
  type WispConcern,
  type WispCurrentActivity,
  type WispThread,
} from '../../services/wisp';
import { store, useAppDispatch } from '../../store';
import { fetchOne, refreshPending, setFocus } from '../../store/approvalsSlice';
import { radii, spacing, type, useApprovalTheme } from '../../theme';
import { Composer } from '../chat/components/Composer';
import { ConversationList } from '../chat/components/ConversationList';
import { WispConcernSheet } from './WispConcernSheet';
import { WispActivityTimeline, WispBriefCard, WispLinksList } from './WispHomePanels';
import {
  activityLoadMoreCursor,
  activityPageFailed,
  activityPageLoaded,
  EMPTY_ACTIVITY,
  homeSectionsFromPayload,
  type ActivityState,
  type WispHomeSections,
} from './wispHomeSections';
import {
  concernActionFailureCopy,
  feedbackFailureCopy,
  severityLabel,
  statusLabel,
} from './wispConcernCopy';
import {
  grantBannerCopy,
  liveLineCopy,
  pauseControlState,
  pauseFailureCopy,
  pauseResultCopy,
  replyEnabled,
  spendMeterCopy,
  spendMeterState,
  threadSummaryCopy,
  type PauseAction,
} from './wispThreadCopy';
import {
  concernSections,
  errorStatus,
  initialExpandedConcern,
  INITIAL_WISP_SESSION,
  resolveApprovalFocus,
  shouldAutoOpenApproval,
  wispSessionReducer,
} from './wispThreadState';

type Props = NativeStackScreenProps<HomeStackParamList, 'WispThread'>;

type Phase = 'loading' | 'ready' | 'notFound' | 'error';

/** w00 A31: the live "Wisp is checking …" line refreshes this often while the screen is focused. */
const LIVE_LINE_POLL_MS = 30_000;

/** W08: page size of the full activity timeline (cursor-paged). */
const ACTIVITY_PAGE = 20;

const statusOf = errorStatus;

/**
 * Wisp W06 (spec §7.4, w00 "Nudges (W06)"). Where a `wisp_nudge` push lands:
 * the thread summary, the concerns Wisp raised for this user (W05 routes,
 * keyed by `grantId`), and a reply box on the existing chat transport that
 * creates its session with `wispGrantId` — every tool call in it runs under the
 * grant's ceiling server-side (W04).
 *
 * Approval cards open the existing ApprovalScreen takeover: ApprovalGate shows
 * it in a Modal over this screen, so the thread is the back target.
 *
 * The chat state is a LOCAL reducer (`wispSessionReducer`), never the Home
 * chat's `aiChat` slice — a nudge tap must not clobber the conversation the
 * technician had open on Home. Every decision lives in a node-tested sibling
 * module; this file is wiring and layout.
 *
 * W08 (spec §17.2, w00 A35) adds the home sections — the morning brief and the
 * thread's entity links from `GET /wisp/home`, and the full activity timeline
 * from `GET /wisp/thread/:id/activity` (cursor-paged). Both are best-effort:
 * a failure hides or annotates its own section and never blocks the thread.
 */
export function WispThreadScreen({ route, navigation }: Props): React.JSX.Element {
  const params = route.params;
  const theme = useApprovalTheme('dark');
  const insets = useSafeAreaInsets();
  const dispatch = useAppDispatch();
  const { show: showToast } = useToast();

  const [phase, setPhase] = useState<Phase>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [thread, setThread] = useState<WispThread | null>(null);
  const [concerns, setConcerns] = useState<WispConcern[]>([]);
  const [concernsError, setConcernsError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [session, dispatchSession] = useReducer(wispSessionReducer, INITIAL_WISP_SESSION);
  const [current, setCurrent] = useState<WispCurrentActivity | null>(null);
  const [pausing, setPausing] = useState(false);
  const [home, setHome] = useState<WispHomeSections | null>(null);
  const [activity, setActivity] = useState<ActivityState>(EMPTY_ACTIVITY);

  const sessionIdRef = useRef<string | null>(null);
  /** Bumped on every thread switch: async work started for an older thread drops its result. */
  const generation = useRef(0);
  const streamRef = useRef<SseStreamHandle | null>(null);
  const mounted = useRef(true);
  /** The pushed approval card is opened at most once per (thread, intent). */
  const autoOpenedKey = useRef<string | null>(null);
  /**
   * Bumped by every activity request: only the latest one may write. A pull to
   * refresh (first page) supersedes an in-flight "show earlier" page, so a
   * stale page can never merge onto the fresh list or rewind the cursor.
   */
  const activityRequest = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      streamRef.current?.abort();
      streamRef.current = null;
    };
  }, []);

  // A different thread (a second nudge tapped while this one is open) starts
  // a fresh conversation: the old session belongs to the old grant.
  useEffect(() => {
    generation.current += 1;
    streamRef.current?.abort();
    streamRef.current = null;
    sessionIdRef.current = null;
    dispatchSession({ type: 'reset' });
    // Never render (or reply under) the previous thread's grant while the new
    // one loads or if its load fails.
    setThread(null);
    setConcerns([]);
    setCurrent(null);
    setHome(null);
    setActivity(EMPTY_ACTIVITY);
  }, [params.threadId, params.grantId]);

  /**
   * Brief + links. A 404 is the expected answer when the home is dark (flag
   * off, no active grant, or a server older than W08): hide quietly.
   */
  const loadHome = useCallback(async () => {
    const gen = generation.current;
    try {
      const body = await getWispHome(params.grantId);
      if (mounted.current && gen === generation.current) setHome(homeSectionsFromPayload(body));
    } catch (err) {
      const status = statusOf(err);
      // 404 = the home is dark: hide it. Anything else is transient or a bug —
      // keep the last good brief/links rather than blanking them on a refresh.
      if (status === 404 && mounted.current && gen === generation.current) setHome(null);
      if (status !== 404) safeReport(err, 'wisp-thread-home');
    }
  }, [params.grantId]);

  /** First page when `cursor` is null (a refresh replaces the list), else the next page appended. */
  const loadActivity = useCallback(
    async (cursor: string | null) => {
      const gen = generation.current;
      const req = ++activityRequest.current;
      const current = () => mounted.current && gen === generation.current && req === activityRequest.current;
      setActivity((a) => ({ ...a, loading: true, error: null }));
      try {
        const page = await getWispActivity(params.threadId, {
          limit: ACTIVITY_PAGE,
          ...(cursor ? { cursor } : {}),
        });
        if (!current()) return;
        setActivity((a) => activityPageLoaded(a, cursor, page));
      } catch (err) {
        const status = statusOf(err);
        if (current()) setActivity((a) => activityPageFailed(a, status));
        if (status !== 404) safeReport(err, 'wisp-thread-activity');
      }
    },
    [params.threadId],
  );

  const loadConcerns = useCallback(async () => {
    const gen = generation.current;
    try {
      const list = await listWispConcerns(params.grantId);
      if (!mounted.current || gen !== generation.current) return list;
      setConcerns(list);
      setConcernsError(null);
      return list;
    } catch (err) {
      if (mounted.current && gen === generation.current) setConcernsError('Could not load concerns. Pull to retry.');
      safeReport(err, 'wisp-thread-concerns');
      return null;
    }
  }, [params.grantId]);

  const load = useCallback(async () => {
    const gen = generation.current;
    // Not awaited with the thread: the home sections never hold up first paint.
    void loadHome();
    void loadActivity(null);
    try {
      const [t, list] = await Promise.all([getWispThread(params.threadId), loadConcerns()]);
      if (!mounted.current || gen !== generation.current) return;
      setThread(t);
      setPhase('ready');
      setHighlightId(list ? initialExpandedConcern(params, list) : null);
    } catch (err) {
      if (!mounted.current || gen !== generation.current) return;
      // Resolve the phase before reporting: a throwing reporter must not
      // strand the screen on the spinner (FindingDetailScreen's rule).
      if (statusOf(err) === 404) {
        setPhase('notFound');
      } else {
        setLoadError(err instanceof Error ? err.message : 'Could not load this Wisp thread');
        setPhase('error');
      }
      safeReport(err, 'wisp-thread-load');
    }
  }, [params.threadId, params.grantId, params.concernId, loadConcerns, loadHome, loadActivity]);

  useEffect(() => {
    setPhase('loading');
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    if (mounted.current) setRefreshing(false);
  }, [load]);

  // w00 A31 live line: what Wisp is assessing right now. Best-effort — a
  // failed poll just hides the line; it never blocks the thread.
  useFocusEffect(
    useCallback(() => {
      let stopped = false;
      const poll = async () => {
        try {
          const page = await getWispActivity(params.threadId, { limit: 1 });
          if (!stopped && mounted.current) setCurrent(page.current);
        } catch {
          if (!stopped && mounted.current) setCurrent(null);
        }
      };
      void poll();
      const timer = setInterval(() => void poll(), LIVE_LINE_POLL_MS);
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    }, [params.threadId]),
  );

  /** w00 A29: the grantor's own pause / resume (POST /wisp/grants/:id/pause|resume). */
  const togglePause = useCallback(
    async (action: PauseAction) => {
      if (!thread || pausing) return;
      setPausing(true);
      try {
        const next = await (action === 'pause' ? pauseWispGrant : resumeWispGrant)(thread.grant.id);
        if (!mounted.current) return;
        setThread((t) => (t ? { ...t, grant: { ...t.grant, status: next.status, pausedReason: next.pausedReason } } : t));
        showToast({ kind: 'success', text: pauseResultCopy(action) });
      } catch (err) {
        const status = statusOf(err);
        if (mounted.current) showToast({ kind: 'error', text: pauseFailureCopy(action, status) });
        if (status !== 403 && status !== 404 && status !== 409) safeReport(err, 'wisp-grant-pause');
        // 404/409: the grant changed elsewhere — reload so the header control
        // reflects the server instead of offering the same refused action.
        if ((status === 404 || status === 409) && mounted.current) void load();
      } finally {
        if (mounted.current) setPausing(false);
      }
    },
    [thread, pausing, showToast, load],
  );

  const pauseControl = thread ? pauseControlState(thread.grant) : null;
  useEffect(() => {
    navigation.setOptions({
      headerRight: pauseControl
        ? () => (
            <Pressable
              testID="wisp-thread-pause"
              accessibilityRole="button"
              disabled={pausing}
              onPress={() => void togglePause(pauseControl.action)}
              hitSlop={8}
            >
              <Text style={[type.bodyMd, { color: theme.brand, opacity: pausing ? 0.5 : 1 }]}>
                {pauseControl.action === 'pause' ? 'Pause' : 'Resume'}
              </Text>
            </Pressable>
          )
        : undefined,
    });
  }, [navigation, pauseControl?.action, pausing, togglePause, theme.brand]);

  /**
   * Map the concern's INTENT id onto this user's pending approval row and hand
   * it to ApprovalGate. Nothing is focused when the card was decided elsewhere
   * (Review Focus 4): no takeover flash, a toast instead.
   */
  const openApproval = useCallback(
    async (intentId: string): Promise<boolean> => {
      const result = await resolveApprovalFocus({
        getPending: () => store.getState().approvals.pending,
        refresh: () => dispatch(refreshPending()).unwrap(),
        intentId,
      });
      if (!mounted.current) return false;
      if (result.kind === 'refresh_failed') {
        // Could not check — never claim "decided" for a failed refresh.
        showToast({ kind: 'error', text: "Couldn't check approvals. Try again." });
        safeReport(result.error, 'wisp-approval-refresh');
        return false;
      }
      if (result.kind === 'decided') {
        showToast({ kind: 'error', text: 'That approval was already decided.' });
        return true;
      }
      setSheetId(null);
      dispatch(setFocus(result.approvalId));
      dispatch(fetchOne(result.approvalId))
        .unwrap()
        .catch(() => {
          // The rejected reducer surfaces the approvals error banner.
        });
      return true;
    },
    [dispatch, showToast],
  );

  // A nudge that points at an approval card opens it once, after the concerns
  // load — so a card whose concern is already resolved is never opened. A
  // refresh that failed clears the key so the next focus/pull can retry.
  useEffect(() => {
    if (phase !== 'ready') return;
    const decision = shouldAutoOpenApproval(params, concerns, autoOpenedKey.current);
    if (!decision.open || !params.approvalIntentId) return;
    autoOpenedKey.current = decision.key;
    void openApproval(params.approvalIntentId).then((settled) => {
      if (!settled && autoOpenedKey.current === decision.key) autoOpenedKey.current = null;
    });
  }, [phase, params, concerns, openApproval]);

  const runConcernAction = useCallback(
    async (action: () => Promise<void>, success: string) => {
      setBusy(true);
      try {
        await action();
        if (mounted.current) showToast({ kind: 'success', text: success });
      } catch (err) {
        // 404/409 = resolved, dismissed or decided elsewhere (Review Focus 3):
        // not a failure worth reporting, just stale on this phone.
        const status = statusOf(err);
        if (mounted.current) showToast({ kind: 'error', text: concernActionFailureCopy(status) });
        if (status !== 404 && status !== 409) safeReport(err, 'wisp-concern-action');
      } finally {
        if (mounted.current) {
          setBusy(false);
          setSheetId(null);
        }
        await loadConcerns();
      }
    },
    [loadConcerns, showToast],
  );

  const onFeedback = useCallback(
    async (concernId: string, useful: boolean, note?: string) => {
      setBusy(true);
      try {
        await sendWispConcernFeedback(concernId, params.grantId, { useful, note });
        if (mounted.current) showToast({ kind: 'success', text: 'Thanks — Wisp will use this.' });
      } catch (err) {
        const status = statusOf(err);
        if (mounted.current) showToast({ kind: 'error', text: feedbackFailureCopy(status) });
        if (status !== 404 && status !== 409) safeReport(err, 'wisp-concern-feedback');
      } finally {
        if (mounted.current) setBusy(false);
        // Keep the sheet open: the refetched row now shows the recorded choice.
        await loadConcerns();
      }
    },
    [params.grantId, loadConcerns, showToast],
  );

  const onSend = useCallback(
    async (text: string) => {
      if (!thread || !replyEnabled(thread.grant.status, session.status)) return;
      const gen = generation.current;
      let sessionId = sessionIdRef.current;
      if (!sessionId) {
        dispatchSession({ type: 'creating' });
        try {
          // orgId must be the grant's own org (or absent for a partner-wide
          // grant): the API refuses an org-scoped grant whose session org
          // differs (W04 grant_scope_mismatch).
          const created = await createAiSession({
            wispGrantId: params.grantId,
            orgId: thread.grant.orgId ?? undefined,
          });
          sessionId = created.id;
        } catch (err) {
          if (!mounted.current) return;
          dispatchSession({ type: 'failed', error: 'Could not start a Wisp conversation.' });
          showToast({ kind: 'error', text: 'Could not start a Wisp conversation.' });
          safeReport(err, 'wisp-session-create');
          return;
        }
        // A thread switch during the create: this session belongs to the old grant.
        if (!mounted.current || gen !== generation.current) return;
        sessionIdRef.current = sessionId;
        dispatchSession({ type: 'created', sessionId });
      }

      const stamp = Date.now();
      const assistantId = `wisp-${stamp}-a`;
      const now = () => new Date().toISOString();
      dispatchSession({ type: 'userSent', id: `wisp-${stamp}-u`, content: text, sentAt: now() });

      streamRef.current = streamChat({
        sessionId,
        content: text,
        onEvent: (ev: AiStreamEvent) => {
          if (!mounted.current) return;
          switch (ev.type) {
            case 'content_delta':
              dispatchSession({ type: 'delta', id: assistantId, delta: ev.delta, sentAt: now() });
              break;
            case 'tool_use_start': {
              const input =
                ev.input && typeof ev.input === 'object' ? (ev.input as Record<string, unknown>) : undefined;
              dispatchSession({
                type: 'toolEvent',
                id: assistantId,
                sentAt: now(),
                event: { toolUseId: ev.toolUseId, toolName: ev.toolName, state: 'started', input },
              });
              break;
            }
            case 'tool_result':
              dispatchSession({
                type: 'toolEvent',
                id: assistantId,
                sentAt: now(),
                event: {
                  toolUseId: ev.toolUseId,
                  toolName: 'tool',
                  state: 'completed',
                  output: ev.output,
                  isError: ev.isError ?? false,
                  handoff: ev.handoff,
                },
              });
              break;
            case 'approval_required':
              // Same as Home: an approval_requests id surfaces the takeover.
              if (ev.approvalRequestId) {
                dispatch(setFocus(ev.approvalRequestId));
                dispatch(fetchOne(ev.approvalRequestId))
                  .unwrap()
                  .catch(() => undefined);
              }
              break;
            case 'error':
              dispatchSession({ type: 'failed', error: ev.message });
              // A server-sent stream error never reaches onError; report it here.
              safeReport(new Error(`wisp stream error event: ${ev.message}`), 'wisp-thread-stream-event');
              break;
            default:
              break;
          }
        },
        onError: (err) => {
          streamRef.current = null;
          if (!mounted.current) return;
          dispatchSession({ type: 'failed', error: err.message || 'Wisp could not answer.' });
          safeReport(err, 'wisp-thread-stream');
        },
        onDone: () => {
          streamRef.current = null;
          if (!mounted.current) return;
          dispatchSession({ type: 'done' });
          // A turn may have resolved or snoozed a concern.
          void loadConcerns();
        },
      });
    },
    [thread, session.status, params.grantId, dispatch, showToast, loadConcerns],
  );

  if (phase === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={theme.textMd} />
      </View>
    );
  }

  if (phase === 'notFound' || (phase === 'error' && !thread)) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing[6] }}>
        <Text style={[type.bodyMd, { color: theme.textHi }]}>
          {phase === 'notFound' ? 'This Wisp thread is no longer available' : 'Could not load this Wisp thread'}
        </Text>
        {phase === 'error' && loadError ? (
          <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[2], textAlign: 'center' }]}>
            {loadError}
          </Text>
        ) : null}
        {phase === 'error' ? (
          <Pressable onPress={() => void onRefresh()} style={{ marginTop: spacing[5] }}>
            <Text style={[type.bodyMd, { color: theme.brand }]}>Try again</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  if (!thread) return <View style={{ flex: 1 }} />;

  const sections = concernSections(concerns, new Date());
  const banner = grantBannerCopy(thread.grant);
  const sheetConcern = sheetId ? concerns.find((c) => c.id === sheetId) ?? null : null;
  const hasMessages = session.messages.length > 0;
  const liveLine = thread.grant.status === 'active' ? liveLineCopy(current) : null;
  const spend = spendMeterState(thread.grant.spentTodayCents, thread.grant.budgetCentsPerDay);
  const spendCopy = spendMeterCopy(
    thread.grant.spentTodayCents,
    thread.grant.budgetCentsPerDay,
    thread.grant.budgetResetsAt,
    new Date(),
  );

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      // The native-stack header sits above this view: safe-area top + the
      // 44pt iOS navigation bar.
      keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + 44 : 0}
      style={{ flex: 1 }}
    >
      <ScrollView
        style={{ flex: hasMessages ? 0.45 : 1 }}
        contentContainerStyle={{ padding: spacing[5], paddingBottom: spacing[6] }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={theme.textMd} />
        }
      >
        <View style={{ backgroundColor: theme.bg1, borderRadius: radii.lg, padding: spacing[5] }}>
          <Text style={[type.metaCaps, { color: theme.textLo }]}>WISP</Text>
          <Text style={[type.body, { color: theme.textHi, marginTop: spacing[2] }]}>
            {threadSummaryCopy(thread.summary)}
          </Text>
          {liveLine ? (
            <Text testID="wisp-thread-live" style={[type.meta, { color: theme.brand, marginTop: spacing[3] }]}>
              {liveLine}
            </Text>
          ) : null}
          {spendCopy ? (
            <Text
              testID="wisp-thread-spend"
              style={[
                type.meta,
                {
                  marginTop: spacing[3],
                  color:
                    spend?.level === 'exhausted' ? theme.deny : spend?.level === 'warn' ? theme.warning : theme.textMd,
                },
              ]}
            >
              {spendCopy}
              {spend?.level === 'exhausted' ? ' · Wisp is sending a digest only until the reset.' : ''}
            </Text>
          ) : null}
          {banner ? (
            <Text testID="wisp-thread-banner" style={[type.meta, { color: theme.warning, marginTop: spacing[3] }]}>
              {banner}
            </Text>
          ) : null}
        </View>

        {home?.brief ? <WispBriefCard sections={home.brief.sections} theme={theme} /> : null}

        {concernsError ? (
          <Text style={[type.meta, { color: theme.deny, marginTop: spacing[4] }]}>{concernsError}</Text>
        ) : null}

        {sections.length === 0 && !concernsError ? (
          <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[5] }]}>
            Nothing needs you right now.
          </Text>
        ) : null}

        {sections.map((section) => (
          <View key={section.key} style={{ marginTop: spacing[6] }}>
            <Text style={[type.metaCaps, { color: theme.textLo }]}>{section.title.toUpperCase()}</Text>
            {section.concerns.map((c) => (
              <Pressable
                key={c.id}
                testID={`wisp-concern-${c.id}`}
                accessibilityRole="button"
                onPress={() => setSheetId(c.id)}
                style={{
                  marginTop: spacing[3],
                  padding: spacing[4],
                  borderRadius: radii.md,
                  backgroundColor: theme.bg1,
                  borderWidth: 1,
                  borderColor: c.id === highlightId ? theme.brand : theme.border,
                }}
              >
                <Text style={[type.meta, { color: theme.textLo }]}>
                  {severityLabel(c.severity)} · {statusLabel(c.status)}
                </Text>
                <Text style={[type.body, { color: theme.textHi, marginTop: spacing[1] }]} numberOfLines={3}>
                  {c.summary}
                </Text>
              </Pressable>
            ))}
          </View>
        ))}

        <WispLinksList links={home?.links ?? []} theme={theme} onOpenTicket={(id) => navigateToTicket(id)} />

        <WispActivityTimeline
          items={activity.items}
          hasMore={activity.nextCursor !== null}
          loading={activity.loading}
          error={activity.error}
          onLoadMore={() => void loadActivity(activityLoadMoreCursor(activity))}
          theme={theme}
        />
      </ScrollView>

      {hasMessages ? (
        <View style={{ flex: 0.55, borderTopWidth: 1, borderTopColor: theme.border }}>
          <ConversationList messages={session.messages} inFlightTool={null} />
        </View>
      ) : null}

      <View style={{ paddingBottom: insets.bottom }}>
        <Composer
          onSend={(text) => void onSend(text)}
          disabled={!replyEnabled(thread.grant.status, session.status)}
          placeholder={thread.grant.status === 'active' ? 'Reply to Wisp…' : 'Wisp is not active'}
        />
      </View>

      <WispConcernSheet
        concern={sheetConcern}
        busy={busy}
        onClose={() => setSheetId(null)}
        onSnooze={(until) =>
          sheetConcern &&
          void runConcernAction(() => snoozeWispConcern(sheetConcern.id, params.grantId, until), 'Snoozed.')
        }
        onDismiss={() =>
          sheetConcern &&
          void runConcernAction(() => dismissWispConcern(sheetConcern.id, params.grantId), 'Dismissed.')
        }
        onReviewApproval={(intentId) => void openApproval(intentId)}
        onFeedback={(useful, note) => sheetConcern && void onFeedback(sheetConcern.id, useful, note)}
      />
    </KeyboardAvoidingView>
  );
}
