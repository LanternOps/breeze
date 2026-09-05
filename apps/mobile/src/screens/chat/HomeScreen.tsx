import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  type AppStateStatus,
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
  failAssistantMessage,
  finishAssistantMessage,
  loadHistory,
  reconcileHistory,
  resetChat,
  sessionCreated,
  setError,
  setInFlightTool,
  setStatus,
} from '../../store/aiChatSlice';
import { useApprovalTheme, spacing, type } from '../../theme';
import {
  createAiSession,
  getAiSessionMessages,
  streamChat,
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
import { ConversationList } from './components/ConversationList';
import { SessionsSheet } from './components/SessionsSheet';
import { SettingsSheet } from './components/SettingsSheet';
import { historyToMessages } from './historyAdapter';
import { isStreamLostError, isTurnComplete, isTurnSettlingError } from './turnState';

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
  // Read by the mount/foreground effects without re-subscribing on every change.
  const statusRef = useRef(status);
  statusRef.current = status;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const userName = useAppSelector((s) => s.auth.user?.name);

  // Abort any in-flight stream when the screen unmounts (signed out, killed).
  useEffect(() => {
    return () => {
      streamHandleRef.current?.abort();
      streamHandleRef.current = null;
      if (reconcileTimerRef.current) clearTimeout(reconcileTimerRef.current);
      reconcileTimerRef.current = null;
    };
  }, []);

  /**
   * Catch up from the server's persisted transcript when the live stream is
   * gone. The turn keeps running server-side whatever happens to this socket
   * (the HTTP handler is only a subscriber to the session's event bus), so
   * everything it produced is in `GET /ai/sessions/:id`. Polls while the
   * transcript is still partial, e.g. a tool blocked on an approval.
   */
  const reconcileFromServer = useCallback(
    async (sid: string, attempt = 0) => {
      if (reconcileTimerRef.current) clearTimeout(reconcileTimerRef.current);
      reconcileTimerRef.current = null;
      try {
        const { messages: rows } = await getAiSessionMessages(sid);
        // A new chat or a different session was opened while we were fetching.
        if (sessionIdRef.current !== sid) return;
        const msgs = historyToMessages(rows);
        const complete = isTurnComplete(msgs);
        dispatch(reconcileHistory({ sessionId: sid, messages: msgs, complete }));
        if (complete) return;
        if (attempt >= RECONCILE_MAX_POLLS) {
          dispatch(setError('Lost track of this reply. Tap to retry.'));
          return;
        }
        reconcileTimerRef.current = setTimeout(() => {
          void reconcileFromServer(sid, attempt + 1);
        }, RECONCILE_POLL_MS);
      } catch (err) {
        reportInternalError(err, 'ai-chat-reconcile');
        dispatch(setError('Could not reconnect to this conversation. Tap to retry.'));
      }
    },
    [dispatch],
  );

  // A remount mid-turn (the approval takeover used to unmount this screen;
  // a JS relaunch still can) leaves Redux saying "streaming" with no socket
  // behind it. Catch up rather than sit on RUNNING forever.
  useEffect(() => {
    const sid = sessionIdRef.current;
    if (statusRef.current === 'streaming' && sid && !streamHandleRef.current) {
      void reconcileFromServer(sid);
    }
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
    (sid: string, content: string, retry?: { assistantId: string }) => {
      const assistantId = retry?.assistantId ?? `m-${Date.now()}-a`;
      if (!retry) {
        dispatch(addPendingAssistantMessage({ id: assistantId, sentAt: new Date().toISOString() }));
      }

      streamHandleRef.current = streamChat({
        sessionId: sid,
        content,
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
            case 'tool_use_start':
              dispatch(setInFlightTool({ toolUseId: ev.toolUseId, toolName: ev.toolName }));
              dispatch(appendToolEvent({
                messageId: assistantId,
                event: { toolUseId: ev.toolUseId, toolName: ev.toolName, state: 'started' },
              }));
              break;
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
                },
              }));
              dispatch(setInFlightTool(null));
              break;
            case 'message_end':
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
            case 'error':
              dispatch(failAssistantMessage({ id: assistantId, error: ev.message }));
              break;
            case 'done':
              dispatch(finishAssistantMessage({
                id: assistantId,
                failIfEmpty: { error: 'No reply. Tap to retry.' },
              }));
              break;
            case 'unknown':
              // plan_*, warning, title_updated — ignored in step 1.
              break;
          }
        },
        onError: (err) => {
          streamHandleRef.current = null;
          // 409 while the previous turn settles (≤3s server-side). One quiet
          // retry instead of a red "Stopped. Tap to retry." for a race the
          // server documents as expected.
          if (!retry && isTurnSettlingError(err.message)) {
            setTimeout(() => {
              if (sessionIdRef.current === sid) beginStream(sid, content, { assistantId });
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
          dispatch(finishAssistantMessage({
            id: assistantId,
            failIfEmpty: { error: 'No reply. Tap to retry.' },
          }));
        },
      });
    },
    [dispatch, reconcileFromServer],
  );

  const handleSend = useCallback(
    async (text: string) => {
      // Abort any prior stream (or catch-up poll) before starting the next one.
      streamHandleRef.current?.abort();
      streamHandleRef.current = null;
      if (reconcileTimerRef.current) clearTimeout(reconcileTimerRef.current);
      reconcileTimerRef.current = null;

      const userMessageId = `m-${Date.now()}-u`;
      lastUserContentRef.current = text;
      dispatch(addUserMessage({ id: userMessageId, content: text, sentAt: new Date().toISOString() }));
      // Length only — never the message body. See analytics.ts privacy notes.
      track('chat_message_sent', { length: text.length });

      let sid = sessionId;
      if (!sid) {
        try {
          dispatch(setStatus('creating-session'));
          const session = await createAiSession({});
          sid = session.id;
          dispatch(sessionCreated({ sessionId: sid }));
          track('chat_session_created');
        } catch (err) {
          dispatch(setStatus('error'));
          // The raw message is internal (function name + HTTP status) — report it
          // to Sentry and show the user a static string instead (issue #3141).
          reportInternalError(err, 'ai-session-create');
          dispatch(failAssistantMessage({ id: userMessageId, error: 'Could not start a session.' }));
          return;
        }
      }

      beginStream(sid, text);
    },
    [beginStream, dispatch, sessionId],
  );

  const handleRetry = useCallback(() => {
    const lastContent = lastUserContentRef.current;
    if (!lastContent) return;
    dispatch(clearError());
    handleSend(lastContent);
  }, [dispatch, handleSend]);

  const handleChip = useCallback((text: string) => {
    setDraft(text);
    // The composer lifts the draft into its input; the user taps send.
    // We do not auto-send, so the user retains control.
  }, []);

  const handleNewChat = useCallback(() => {
    streamHandleRef.current?.abort();
    streamHandleRef.current = null;
    lastUserContentRef.current = null;
    dispatch(resetChat());
  }, [dispatch]);

  const handleOpenHistory = useCallback(() => {
    setHistoryOpen(true);
  }, []);

  const handleSelectSession = useCallback(
    async (sid: string) => {
      setHistoryOpen(false);
      streamHandleRef.current?.abort();
      streamHandleRef.current = null;
      try {
        const { messages: rows } = await getAiSessionMessages(sid);
        const messages = historyToMessages(rows);
        dispatch(loadHistory({ sessionId: sid, messages }));
      } catch (err) {
        // The raw message is internal (function name + HTTP status) — report it
        // to Sentry and show the user a static string instead (issue #3115).
        Sentry.captureException(err, { tags: { area: 'ai-sessions-history' } });
        dispatch(setError('Could not load that conversation.'));
      }
    },
    [dispatch],
  );

  const isCold = messages.length === 0 && status !== 'creating-session';

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
        <Composer
          onSend={handleSend}
          disabled={status === 'creating-session'}
          draft={draft}
          onDraftConsumed={() => setDraft(undefined)}
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

