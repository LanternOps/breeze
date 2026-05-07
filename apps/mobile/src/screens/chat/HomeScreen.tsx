import { useCallback, useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';

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
import { ChatHeader } from './components/ChatHeader';
import { ColdOpenChips } from './components/ColdOpenChips';
import { Composer } from './components/Composer';
import { ConversationList } from './components/ConversationList';
import { SessionsSheet } from './components/SessionsSheet';
import { SettingsSheet } from './components/SettingsSheet';
import { historyToMessages } from './historyAdapter';

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
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const userName = useAppSelector((s) => s.auth.user?.name);

  // Abort any in-flight stream when the screen unmounts (signed out, killed).
  useEffect(() => {
    return () => {
      streamHandleRef.current?.abort();
      streamHandleRef.current = null;
    };
  }, []);

  // Refresh alerts whenever the Home tab gains focus, not just on first
  // mount. Keeps the StatusPill from going stale after a tab switch.
  // Failures are intentional no-ops; the pill falls back to "all clear".
  useFocusEffect(
    useCallback(() => {
      dispatch(fetchAlerts()).unwrap().catch(() => undefined);
    }, [dispatch]),
  );

  const beginStream = useCallback(
    async (sid: string, content: string) => {
      const assistantId = `m-${Date.now()}-a`;
      dispatch(addPendingAssistantMessage({ id: assistantId, sentAt: new Date().toISOString() }));

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
              // ApprovalGate (phase 1) handles the takeover via push. The
              // chat surface stays calm; nothing to do here in step 1.
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
    [dispatch],
  );

  const handleSend = useCallback(
    async (text: string) => {
      // Abort any prior stream before starting the next one.
      streamHandleRef.current?.abort();
      streamHandleRef.current = null;

      const userMessageId = `m-${Date.now()}-u`;
      lastUserContentRef.current = text;
      dispatch(addUserMessage({ id: userMessageId, content: text, sentAt: new Date().toISOString() }));

      let sid = sessionId;
      if (!sid) {
        try {
          dispatch(setStatus('creating-session'));
          const session = await createAiSession({});
          sid = session.id;
          dispatch(sessionCreated({ sessionId: sid }));
        } catch (err) {
          dispatch(setStatus('error'));
          const errMsg = err instanceof Error ? err.message : 'Could not start a session.';
          dispatch(failAssistantMessage({ id: userMessageId, error: errMsg }));
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
        const errMsg = err instanceof Error ? err.message : 'Could not load session.';
        dispatch(setError(errMsg));
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

