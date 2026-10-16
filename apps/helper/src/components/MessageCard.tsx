import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import { MessageMarkdown } from '../lib/messageMarkdown';

/** What the Rust side hands the card window (`ipc/message.rs` `MessageView`). */
export interface MessageView {
  messageId: string;
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'critical' | string;
  requiresAck: boolean;
  expiresAt: string;
  branding: { companyName: string; displayName: string; accent: string | null };
  /** Oversize/invalid content: render as plain text. */
  plain: boolean;
}

const ACCENT = /^#[0-9a-f]{6}$/i;

/**
 * The card. The sender slot is built from `branding` only and the footer is a
 * fixed string, so message text can never impersonate either (#8293).
 */
export function MessageCard({
  view,
  onAcknowledge,
  onClose,
}: {
  view: MessageView;
  /** May reject (e.g. no live agent session): the card then shows the error and allows a retry. */
  onAcknowledge: () => void | Promise<void>;
  onClose: () => void;
}) {
  // In-flight guard: the agent must see at most one ack. Released on failure
  // so the user can retry.
  const acked = useRef(false);
  const [ackError, setAckError] = useState<string | null>(null);
  const ack = useCallback(async () => {
    if (acked.current) return;
    acked.current = true;
    setAckError(null);
    try {
      await onAcknowledge();
    } catch (err) {
      acked.current = false;
      setAckError(typeof err === 'string' && err ? err : "Couldn't send your acknowledgement. Please try again.");
    }
  }, [onAcknowledge]);

  const sender = view.branding.companyName.trim() || view.branding.displayName.trim() || 'your IT provider';
  const accent = view.branding.accent && ACCENT.test(view.branding.accent) ? view.branding.accent : null;
  const style = accent ? ({ '--message-accent': accent } as React.CSSProperties) : undefined;

  return (
    <div className={`helper-message-card is-${view.severity}`} style={style} role="alertdialog" aria-label={view.title}>
      <div className="helper-message-sender" data-testid="message-sender">
        From {sender}
      </div>
      <h1 className="helper-message-title">{view.title}</h1>
      <div className="helper-message-body">
        <MessageMarkdown body={view.body} plain={view.plain} />
      </div>
      {ackError && (
        <div className="helper-message-error" role="alert">
          {ackError}
        </div>
      )}
      <div className="helper-message-footer">
        <span className="helper-message-source">Sent by your IT provider</span>
        {view.requiresAck ? (
          <button type="button" className="helper-btn helper-btn-accept" onClick={() => void ack()}>
            Acknowledge
          </button>
        ) : (
          <button type="button" className="helper-btn helper-btn-deny" onClick={onClose}>
            Close
          </button>
        )}
      </div>
    </div>
  );
}

export interface MessageCardApi {
  getView(messageId: string): Promise<MessageView>;
  acknowledge(messageId: string): Promise<void>;
  close(messageId: string): Promise<void>;
}

const tauriApi: MessageCardApi = {
  getView: (messageId) => invoke<MessageView>('get_message_view', { messageId }),
  acknowledge: (messageId) => invoke<void>('message_ack', { messageId }),
  close: (messageId) => invoke<void>('message_close', { messageId }),
};

/** The `#message/<id>` window: pulls its view from Rust, reports ack/close. */
export function MessageCardWindow({
  messageId,
  api = tauriApi,
}: {
  messageId: string;
  api?: MessageCardApi;
}) {
  const [view, setView] = useState<MessageView | null>(null);

  useEffect(() => {
    let live = true;
    api
      .getView(messageId)
      .then((v) => {
        if (live) setView(v);
      })
      .catch(() => {
        // Retracted/expired before it painted: close the (empty) frame rather
        // than leave an always-on-top blank window.
        if (live) void api.close(messageId).catch(() => {});
      });
    return () => {
      live = false;
    };
  }, [api, messageId]);

  if (!view) return null;
  return (
    <MessageCard
      view={view}
      onAcknowledge={() => api.acknowledge(messageId)}
      onClose={() => void api.close(messageId).catch(() => {})}
    />
  );
}
