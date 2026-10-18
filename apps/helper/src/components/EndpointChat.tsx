import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

import { MessageMarkdown } from '../lib/messageMarkdown';

/**
 * Endpoint live chat (#8743): a technician talking to the signed-in user. Its
 * own `chat-<conversationId>` window, separate from the AI chat (ChatView) and
 * from message cards. The helper has no i18n framework (MessageCard hardcodes
 * English too), so the strings here are plain English.
 */

/** What Rust hands the window (`ipc/chat.rs` `ChatView`). */
export interface ChatMessageView {
  messageId: string;
  direction: 'to_user' | 'from_user' | string;
  body: string;
  senderName: string;
  sentAt: string;
  clientNonce: string | null;
  /** User replies only. */
  status: 'pending' | 'sent' | 'failed' | string | null;
  /** A failed reply the user may send again under its original nonce. */
  retryable: boolean;
}

export interface ChatView {
  conversationId: string;
  allowReply: boolean;
  closed: boolean;
  branding: { companyName: string; displayName: string; accent: string | null };
  unread: number;
  messages: ChatMessageView[];
}

/** Rust emits the full `ChatView` to this window's label only. */
export const CHAT_UPDATED_EVENT = 'chat-updated';
export const CHAT_BODY_MAX = 2000;
/** Fallback refresh interval when pushed updates are unavailable. */
const POLL_MS = 3000;

const ACCENT = /^#[0-9a-f]{6}$/i;

function errorText(err: unknown): string {
  return typeof err === 'string' && err ? err : "Couldn't send your message. Please try again.";
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function ReplyStatus({ m, onRetry }: { m: ChatMessageView; onRetry: (nonce: string) => void }) {
  const nonce = m.clientNonce ?? m.messageId;
  if (m.status === 'pending') {
    return (
      <span className="helper-chat-status" data-testid={`chat-status-${nonce}`}>
        Sending…
      </span>
    );
  }
  if (m.status === 'failed') {
    return (
      <span className="helper-chat-status is-failed" data-testid={`chat-status-${nonce}`}>
        {m.retryable ? 'Not sent' : 'Not delivered'}
        {m.retryable && m.clientNonce && (
          <>
            {' '}
            <button type="button" className="helper-chat-retry" onClick={() => onRetry(m.clientNonce as string)}>
              Retry
            </button>
          </>
        )}
      </span>
    );
  }
  if (m.status === 'sent') {
    return (
      <span className="helper-chat-status" data-testid={`chat-status-${nonce}`}>
        Sent
      </span>
    );
  }
  return null;
}

/**
 * The chat. The sender slot is built from `branding` only; each technician
 * message shows its own `senderName` and renders through the restricted
 * markdown renderer, so message text can never impersonate the header. The
 * user's own replies are plain text.
 */
export function EndpointChat({
  view,
  onSend,
  onRetry,
  notice,
}: {
  view: ChatView;
  /** Non-blocking status line (live updates down, refresh failed). */
  notice?: string | null;
  /** May reject (e.g. no live agent session): the draft is kept and the reason shown. */
  onSend: (body: string) => Promise<void>;
  onRetry: (clientNonce: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  // One send at a time (key repeat on Enter must not double-post).
  const sending = useRef(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  const company = view.branding.companyName.trim() || view.branding.displayName.trim() || 'your IT provider';
  const accent = view.branding.accent && ACCENT.test(view.branding.accent) ? view.branding.accent : null;
  const style = accent ? ({ '--message-accent': accent } as React.CSSProperties) : undefined;
  const canReply = !view.closed && view.allowReply;

  useLayoutEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [view.messages.length]);

  const send = useCallback(async () => {
    const body = draft.trim();
    if (!body || !canReply || sending.current) return;
    sending.current = true;
    setError(null);
    try {
      await onSend(body);
      setDraft('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      sending.current = false;
    }
  }, [draft, canReply, onSend]);

  const retry = useCallback(
    async (nonce: string) => {
      setError(null);
      try {
        await onRetry(nonce);
      } catch (err) {
        setError(errorText(err));
      }
    },
    [onRetry],
  );

  return (
    <div className="helper-chat" style={style}>
      <div className="helper-chat-header" data-testid="chat-sender">
        Chat with {company}
      </div>
      <div className="helper-chat-log" role="log" aria-live="polite">
        {view.messages.map((m) =>
          m.direction === 'from_user' ? (
            <div key={m.messageId} className="helper-chat-msg is-mine">
              <p className="helper-message-plain helper-chat-text">{m.body}</p>
              <div className="helper-chat-meta">
                <ReplyStatus m={m} onRetry={(n) => void retry(n)} />
              </div>
            </div>
          ) : (
            <div key={m.messageId} className="helper-chat-msg is-theirs">
              <div className="helper-chat-meta">
                <span className="helper-chat-name">{m.senderName}</span> <span>{timeLabel(m.sentAt)}</span>
              </div>
              <div className="helper-chat-text">
                <MessageMarkdown body={m.body} />
              </div>
            </div>
          ),
        )}
        <div ref={endRef} />
      </div>
      {notice && (
        <div className="helper-chat-note" role="status">
          {notice}
        </div>
      )}
      {error && (
        <div className="helper-message-error helper-chat-error" role="alert">
          {error}
        </div>
      )}
      {view.closed ? (
        <div className="helper-chat-note" role="status">
          This chat has ended.
        </div>
      ) : (
        !view.allowReply && (
          <div className="helper-chat-note" role="status">
            Replies are turned off for this chat.
          </div>
        )
      )}
      <div className="helper-chat-composer">
        <textarea
          className="helper-chat-input"
          aria-label="Your reply"
          rows={2}
          maxLength={CHAT_BODY_MAX}
          disabled={!canReply}
          value={draft}
          placeholder={canReply ? 'Type a reply' : ''}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter is a newline; Enter that confirms an
            // IME composition is not a send.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          type="button"
          className="helper-btn helper-btn-accept"
          disabled={!canReply || draft.trim() === ''}
          onClick={() => void send()}
        >
          Send
        </button>
      </div>
    </div>
  );
}

export interface EndpointChatApi {
  getView(conversationId: string): Promise<ChatView>;
  sendReply(conversationId: string, body: string, clientNonce?: string): Promise<{ clientNonce: string }>;
  markRead(conversationId: string): Promise<void>;
  /** Subscribe to pushed views; resolves to the unsubscribe function. */
  subscribe(handler: (view: ChatView) => void): Promise<() => void>;
}

const tauriApi: EndpointChatApi = {
  getView: (conversationId) => invoke<ChatView>('get_chat_view', { conversationId }),
  sendReply: (conversationId, body, clientNonce) =>
    invoke<{ clientNonce: string }>('chat_send_reply', { conversationId, body, clientNonce }),
  markRead: (conversationId) => invoke<void>('chat_mark_read', { conversationId }),
  subscribe: (handler) => listen<ChatView>(CHAT_UPDATED_EVENT, (e) => handler(e.payload)),
};

/** The `#chat/<id>` window: pulls its view from Rust, follows pushed updates, sends replies. */
export function EndpointChatWindow({
  conversationId,
  api = tauriApi,
}: {
  conversationId: string;
  api?: EndpointChatApi;
}) {
  const [view, setView] = useState<ChatView | null>(null);
  const [gone, setGone] = useState(false);
  // Pushed updates are unavailable (listen denied/failed): poll instead.
  const [liveFailed, setLiveFailed] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const viewRef = useRef<ChatView | null>(null);
  viewRef.current = view;
  const markedFor = useRef(0);

  useEffect(() => {
    let live = true;
    let unsubscribe: (() => void) | undefined;
    // Subscribe before the first pull so no update lands in between.
    api
      .subscribe((v) => {
        if (live && v.conversationId === conversationId) setView(v);
      })
      .then((fn) => {
        if (live) unsubscribe = fn;
        else fn();
      })
      .catch(() => {
        if (live) setLiveFailed(true);
      });
    api
      .getView(conversationId)
      .then((v) => {
        if (live) setView((prev) => prev ?? v);
      })
      .catch(() => {
        if (live) setGone(true);
      });
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, [api, conversationId]);

  // Clear the tray badge once the user can actually see the conversation.
  const maybeMarkRead = useCallback(() => {
    const v = viewRef.current;
    if (!v || v.unread === 0 || markedFor.current === v.unread) return;
    if (!document.hasFocus() || document.visibilityState === 'hidden') return;
    markedFor.current = v.unread;
    api.markRead(conversationId).catch(() => {
      markedFor.current = 0;
    });
  }, [api, conversationId]);

  useEffect(() => {
    maybeMarkRead();
  }, [view?.unread, view?.messages.length, maybeMarkRead]);

  useEffect(() => {
    window.addEventListener('focus', maybeMarkRead);
    document.addEventListener('visibilitychange', maybeMarkRead);
    return () => {
      window.removeEventListener('focus', maybeMarkRead);
      document.removeEventListener('visibilitychange', maybeMarkRead);
    };
  }, [maybeMarkRead]);

  const refresh = useCallback(() => {
    api
      .getView(conversationId)
      .then((v) => {
        setView(v);
        setRefreshFailed(false);
      })
      .catch(() => setRefreshFailed(true));
  }, [api, conversationId]);

  // Without pushed updates the window would never learn of new messages,
  // results or a close: poll while it is open.
  useEffect(() => {
    if (!liveFailed) return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [liveFailed, refresh]);

  const onSend = useCallback(
    async (body: string) => {
      await api.sendReply(conversationId, body, undefined);
      refresh();
    },
    [api, conversationId, refresh],
  );

  const onRetry = useCallback(
    async (nonce: string) => {
      const m = viewRef.current?.messages.find((x) => x.clientNonce === nonce);
      if (!m) return;
      await api.sendReply(conversationId, m.body, nonce);
      refresh();
    },
    [api, conversationId, refresh],
  );

  if (gone && !view) {
    return (
      <div className="helper-chat">
        <div className="helper-chat-note" role="status">
          This chat is no longer available.
        </div>
      </div>
    );
  }
  if (!view) return null;
  const notice = liveFailed
    ? 'Live updates unavailable. Checking for new messages…'
    : refreshFailed
      ? "Couldn't refresh the chat. Some messages may be out of date."
      : null;
  return <EndpointChat view={view} onSend={onSend} onRetry={onRetry} notice={notice} />;
}
