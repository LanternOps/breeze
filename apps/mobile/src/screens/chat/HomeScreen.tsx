import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  type AppStateStatus,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import * as Sentry from '@sentry/react-native';

import { useAppDispatch, useAppSelector } from '../../store';
import {
  addPendingAssistantMessage,
  addUserMessage,
  appendDelta,
  appendToolEvent,
  clearError,
  discardTurn,
  failAssistantMessage,
  finishAssistantMessage,
  loadHistory,
  planDecision,
  planNoLongerPending,
  planProposed,
  planStreamEvent,
  reconcileHistory,
  resetChat,
  sessionCreated,
  setError,
  setInFlightTool,
  setStatus,
  setTurnModel,
} from '../../store/aiChatSlice';
import { useApprovalTheme, spacing, type } from '../../theme';
import {
  abortAiPlan,
  continueAiSession,
  createAiSession,
  decideAiPlan,
  getAiSessionMessages,
  streamChat,
  StreamHttpError,
  type AiStreamEvent,
  type SseStreamHandle,
} from '../../services/aiChat';

import { fetchAlerts } from '../../store/alertsSlice';
import { fetchOne as fetchApprovalOne, setFocus as setApprovalFocus } from '../../store/approvalsSlice';
import { track } from '../../lib/analytics';
import { reportInternalError } from '../../lib/errorReporting';
import { ChatHeader } from './components/ChatHeader';
import { ColdOpenChips } from './components/ColdOpenChips';
import { Composer } from './components/Composer';
import { ContinuationPrompt } from './components/ContinuationPrompt';
import { ConversationList } from './components/ConversationList';
import { HomeFleetStrip } from './components/HomeFleetStrip';
import { ModelPicker } from './components/ModelPicker';
import { SessionsSheet } from './components/SessionsSheet';
import { SettingsSheet } from './components/SettingsSheet';
import { historyToMessages } from './historyAdapter';
import {
  CONTINUATION_FAILED,
  CONTINUATION_OPEN_FAILED,
  classifySendFailure,
  continuationTarget,
  parseTurnModel,
  type ModelChoice,
} from './modelPicker';
import { isPlanTool, planDecisionFailure } from './planState';
import { isStreamLostError, isTurnComplete, isTurnSettlingError, transcriptSignature } from './turnState';
import { useChatModelPicker } from './useChatModelPicker';

/** Catch-up poll cadence while the server is still writing the turn. */
const RECONCILE_POLL_MS = 3_000;
/**
 * Upper bound on catch-up polls. The server's own approval wait budget is 5
 * minutes (APPROVAL_WAIT_BUDGET_MS, aiAgentSdk.ts); beyond that the turn has
 * concluded one way or another and further polling is just battery.
 */
const RECONCILE_MAX_POLLS = 100;
/** How long to wait before retrying a 409 "wrapping up the previous turn". */
const SETTLE_RETRY_MS = 2_500;

export function HomeScreen() {
  const insets = useSafeAreaInsets();
  const theme = useApprovalTheme('dark');
  const dispatch = useAppDispatch();

  const sessionId = useAppSelector((s) => s.aiChat.sessionId);
  const messages = useAppSelector((s) => s.aiChat.messages);
  const status = useAppSelector((s) => s.aiChat.status);
  const error = useAppSelector((s) => s.aiChat.error);
  const inFlightTool = useAppSelector((s) => s.aiChat.inFlightTool);
  const streamingMessageId = useAppSelector((s) => s.aiChat.streamingMessageId);

  const streamHandleRef = useRef<SseStreamHandle | null>(null);
  const lastUserContentRef = useRef<string | null>(null);
  const reconcileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Bumped on every send / new chat / session switch / unmount. Async work
   * that started under an older generation (a catch-up fetch, a settle
   * retry) must not write into the turn that replaced it.
   */
  const turnGenRef = useRef(0);
  // Read by the mount/foreground effects without re-subscribing on every change.
  const statusRef = useRef(status);
  statusRef.current = status;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const streamingIdRef = useRef(streamingMessageId);
  streamingIdRef.current = streamingMessageId;

  /** Cancel every pending async continuation of the current turn. */
  const cancelTurnWork = useCallback(() => {
    turnGenRef.current += 1;
    streamHandleRef.current?.abort();
    streamHandleRef.current = null;
    if (reconcileTimerRef.current) clearTimeout(reconcileTimerRef.current);
    reconcileTimerRef.current = null;
    if (settleRetryTimerRef.current) clearTimeout(settleRetryTimerRef.current);
    settleRetryTimerRef.current = null;
  }, []);
  const [draft, setDraft] = useState<string | undefined>(undefined);
  // W05: the composer's model menu, and a switch parked for a continuation.
  const picker = useChatModelPicker();
  const [continuing, setContinuing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const userName = useAppSelector((s) => s.auth.user?.name);

  // Abort any in-flight stream when the screen unmounts (signed out, killed).
  useEffect(() => cancelTurnWork, [cancelTurnWork]);

  /**
   * Catch up from the server's persisted transcript when the live stream is
   * gone. The turn keeps running server-side whatever happens to this socket
   * (the HTTP handler is only a subscriber to the session's event bus), so
   * everything it produced is in `GET /ai/sessions/:id`. Polls while the
   * transcript is still partial, e.g. a tool blocked on an approval.
   */
  const reconcileFromServer = useCallback(
    async (sid: string, attempt = 0, previousSignature: string | null = null) => {
      if (reconcileTimerRef.current) clearTimeout(reconcileTimerRef.current);
      reconcileTimerRef.current = null;
      const gen = turnGenRef.current;
      // Surface a terminal failure on the streaming row itself: the error
      // strip below the list is hidden while a message is streaming, so a
      // bare setError would leave a permanent, unretryable RUNNING row.
      const giveUp = (message: string) => {
        const streamingId = streamingIdRef.current;
        if (streamingId) dispatch(failAssistantMessage({ id: streamingId, error: message }));
        else dispatch(setError(message));
      };
      try {
        const { messages: rows, lastTurnModel } = await getAiSessionMessages(sid);
        // A send, new chat or session switch superseded this catch-up.
        if (gen !== turnGenRef.current || sessionIdRef.current !== sid) return;
        const msgs = historyToMessages(rows, lastTurnModel);
        const signature = transcriptSignature(msgs);
        // "Complete" is only trusted once the transcript has stopped changing
        // between two polls: a tool_result can be persisted a beat before the
        // model's follow-up text, and that instant looks finished.
        const complete = isTurnComplete(msgs) && signature === previousSignature;
        dispatch(reconcileHistory({ sessionId: sid, messages: msgs, complete }));
        if (complete) {
          // The stream that would have committed a pick is gone: re-read the
          // chat's stamped choice instead.
          if (picker.selection()) void picker.load({ sessionId: sid });
          return;
        }
        if (attempt >= RECONCILE_MAX_POLLS) {
          giveUp('Lost track of this reply. Tap to retry.');
          return;
        }
        reconcileTimerRef.current = setTimeout(() => {
          void reconcileFromServer(sid, attempt + 1, signature);
        }, RECONCILE_POLL_MS);
      } catch (err) {
        if (gen !== turnGenRef.current) return;
        reportInternalError(err, 'ai-chat-reconcile');
        giveUp('Could not reconnect to this conversation. Tap to retry.');
      }
    },
    [dispatch, picker],
  );

  // A remount mid-turn (the approval takeover used to unmount this screen;
  // a JS relaunch still can) leaves Redux saying "streaming" with no socket
  // behind it. Catch up rather than sit on RUNNING forever.
  useEffect(() => {
    const sid = sessionIdRef.current;
    if (statusRef.current === 'streaming' && sid && !streamHandleRef.current) {
      void reconcileFromServer(sid);
    }
    // W05: this chat's model menu (or a new chat's, from the caller's org).
    void picker.load({ sessionId: sid });
    // Mount only.
  }, []);

  // iOS suspends the XHR after ~30s in the background, and the resume does
  // not always deliver an `onerror`. On a real background→active transition
  // (not the 'inactive' blip of a Face ID sheet) drop the socket and catch up
  // from the transcript — the server never stopped.
  useEffect(() => {
    let previous: AppStateStatus = AppState.currentState ?? 'active';
    const sub = AppState.addEventListener('change', (next) => {
      const wasBackground = previous === 'background';
      previous = next;
      if (!wasBackground || next !== 'active') return;
      const sid = sessionIdRef.current;
      if (statusRef.current !== 'streaming' || !sid) return;
      streamHandleRef.current?.abort();
      streamHandleRef.current = null;
      void reconcileFromServer(sid);
    });
    return () => sub.remove();
  }, [reconcileFromServer]);

  // Refresh alerts whenever the Home tab gains focus, not just on first
  // mount. Keeps the StatusPill from going stale after a tab switch.
  // Failures are intentional no-ops; the pill falls back to "all clear".
  useFocusEffect(
    useCallback(() => {
      dispatch(fetchAlerts()).unwrap().catch(() => undefined);
    }, [dispatch]),
  );

  const beginStream = useCallback(
    (
      sid: string,
      content: string,
      turn: { userMessageId?: string; model?: ModelChoice } = {},
      retry?: { assistantId: string },
    ) => {
      const assistantId = retry?.assistantId ?? `m-${Date.now()}-a`;
      const { model } = turn;
      // The pick that rode on this turn is the chat's choice once the turn ran.
      // Reference check: a pick changed since (the menu is disabled mid-turn,
      // but be exact) is not what ran.
      const commitPick = () => {
        if (model && picker.selection() === model) picker.commit();
      };
      if (!retry) picker.setSuggested([]);
      if (!retry) {
        dispatch(addPendingAssistantMessage({ id: assistantId, sentAt: new Date().toISOString() }));
      }

      streamHandleRef.current = streamChat({
        sessionId: sid,
        content,
        model,
        onEvent: (ev: AiStreamEvent) => {
          switch (ev.type) {
            case 'message_start':
              // Server message id is informational; we already have a local id.
              break;
            case 'content_delta':
              dispatch(appendDelta({ id: assistantId, delta: ev.delta }));
              // Once content begins, the in-flight tool caption (if any)
              // collapses — content has resumed.
              dispatch(setInFlightTool(null));
              break;
            case 'tool_use_start': {
              const input =
                ev.input && typeof ev.input === 'object'
                  ? (ev.input as Record<string, unknown>)
                  : undefined;
              dispatch(setInFlightTool({ toolUseId: ev.toolUseId, toolName: ev.toolName, input }));
              dispatch(appendToolEvent({
                messageId: assistantId,
                event: { toolUseId: ev.toolUseId, toolName: ev.toolName, state: 'started', input },
              }));
              // Plan-first approval mode: the card appears now and fills in
              // when plan_approval_required brings the steps.
              if (isPlanTool(ev.toolName)) {
                dispatch(planProposed({ messageId: assistantId, toolUseId: ev.toolUseId }));
              }
              break;
            }
            case 'tool_result':
              // The slice merges by toolUseId; the prior `tool_use_start`
              // dispatch already wrote the toolName, so the placeholder
              // here is only used if events arrive out of order.
              dispatch(appendToolEvent({
                messageId: assistantId,
                event: {
                  toolUseId: ev.toolUseId,
                  toolName: 'tool',
                  state: 'completed',
                  output: ev.output,
                  isError: ev.isError ?? false,
                  handoff: ev.handoff,
                },
              }));
              dispatch(setInFlightTool(null));
              break;
            case 'message_end':
              break;
            case 'plan_approval_required':
            case 'plan_step_start':
            case 'plan_step_complete':
            case 'plan_complete':
              // In-chat only: the server creates no approval_requests row and
              // sends no push for a plan, so the PlanCard is its only answer.
              dispatch(planStreamEvent({ messageId: assistantId, event: ev }));
              break;
            case 'approval_required':
              // When approvalRequestId is present (server linked the AI tool execution
              // to an approval_requests row), surface the takeover immediately by
              // focusing the approvals slice. ApprovalGate watches focusId and renders
              // ApprovalScreen on top of everything. The parallel push notification
              // path also resolves here, harmlessly — both call setFocus/fetchOne
              // idempotently.
              if (ev.approvalRequestId) {
                dispatch(setApprovalFocus(ev.approvalRequestId));
                dispatch(fetchApprovalOne(ev.approvalRequestId));
              }
              // Older server (no approvalRequestId): no-op fallback. The 5-min
              // server-side waitForApproval timeout will eventually resolve.
              break;
            case 'turn_model': {
              const turnModel = parseTurnModel(ev.turnModel);
              if (turnModel) dispatch(setTurnModel({ messageId: assistantId, turnModel }));
              break;
            }
            case 'model_refusal':
              // The menu marks these as "Suggested" (spec §9.1 "choose another").
              picker.setSuggested(
                Array.isArray(ev.alternatives) ? ev.alternatives.map((a) => a.offeringId) : [],
              );
              break;
            case 'error':
              dispatch(failAssistantMessage({ id: assistantId, error: ev.message }));
              break;
            case 'done':
              commitPick();
              dispatch(finishAssistantMessage({
                id: assistantId,
                failIfEmpty: { error: 'No reply. Tap to retry.' },
              }));
              break;
            case 'unknown':
              // warning, title_updated, tool_use_input, … — ignored.
              break;
          }
        },
        onError: (err) => {
          streamHandleRef.current = null;
          // W05: the server refused this turn's model before it ran.
          if (err instanceof StreamHttpError) {
            const failure = classifySendFailure(err.status, err.body);
            const optimisticIds = [assistantId, ...(turn.userMessageId ? [turn.userMessageId] : [])];
            if (failure.kind === 'continuation') {
              // The switch cannot resume this chat. The message is parked for
              // the continuation prompt, not lost or errored.
              dispatch(discardTurn({ ids: optimisticIds }));
              picker.setContinuation({ required: failure.required, pendingContent: content, sourceSessionId: sid });
              return;
            }
            if (failure.kind === 'model_unavailable') {
              // The chosen / stored model is no longer usable: refresh the menu
              // so the technician can pick another, and hand the text back.
              dispatch(discardTurn({ ids: optimisticIds }));
              dispatch(setError(failure.message));
              setDraft(content);
              void picker.load({ sessionId: sid });
              return;
            }
          }
          // 409 while the previous turn settles (≤3s server-side). One quiet
          // retry instead of a red "Stopped. Tap to retry." for a race the
          // server documents as expected. Generation-guarded: a send or new
          // chat in the meantime cancels it rather than opening a competing
          // stream for a stale prompt.
          if (!retry && isTurnSettlingError(err.message)) {
            const gen = turnGenRef.current;
            settleRetryTimerRef.current = setTimeout(() => {
              settleRetryTimerRef.current = null;
              if (gen !== turnGenRef.current || sessionIdRef.current !== sid) return;
              beginStream(sid, content, turn, { assistantId });
            }, SETTLE_RETRY_MS);
            return;
          }
          // The socket died but the turn did not: catch up from the transcript.
          if (isStreamLostError(err)) {
            void reconcileFromServer(sid);
            return;
          }
          dispatch(failAssistantMessage({ id: assistantId, error: err.message }));
        },
        onDone: () => {
          // `done` SSE event already finishes the message. This fires on
          // socket close without a `done` event — finish defensively.
          commitPick();
          dispatch(finishAssistantMessage({
            id: assistantId,
            failIfEmpty: { error: 'No reply. Tap to retry.' },
          }));
        },
      });
    },
    [dispatch, picker, reconcileFromServer],
  );

  const handleSend = useCallback(
    async (text: string, opts: { sessionId?: string } = {}) => {
      // #5104: the composer keyboard otherwise stays up and covers the
      // streaming reply as it arrives.
      Keyboard.dismiss();
      // Abort any prior stream, catch-up poll or settle retry before starting
      // the next turn.
      cancelTurnWork();
      const gen = turnGenRef.current;

      const userMessageId = `m-${Date.now()}-u`;
      lastUserContentRef.current = text;
      dispatch(addUserMessage({ id: userMessageId, content: text, sentAt: new Date().toISOString() }));
      // Length only — never the message body. See analytics.ts privacy notes.
      track('chat_message_sent', { length: text.length });

      // W05: the composer's pending choice rides on this message — or, for
      // the first message of a new chat, on the session create (web parity).
      let model = picker.pending();
      let sid = opts.sessionId ?? sessionId;
      if (!sid) {
        const hadMenu = picker.hasMenu();
        try {
          dispatch(setStatus('creating-session'));
          const session = await createAiSession(model ? { model } : {});
          sid = session.id;
          if (gen !== turnGenRef.current) return;
          dispatch(sessionCreated({ sessionId: sid }));
          track('chat_session_created');
        } catch (err) {
          dispatch(setStatus('error'));
          // The raw message is internal (function name + HTTP status) — report it
          // to Sentry and show the user a static string instead (issue #3141).
          reportInternalError(err, 'ai-session-create');
          dispatch(failAssistantMessage({ id: userMessageId, error: 'Could not start a session.' }));
          // A refused pick (model gone since the menu loaded): re-read the menu.
          if (model) void picker.load({});
          return;
        }
        if (model) {
          // The create carried the pick; it must not ride on the message too.
          picker.commit();
          model = undefined;
        }
        if (hadMenu) {
          void picker.load({ sessionId: sid });
        } else {
          // No menu before the session existed (a partner-scope token has no
          // org of its own). The session's menu is known now: apply the stored
          // pick to this first turn, which starts a fresh transcript, so a
          // switch here never needs a continuation.
          await picker.load({ sessionId: sid, applyPref: true });
          if (gen !== turnGenRef.current) return;
          model = picker.pending();
        }
      }

      beginStream(sid, text, { userMessageId, model });
    },
    [beginStream, cancelTurnWork, dispatch, picker, sessionId],
  );

  /** W05: continue the parked message in a new chat seeded with a summary. */
  const handleContinue = useCallback(async () => {
    const parked = picker.continuationRef.current;
    if (!parked) return;
    const target = continuationTarget(parked.required, picker.selection());
    if (!target) return;
    setContinuing(true);
    try {
      const res = await continueAiSession(parked.sourceSessionId, target);
      if (!res.ok) {
        // A 4xx carries a user-facing reason (budget, a reply still running);
        // anything else is internal. The prompt stays open to retry.
        if (res.status < 400 || res.status >= 500) {
          reportInternalError(new Error(`continue failed: ${res.status} ${res.error}`), 'ai-session-continue');
        }
        dispatch(setError(res.status >= 400 && res.status < 500 ? res.error : CONTINUATION_FAILED));
        return;
      }
      // The pick was spent creating the new chat; it must not ride on it again.
      picker.clearSelection();
      cancelTurnWork();
      try {
        const { messages: rows, lastTurnModel } = await getAiSessionMessages(res.sessionId);
        dispatch(loadHistory({ sessionId: res.sessionId, messages: historyToMessages(rows, lastTurnModel) }));
      } catch (err) {
        // Send only into the chat we actually opened. The parked message stays
        // (the prompt is still bound to the old chat on screen).
        reportInternalError(err, 'ai-session-continue-open');
        dispatch(setError(CONTINUATION_OPEN_FAILED));
        return;
      }
      lastUserContentRef.current = null;
      picker.setContinuation(null);
      void picker.load({ sessionId: res.sessionId });
      await handleSend(parked.pendingContent, { sessionId: res.sessionId });
    } finally {
      setContinuing(false);
    }
  }, [cancelTurnWork, dispatch, handleSend, picker]);

  /** W05: drop the pick and send the parked message on the current model. */
  const handleKeepModel = useCallback(() => {
    const parked = picker.continuationRef.current;
    if (!parked) return;
    picker.clearSelection();
    picker.setContinuation(null);
    void handleSend(parked.pendingContent, { sessionId: parked.sourceSessionId });
  }, [handleSend, picker]);

  const handleRetry = useCallback(() => {
    const lastContent = lastUserContentRef.current;
    if (!lastContent) return;
    dispatch(clearError());
    void handleSend(lastContent);
  }, [dispatch, handleSend]);

  const handleChip = useCallback((text: string) => {
    setDraft(text);
    // The composer lifts the draft into its input; the user taps send.
    // We do not auto-send, so the user retains control.
  }, []);

  const handleNewChat = useCallback(() => {
    cancelTurnWork();
    lastUserContentRef.current = null;
    dispatch(resetChat());
    picker.reset();
    void picker.load({});
  }, [cancelTurnWork, dispatch, picker]);

  const handleOpenHistory = useCallback(() => {
    setHistoryOpen(true);
  }, []);

  const handleSelectSession = useCallback(
    async (sid: string) => {
      setHistoryOpen(false);
      cancelTurnWork();
      try {
        const { messages: rows, lastTurnModel } = await getAiSessionMessages(sid);
        const messages = historyToMessages(rows, lastTurnModel);
        dispatch(loadHistory({ sessionId: sid, messages }));
        // A continuation parked for another chat never follows us here, and a
        // pick made there must not ride on this one.
        if (picker.continuationRef.current?.sourceSessionId !== sid) picker.setContinuation(null);
        picker.clearSelection();
        picker.setSuggested([]);
        void picker.load({ sessionId: sid });
      } catch (err) {
        // The raw message is internal (function name + HTTP status) — report it
        // to Sentry and show the user a static string instead (issue #3115).
        Sentry.captureException(err, { tags: { area: 'ai-sessions-history' } });
        dispatch(setError('Could not load that conversation.'));
      }
    },
    [cancelTurnWork, dispatch, picker],
  );

  /**
   * Approve or reject the plan the server is blocked on. Resolves to an
   * inline error for the card, or null. A 400/404/409 means the server no
   * longer holds the plan open, so the card settles instead of nagging.
   */
  const handlePlanDecide = useCallback(
    async (messageId: string, approved: boolean): Promise<string | null> => {
      const sid = sessionIdRef.current;
      if (!sid) return 'This conversation is no longer open.';
      const res = await decideAiPlan(sid, approved);
      if (res.ok) {
        dispatch(planDecision({ messageId, decision: approved ? 'approved' : 'rejected' }));
        return null;
      }
      if (planDecisionFailure(res.status) === 'gone') {
        dispatch(planNoLongerPending({ messageId }));
        return null;
      }
      reportInternalError(new Error(`approve-plan failed: ${res.status} ${res.error}`), 'ai-plan-decide');
      return approved ? 'Could not approve the plan. Try again.' : 'Could not reject the plan. Try again.';
    },
    [dispatch],
  );

  /** Stop a running plan; plan_complete(aborted) then settles the card. */
  const handlePlanStop = useCallback(async (_messageId: string): Promise<string | null> => {
    const sid = sessionIdRef.current;
    if (!sid) return 'This conversation is no longer open.';
    const res = await abortAiPlan(sid);
    if (res.ok) return null;
    if (planDecisionFailure(res.status) === 'gone') return 'This plan has already finished.';
    reportInternalError(new Error(`abort-plan failed: ${res.status} ${res.error}`), 'ai-plan-abort');
    return 'Could not stop the plan. Try again.';
  }, []);

  const isCold = messages.length === 0 && status !== 'creating-session';
  // Bound to the chat it came from: another chat never sees, or sends, it.
  const parkedContinuation =
    picker.continuation && picker.continuation.sourceSessionId === sessionId ? picker.continuation : null;

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg0, paddingTop: insets.top }}>
      <ChatHeader
        userName={userName}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenHistory={handleOpenHistory}
        onNewChat={handleNewChat}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
        style={{ flex: 1 }}
      >
        {isCold ? (
          <View style={{ flex: 1, justifyContent: 'flex-end' }}>
            <HomeFleetStrip />
            <ColdOpenChips onPick={handleChip} />
          </View>
        ) : (
          <ConversationList
            messages={messages}
            inFlightTool={inFlightTool}
            onRetry={(id) => {
              const msg = messages.find((m) => m.id === id);
              if (msg && msg.role === 'assistant' && msg.failed) {
                handleRetry();
              }
            }}
            onPlanDecide={handlePlanDecide}
            onPlanStop={handlePlanStop}
          />
        )}

        {error && !streamingMessageId ? (
          <View style={{ paddingHorizontal: spacing[6], paddingBottom: spacing[3] }}>
            <Text style={[type.meta, { color: theme.deny }]} numberOfLines={2}>
              {error}
            </Text>
          </View>
        ) : null}

        {/*
          No bottom safe-area padding here: the bottom-tab navigator
          already renders above the home-indicator inset. Adding our own
          padding double-counts and leaves a visible gap between the
          composer and the tab bar.
        */}
        {parkedContinuation ? (
          <ContinuationPrompt
            required={parkedContinuation.required}
            busy={continuing}
            canContinue={continuationTarget(parkedContinuation.required, picker.state.selection) !== null}
            onContinue={() => void handleContinue()}
            onKeep={handleKeepModel}
          />
        ) : null}

        <ModelPicker picker={picker} disabled={status === 'streaming' || status === 'creating-session'} />

        <Composer
          onSend={(text) => void handleSend(text)}
          disabled={status === 'creating-session'}
          draft={draft}
          onDraftConsumed={() => setDraft(undefined)}
          // Overrides Composer's own default ("Ask Breeze.") — a placeholder
          // ending in a period reads as a completed sentence rather than an
          // invitation to type (#5105).
          placeholder="Ask Breeze"
        />
      </KeyboardAvoidingView>

      <SessionsSheet
        visible={historyOpen}
        onCancel={() => setHistoryOpen(false)}
        onSelect={handleSelectSession}
      />

      <SettingsSheet
        visible={settingsOpen}
        onCancel={() => setSettingsOpen(false)}
      />
    </View>
  );
}

