import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import { MessageMarkdown } from '../lib/messageMarkdown';
import { translate } from '../i18n';
import { Card } from '../prompt/Card';

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
  /** Session UI locale from Rust; null/absent falls back to the webview language. */
  locale?: string | null;
}

const ACCENT = /^#[0-9a-f]{6}$/i;

/** The sender slot: from `branding` only, never from the message text. */
export function messageSender(view: MessageView): string {
  return (
    view.branding.companyName.trim() ||
    view.branding.displayName.trim() ||
    translate('message.fallbackSender', view.locale ?? navigator.language)
  );
}

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
  const locale = view.locale ?? navigator.language;
  const t = (key: Parameters<typeof translate>[0], params?: Record<string, string>) =>
    translate(key, locale, params);
  const [ackError, setAckError] = useState<string | null>(null);
  const ack = useCallback(async () => {
    if (acked.current) return;
    acked.current = true;
    setAckError(null);
    try {
      await onAcknowledge();
    } catch (err) {
      acked.current = false;
      setAckError(typeof err === 'string' && err ? err : translate('message.ackFailed', locale));
    }
  }, [onAcknowledge, locale]);

  const sender = messageSender(view);
  const accent = view.branding.accent && ACCENT.test(view.branding.accent) ? view.branding.accent : null;
  const style = accent ? ({ '--message-accent': accent } as React.CSSProperties) : undefined;

  // Drawn by the shared Card (#10190 W04): same structure as a prompt card,
  // the message card's own classes, so it looks exactly as before. The
  // accent rule stays the message card's (any valid #rrggbb; see the PR).
  return (
    <Card
      variant="message"
      className={`helper-message-card is-${view.severity}`}
      style={style}
      role="alertdialog"
      label={view.title}
      header={
        <div className="helper-message-sender" data-testid="message-sender">
          {t('message.from', { sender })}
        </div>
      }
      title={<h1 className="helper-message-title">{view.title}</h1>}
      body={
        <div className="helper-message-body">
          <MessageMarkdown body={view.body} plain={view.plain} />
        </div>
      }
    >
      {ackError && (
        <div className="helper-message-error" role="alert">
          {ackError}
        </div>
      )}
      <div className="helper-message-footer">
        <span className="helper-message-source">{t('message.sentBy')}</span>
        {view.requiresAck ? (
          <button type="button" className="helper-btn helper-btn-accept" onClick={() => void ack()}>
            {t('message.acknowledge')}
          </button>
        ) : (
          <button type="button" className="helper-btn helper-btn-deny" onClick={onClose}>
            {t('message.close')}
          </button>
        )}
      </div>
    </Card>
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
