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
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { useToast } from '../../components/toast/ToastHost';
import { safeReportInternalError as safeReport } from '../../lib/errorReporting';
import type { HomeStackParamList } from '../../navigation/MainNavigator';
import { createAiSession, streamChat, type AiStreamEvent, type SseStreamHandle } from '../../services/aiChat';
import {
  dismissWispConcern,
  getWispThread,
  listWispConcerns,
  snoozeWispConcern,
  type WispConcern,
  type WispThread,
} from '../../services/wisp';
import { store, useAppDispatch } from '../../store';
import { fetchOne, refreshPending, setFocus } from '../../store/approvalsSlice';
import { radii, spacing, type, useApprovalTheme } from '../../theme';
import { Composer } from '../chat/components/Composer';
import { ConversationList } from '../chat/components/ConversationList';
import { WispConcernSheet } from './WispConcernSheet';
import { concernActionFailureCopy, severityLabel, statusLabel } from './wispConcernCopy';
import { grantBannerCopy, replyEnabled, threadSummaryCopy } from './wispThreadCopy';
import {
  approvalOpenTarget,
  approvalRequestIdForIntent,
  concernSections,
  initialExpandedConcern,
  INITIAL_WISP_SESSION,
  wispSessionReducer,
} from './wispThreadState';

type Props = NativeStackScreenProps<HomeStackParamList, 'WispThread'>;

type Phase = 'loading' | 'ready' | 'notFound' | 'error';

const statusOf = (err: unknown): number | undefined => {
  const s = (err as { statusCode?: unknown; status?: unknown } | null)?.statusCode
    ?? (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
};

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
 */
export function WispThreadScreen({ route }: Props): React.JSX.Element {
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

  const sessionIdRef = useRef<string | null>(null);
  const streamRef = useRef<SseStreamHandle | null>(null);
  const mounted = useRef(true);
  /** The pushed approval card is opened at most once per (thread, intent). */
  const autoOpenedKey = useRef<string | null>(null);

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
    streamRef.current?.abort();
    streamRef.current = null;
    sessionIdRef.current = null;
    dispatchSession({ type: 'reset' });
  }, [params.threadId, params.grantId]);

  const loadConcerns = useCallback(async () => {
    try {
      const list = await listWispConcerns(params.grantId);
      if (!mounted.current) return list;
      setConcerns(list);
      setConcernsError(null);
      return list;
    } catch (err) {
      if (mounted.current) setConcernsError('Could not load concerns. Pull to retry.');
      safeReport(err, 'wisp-thread-concerns');
      return null;
    }
  }, [params.grantId]);

  const load = useCallback(async () => {
    try {
      const [t, list] = await Promise.all([getWispThread(params.threadId), loadConcerns()]);
      if (!mounted.current) return;
      setThread(t);
      setPhase('ready');
      setHighlightId(list ? initialExpandedConcern(params, list) : null);
    } catch (err) {
      if (!mounted.current) return;
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
  }, [params.threadId, params.grantId, params.concernId, loadConcerns]);

  useEffect(() => {
    setPhase('loading');
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    if (mounted.current) setRefreshing(false);
  }, [load]);

  /**
   * Map the concern's INTENT id onto this user's pending approval row and hand
   * it to ApprovalGate. Nothing is focused when the card was decided elsewhere
   * (Review Focus 4): no takeover flash, a toast instead.
   */
  const openApproval = useCallback(
    async (intentId: string) => {
      let approvalId = approvalRequestIdForIntent(store.getState().approvals.pending, intentId);
      if (!approvalId) {
        await dispatch(refreshPending())
          .unwrap()
          .catch(() => undefined);
        approvalId = approvalRequestIdForIntent(store.getState().approvals.pending, intentId);
      }
      if (!mounted.current) return;
      if (!approvalId) {
        showToast({ kind: 'error', text: 'That approval was already decided.' });
        return;
      }
      setSheetId(null);
      dispatch(setFocus(approvalId));
      dispatch(fetchOne(approvalId))
        .unwrap()
        .catch(() => {
          // The rejected reducer surfaces the approvals error banner.
        });
    },
    [dispatch, showToast],
  );

  // A nudge that points at an approval card opens it once, after the concerns
  // load — so a card whose concern is already resolved is never opened.
  useEffect(() => {
    if (phase !== 'ready' || !params.approvalIntentId) return;
    const key = `${params.threadId}:${params.approvalIntentId}`;
    if (autoOpenedKey.current === key) return;
    autoOpenedKey.current = key;
    const pushed = params.concernId ? concerns.find((c) => c.id === params.concernId) : undefined;
    if (pushed && approvalOpenTarget(pushed) === null) return;
    void openApproval(params.approvalIntentId);
  }, [phase, params.threadId, params.approvalIntentId, params.concernId, concerns, openApproval]);

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

  const onSend = useCallback(
    async (text: string) => {
      if (!thread || !replyEnabled(thread.grant.status, session.status)) return;
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
        if (!mounted.current) return;
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
          {banner ? (
            <Text testID="wisp-thread-banner" style={[type.meta, { color: theme.warning, marginTop: spacing[3] }]}>
              {banner}
            </Text>
          ) : null}
        </View>

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
      />
    </KeyboardAvoidingView>
  );
}
