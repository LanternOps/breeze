import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ENDPOINT_CHAT_LIMITS, endpointChatBodyIssues } from '@breeze/shared';
import { showToast } from '@/components/shared/Toast';
import { ActionError } from '@/lib/runAction';
import { useHashState } from '@/lib/useHashState';
import { endpointMessageIssueKey } from '@/lib/endpointMessages';
import {
  closeConversation,
  createConversationPoller,
  deviceChatCapability,
  getConversation,
  isLiveStatus,
  latestMessageStamp,
  listConversations,
  mergeMessages,
  openConversation,
  sendChatMessage,
  type ChatConversation,
  type ChatMessage,
} from '@/lib/endpointChat';

export interface DeviceChatPanelProps {
  deviceId: string;
  osType: 'windows' | 'macos' | 'linux' | string;
  agentVersion: string | null | undefined;
}

/**
 * Hash scheme: `#chat` is the tab (list + start form); `#chat/<conversationId>`
 * is the tab with that conversation selected. Mirrors `#scripts/<executionId>`.
 */
export function chatIdFromHash(hash: string): string | undefined {
  const [tab, id] = hash.split('/');
  if (tab !== 'chat' || !id) return undefined;
  try {
    return decodeURIComponent(id);
  } catch {
    return undefined;
  }
}

export function chatHash(conversationId: string | null): string {
  return conversationId ? `chat/${encodeURIComponent(conversationId)}` : 'chat';
}

const KNOWN_ERRORS = new Set([
  'chat_requires_assist',
  'agent_unsupported',
  'device_offline',
  'platform_unsupported',
  'conversation_active',
  'rate_limited',
  'open_timeout',
  'chat_window_failed',
  'conversation_not_open',
  'feature_disabled',
  'no_permission',
  'device_not_found',
]);

function newId(): string {
  return crypto.randomUUID();
}

function bodyIssueKeys(body: string): string[] {
  return [...new Set(endpointChatBodyIssues(body).map(endpointMessageIssueKey))];
}

interface Loaded {
  conversation: ChatConversation;
  messages: ChatMessage[];
}

export default function DeviceChatPanel({ deviceId, osType, agentVersion }: DeviceChatPanelProps) {
  const { t } = useTranslation('devices');
  const capability = deviceChatCapability({ osType, agentVersion });
  const supported = capability.supported;

  const [selectedId, setSelectedId] = useHashState<string | undefined>(undefined, chatIdFromHash);
  const [conversations, setConversations] = useState<ChatConversation[] | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const [startBody, setStartBody] = useState('');
  const [startError, setStartError] = useState<{ code: string; conversationId?: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const [closeNotice, setCloseNotice] = useState(false);
  // 'paused' = a poll failed and will be retried; 'gone' = 403/404, polling stopped for good.
  const [pollState, setPollState] = useState<'ok' | 'paused' | 'gone'>('ok');

  // One id per compose: a retry of the same content replays instead of duplicating.
  const startIdRef = useRef<string | null>(null);
  const messageIdRef = useRef<string | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = loaded?.messages ?? [];

  const errorText = useCallback(
    (code: string, fallbackKey: string) =>
      KNOWN_ERRORS.has(code)
        ? // i18n-dynamic: code is a closed set (KNOWN_ERRORS) of API error tokens
          t(/* i18n-dynamic */ `endpointChat.errors.${code}`)
        : t(/* i18n-dynamic */ fallbackKey),
    [t],
  );

  const select = useCallback(
    (id: string | null) => {
      window.location.hash = chatHash(id);
      setCloseNotice(false);
      setSelectedId(id ?? undefined);
    },
    [setSelectedId],
  );

  const refreshList = useCallback(async () => {
    try {
      setConversations(await listConversations(deviceId));
      setListFailed(false);
    } catch {
      setListFailed(true);
    }
  }, [deviceId]);

  useEffect(() => {
    if (!supported) return;
    void refreshList();
  }, [supported, refreshList]);

  // Load the hash-selected conversation (skipped when we already hold it).
  useEffect(() => {
    if (!supported || !selectedId) {
      setLoaded(null);
      return;
    }
    if (loaded?.conversation.id === selectedId) return;
    let cancelled = false;
    setLoadFailed(false);
    getConversation(selectedId)
      .then((snap) => {
        if (!cancelled) setLoaded({ conversation: snap.conversation, messages: snap.messages });
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [supported, selectedId]);

  // Poll while the conversation is live; the poller itself honours tab visibility.
  const loadedId = loaded?.conversation.id;
  const live = loaded ? isLiveStatus(loaded.conversation.status) : false;
  useEffect(() => {
    if (!loadedId || !live) return;
    const newest = latestMessageStamp(messagesRef.current);
    setPollState('ok');
    const poller = createConversationPoller({
      conversationId: loadedId,
      initialStatus: 'open',
      initialSince: newest,
      onError: (_err, terminal) => setPollState(terminal ? 'gone' : 'paused'),
      onUpdate: (snap) => {
        setPollState('ok');
        setLoaded((prev) =>
          prev && prev.conversation.id === snap.conversation.id
            ? { conversation: snap.conversation, messages: mergeMessages(prev.messages, snap.messages) }
            : prev,
        );
      },
    });
    poller.start();
    return () => poller.stop();
  }, [loadedId, live]);

  const startIssues = useMemo(() => bodyIssueKeys(startBody), [startBody]);
  const bodyIssues = useMemo(() => bodyIssueKeys(body), [body]);

  if (!supported) {
    return (
      <div className="rounded-lg border bg-card p-4">
        <p data-testid="chat-unsupported" className="text-sm text-muted-foreground">
          {t('endpointChat.unsupported')}
        </p>
      </div>
    );
  }

  const footer = (
    <p className="text-xs text-muted-foreground">{t('endpointChat.footer')}</p>
  );

  const handleActionFailure = (err: unknown, onCode: (code: string, err: ActionError) => void) => {
    if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
    if (err instanceof ActionError) {
      const obj = (err.body ?? {}) as { error?: unknown };
      onCode(typeof obj.error === 'string' ? obj.error : 'generic', err);
      return; // ActionError already toasted (unless suppressed for inline display)
    }
    showToast({ type: 'error', message: t('endpointChat.errors.generic') });
  };

  const start = async () => {
    const trimmed = startBody.trim();
    if (!trimmed || startIssues.length > 0 || starting) return;
    if (!startIdRef.current) startIdRef.current = newId();
    setStarting(true);
    setStartError(null);
    try {
      const snap = await openConversation(
        { conversationId: startIdRef.current, deviceId, body: trimmed },
        {
          errorFallback: t('endpointChat.errors.open_failed'),
          // every failure is rendered inline below, so runAction must not toast it too
          suppressErrorToast: () => true,
        },
      );
      startIdRef.current = null;
      setStartBody('');
      setLoaded({ conversation: snap.conversation, messages: snap.messages });
      select(snap.conversation.id);
      void refreshList();
    } catch (err) {
      handleActionFailure(err, (code, e) => {
        const obj = (e.body ?? {}) as { conversationId?: unknown };
        setStartError({ code, conversationId: typeof obj.conversationId === 'string' ? obj.conversationId : undefined });
      });
    } finally {
      setStarting(false);
    }
  };

  const send = async () => {
    const trimmed = body.trim();
    const current = loaded?.conversation;
    if (!current || !trimmed || bodyIssues.length > 0 || sending) return;
    if (!messageIdRef.current) messageIdRef.current = newId();
    setSending(true);
    setSendError(null);
    try {
      const res = await sendChatMessage(
        current.id,
        { messageId: messageIdRef.current, body: trimmed },
        {
          errorFallback: t('endpointChat.errors.send_failed'),
          // every failure is rendered inline below, so runAction must not toast it too
          suppressErrorToast: () => true,
        },
      );
      messageIdRef.current = null;
      setBody('');
      setLoaded((prev) =>
        prev && prev.conversation.id === current.id
          ? { ...prev, messages: mergeMessages(prev.messages, [res.message]) }
          : prev,
      );
    } catch (err) {
      handleActionFailure(err, (code) => {
        setSendError(code);
        // The conversation ended or the device dropped: re-read so the panel shows the truth.
        if (code === 'conversation_not_open') {
          getConversation(current.id)
            .then((snap) => setLoaded({ conversation: snap.conversation, messages: mergeMessages(messagesRef.current, snap.messages) }))
            .catch(() => undefined);
        }
      });
    } finally {
      setSending(false);
    }
  };

  const end = async () => {
    const current = loaded?.conversation;
    if (!current || ending) return;
    setEnding(true);
    setCloseNotice(false);
    try {
      const res = await closeConversation(current.id, {
        errorFallback: t('endpointChat.errors.close_failed'),
      });
      setLoaded((prev) => (prev && prev.conversation.id === current.id ? { ...prev, conversation: res.conversation } : prev));
      setCloseNotice(res.agentNotified === false);
      void refreshList();
    } catch (err) {
      handleActionFailure(err, () => undefined);
    } finally {
      setEnding(false);
    }
  };

  const statusLine = (c: ChatConversation): string => {
    if (c.status === 'failed') {
      return errorText(c.errorCode ?? 'generic', 'endpointChat.errors.generic');
    }
    // i18n-dynamic: status is a closed union
    return t(/* i18n-dynamic */ `endpointChat.status.${c.status}`);
  };

  const counter = (value: string, testId: string) => (
    <span data-testid={testId} className="text-xs text-muted-foreground">
      {value.length} / {ENDPOINT_CHAT_LIMITS.bodyMax}
    </span>
  );

  const issueList = (keys: string[], testId: string) =>
    keys.length > 0 ? (
      <ul data-testid={testId} className="list-disc pl-5 text-xs text-destructive">
        {keys.map((key) => (
          // i18n-dynamic: key is a closed union from endpointMessageIssueKey
          <li key={key}>{t(/* i18n-dynamic */ `endpointMessages.issues.${key}`)}</li>
        ))}
      </ul>
    ) : null;

  // ---- Selected conversation ----
  if (selectedId) {
    const current = loaded?.conversation;
    return (
      <div data-testid="device-chat-panel" className="space-y-4 rounded-lg border bg-card p-4">
        <button
          type="button"
          data-testid="chat-back"
          onClick={() => select(null)}
          className="text-sm text-primary hover:underline"
        >
          {t('endpointChat.back')}
        </button>
        {loadFailed && <p className="text-sm text-destructive">{t('endpointChat.loadFailed')}</p>}
        {!current && !loadFailed && <p className="text-sm text-muted-foreground">{t('endpointChat.loading')}</p>}
        {current && pollState === 'gone' && (
          <p data-testid="chat-unavailable" className="text-sm text-destructive">
            {t('endpointChat.unavailable')}
          </p>
        )}
        {current && pollState !== 'gone' && (
          <>
            <div className="flex items-center justify-between gap-3">
              <p data-testid="chat-status" data-status={current.status} className="text-sm font-medium">
                {statusLine(current)}
              </p>
              {live && (
                <button
                  type="button"
                  data-testid="chat-end"
                  disabled={ending}
                  onClick={() => void end()}
                  className="h-9 rounded-md border px-3 text-sm hover:bg-muted disabled:opacity-50"
                >
                  {ending ? t('endpointChat.ending') : t('endpointChat.endChat')}
                </button>
              )}
            </div>
            {pollState === 'paused' && (
              <p data-testid="chat-updates-paused" role="status" className="text-xs text-warning">
                {t('endpointChat.updatesPaused')}
              </p>
            )}
            {closeNotice && (
              <p data-testid="chat-close-notice" role="status" className="text-xs text-muted-foreground">
                {t('endpointChat.closeNotAnnounced')}
              </p>
            )}
            <ul data-testid="chat-transcript" className="space-y-2" aria-live="polite">
              {loaded!.messages.map((m) => {
                const fromUser = m.direction === 'from_user';
                return (
                  <li
                    key={m.id}
                    data-testid={`chat-message-${m.id}`}
                    data-direction={m.direction}
                    className={`max-w-[85%] rounded-lg border px-3 py-2 text-sm ${
                      fromUser ? 'mr-auto bg-muted' : 'ml-auto bg-primary/10'
                    }`}
                  >
                    <p className="mb-1 text-xs font-medium text-muted-foreground">
                      {fromUser
                        ? t('endpointChat.fromUser', { name: m.senderUsername ?? t('endpointChat.user') })
                        : (m.senderName ?? t('endpointChat.technician'))}
                    </p>
                    <p className="whitespace-pre-wrap break-words">{m.body}</p>
                    {!fromUser && m.errorCode && (
                      <p data-testid={`chat-undelivered-${m.id}`} className="mt-1 text-xs text-destructive">
                        {t('endpointChat.undelivered')}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
            {live && (
              <div className="space-y-2">
                <label className="block text-sm font-medium" htmlFor="chat-message-body">
                  {t('endpointChat.messageLabel')}
                </label>
                <textarea
                  id="chat-message-body"
                  data-testid="chat-message-body"
                  rows={3}
                  value={body}
                  maxLength={ENDPOINT_CHAT_LIMITS.bodyMax}
                  onChange={(e) => {
                    messageIdRef.current = null;
                    setSendError(null);
                    setBody(e.target.value);
                  }}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                />
                <div className="flex items-center justify-between">
                  {counter(body, 'chat-message-counter')}
                  <button
                    type="button"
                    data-testid="chat-message-send"
                    disabled={sending || !body.trim() || bodyIssues.length > 0}
                    onClick={() => void send()}
                    className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground disabled:opacity-50"
                  >
                    {sending ? t('endpointChat.sending') : t('endpointChat.send')}
                  </button>
                </div>
                {issueList(bodyIssues, 'chat-message-issues')}
                {sendError && (
                  <p data-testid="chat-message-error" className="text-xs text-destructive">
                    {errorText(sendError, 'endpointChat.errors.send_failed')}
                  </p>
                )}
                {footer}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  // ---- List + start form ----
  return (
    <div data-testid="device-chat-panel" className="space-y-6 rounded-lg border bg-card p-4">
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{t('endpointChat.startHeading')}</h3>
        <label className="block text-sm font-medium" htmlFor="chat-start-body">
          {t('endpointChat.firstMessageLabel')}
        </label>
        <textarea
          id="chat-start-body"
          data-testid="chat-start-body"
          rows={3}
          value={startBody}
          maxLength={ENDPOINT_CHAT_LIMITS.bodyMax}
          onChange={(e) => {
            startIdRef.current = null;
            setStartError(null);
            setStartBody(e.target.value);
          }}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        />
        <div className="flex items-center justify-between">
          {counter(startBody, 'chat-start-counter')}
          <button
            type="button"
            data-testid="chat-start-submit"
            disabled={starting || !startBody.trim() || startIssues.length > 0}
            onClick={() => void start()}
            className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground disabled:opacity-50"
          >
            {starting ? t('endpointChat.starting') : t('endpointChat.startChat')}
          </button>
        </div>
        {issueList(startIssues, 'chat-start-issues')}
        {startError && (
          <div data-testid="chat-start-error" className="space-y-1 text-xs text-destructive">
            <p>{errorText(startError.code, 'endpointChat.errors.open_failed')}</p>
            {startError.code === 'conversation_active' && startError.conversationId && (
              <button
                type="button"
                data-testid="chat-open-existing"
                onClick={() => select(startError.conversationId!)}
                className="text-primary underline"
              >
                {t('endpointChat.openExisting')}
              </button>
            )}
          </div>
        )}
        {footer}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{t('endpointChat.recentHeading')}</h3>
        {listFailed && <p className="text-sm text-destructive">{t('endpointChat.loadFailed')}</p>}
        {conversations && conversations.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('endpointChat.empty')}</p>
        )}
        <ul className="divide-y rounded-md border">
          {(conversations ?? []).map((c) => (
            <li key={c.id}>
              <button
                type="button"
                data-testid={`chat-conversation-${c.id}`}
                onClick={() => select(c.id)}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted"
              >
                <span>{new Date(c.createdAt).toLocaleString()}</span>
                <span className="text-xs text-muted-foreground">
                  {/* i18n-dynamic: status is a closed union */}
                  {t(/* i18n-dynamic */ `endpointChat.statusShort.${c.status}`)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
