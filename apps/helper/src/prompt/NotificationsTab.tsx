import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { messageSender, type MessageView } from '../components/MessageCard';
import { chromeString } from './chrome';
import { orderActions, outcomeMessage } from './PromptCard';
import { applyPlaceholders } from './placeholders';
import type { NotificationListView, PromptState, PromptView, VersionNotice } from './types';
import './prompt.css';

/*
 * The Notifications tab (#10190, spec section 3.2): the one in-memory list of
 * this session that Rust keeps: prompt entries (persistent entries until they
 * expire, plus open prompts without a card) and, since W04, the endpoint
 * message cards on screen. Assist stores nothing; the agent replays both
 * after every reconnect, and a session end empties the list. Chrome strings
 * come from the shared catalog: the heading in the last branding sync's
 * locale, each prompt entry in its own.
 *
 * The list is pulled through `get_notification_list` (main window only);
 * `prompt-list-updated` carries only a version (W04 event exposure fix).
 */

/** The main-window commands and event behind the tab. */
export interface NotificationListApi {
  getList(): Promise<NotificationListView>;
  action(promptId: string, actionId: string): Promise<void>;
  /** `prompt-list-updated`: a version notice only; the tab then pulls. */
  subscribe(onNotice: (notice: VersionNotice) => void): Promise<() => void>;
}

const tauriListApi: NotificationListApi = {
  getList: () => invoke<NotificationListView>('get_notification_list'),
  action: (promptId, actionId) => invoke<void>('prompt_list_action', { promptId, actionId }),
  subscribe: (onNotice) => listen<VersionNotice>('prompt-list-updated', (e) => onNotice(e.payload)),
};

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const LOAD_FAILED = 'Notifications could not be loaded. Reopen this tab to try again.';
const STALE_NOTICE = 'Live updates are unavailable; this list may be out of date.';

/**
 * The list, kept current from Rust: subscribes FIRST, then pulls; every newer
 * notice pulls again, and the pull with the higher `version` wins, so nothing
 * that changes during a pull is lost or overwritten. Each pull REPLACES the
 * list (nothing is merged), so entries of an ended session never linger.
 * Failures are logged, retried once and reported. Outside Tauri (browser dev
 * mode, tests of other components) it stays empty and calls nothing.
 */
export function useNotificationList(
  api: NotificationListApi = tauriListApi,
  enabled: boolean = inTauri(),
  retryDelayMs: number = 250,
) {
  const [list, setList] = useState<NotificationListView | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let unlisten: (() => void) | undefined;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (fn: () => void) => timers.push(setTimeout(fn, retryDelayMs));
    // The highest version applied: a notice at or below it needs no pull.
    let held = -1;
    const apply = (next: NotificationListView) => {
      if (!live) return;
      held = Math.max(held, next.version);
      setLoadError(null);
      setList((cur) => (cur && cur.version > next.version ? cur : next));
    };
    const fetchList = (attempt: number) => {
      api
        .getList()
        .then(apply)
        .catch((err) => {
          if (!live) return;
          console.warn(`[prompt] could not load the notification list (attempt ${attempt + 1})`, err);
          if (attempt === 0) later(() => fetchList(1));
          else setLoadError(LOAD_FAILED);
        });
    };
    const repull = () => {
      api
        .getList()
        .then(apply)
        .catch((e) => console.warn('[prompt] could not refresh the notification list', e));
    };
    const onNotice = (n: VersionNotice) => {
      if (live && n.version > held) repull();
    };
    api
      .subscribe(onNotice)
      .then((fn) => {
        if (!live) {
          fn();
          return;
        }
        unlisten = fn;
        fetchList(0);
      })
      .catch((err) => {
        if (!live) return;
        console.warn('[prompt] could not subscribe to notification list updates', err);
        setLiveError(STALE_NOTICE);
        fetchList(0);
        later(repull);
      });
    return () => {
      live = false;
      timers.forEach(clearTimeout);
      unlisten?.();
    };
  }, [api, enabled, retryDelayMs]);

  const act = useCallback(
    async (promptId: string, actionId: string) => {
      setActionError(null);
      try {
        await api.action(promptId, actionId);
      } catch (err) {
        setActionError(typeof err === 'string' && err ? err : "Couldn't send your choice. Please try again.");
      }
    },
    [api],
  );

  const entries = useMemo(() => list?.prompts ?? [], [list]);
  const messages = useMemo(() => list?.messages ?? [], [list]);
  return { entries, messages, act, error: actionError ?? loadError ?? liveError };
}

const STATE_LABEL: Record<PromptState, string> = {
  pending: 'Needs your answer',
  waiting: 'Waiting',
  approved: 'Approved',
  denied: 'Declined',
  expired: 'Expired',
  cancelled: 'Cancelled',
  failed: 'Could not be completed',
};

/**
 * One endpoint message in the list. Technician-authored text, so in the main
 * window it is plain text only (no markdown, no links, no images) and has no
 * action: the card itself, still on screen, is where it is acknowledged or
 * closed. The sender comes from `branding` only, as on the card.
 */
function MessageEntry({ view }: { view: MessageView }) {
  return (
    <li className={`prompt-list-item prompt-list-message is-${view.severity}`} data-kind="message">
      <div className="prompt-list-state">From {messageSender(view)}</div>
      <div className="prompt-list-title">{view.title}</div>
      {view.body && <div className="prompt-list-body">{view.body}</div>}
    </li>
  );
}

export function NotificationsTab({
  entries,
  messages = [],
  onAction,
  error,
  clock = Date.now,
  locale = null,
}: {
  entries: PromptView[];
  /** The endpoint message cards on screen in this session (W04). */
  messages?: MessageView[];
  onAction: (promptId: string, actionId: string) => void | Promise<void>;
  error?: string | null;
  clock?: () => number;
  /** The negotiated locale of the last `prompt_branding_sync` (heading, empty list). */
  locale?: string | null;
}) {
  const [nowMs, setNowMs] = useState(clock);
  useEffect(() => {
    const t = setInterval(() => setNowMs(clock()), 1000);
    return () => clearInterval(t);
  }, [clock]);

  return (
    <div className="helper-history prompt-list" data-testid="notifications-tab">
      <div className="helper-history-header">
        <span className="helper-history-title">{chromeString('chrome.notifications', locale)}</span>
        <div className="helper-header-drag-spacer" />
      </div>
      {error && (
        <div className="helper-error-banner" role="alert">
          <span>{error}</span>
        </div>
      )}
      {entries.length === 0 && messages.length === 0 ? (
        <div className="helper-history-empty">{chromeString('chrome.emptyList', locale)}</div>
      ) : (
        <ul className="prompt-list-items">
          {entries.map((v) => {
            const fill = (text: string) => applyPlaceholders(text, nowMs, v.locale, v.countdownDeadlineUnixMs);
            const pending = v.pendingActionId !== null;
            const notice = v.lastError ?? outcomeMessage(v.lastOutcome);
            const detail = v.copy.stateDetail ?? v.copy.consequence;
            return (
              <li
                key={v.promptId}
                className={`prompt-list-item is-${v.state}`}
                data-kind={v.kind}
                dir={v.direction}
                lang={v.locale}
              >
                <div className="prompt-list-state">{STATE_LABEL[v.state]}</div>
                <div className="prompt-list-title">{fill(v.copy.title)}</div>
                {v.copy.body && <div className="prompt-list-body">{fill(v.copy.body)}</div>}
                {detail && <div className="prompt-list-body">{fill(detail)}</div>}
                {notice && <div className="prompt-notice">{notice}</div>}
                {pending && <div className="prompt-working">{chromeString('chrome.working', v.locale)}</div>}
                {!v.closed && v.actions.length > 0 && (
                  <div className="prompt-actions">
                    {orderActions(v.actions).map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        className={`helper-btn helper-btn-sm prompt-action is-${a.role}`}
                        disabled={pending}
                        onClick={() => void onAction(v.promptId, a.id)}
                      >
                        {fill(a.label)}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
          {messages.map((m) => (
            <MessageEntry key={`message:${m.messageId}`} view={m} />
          ))}
        </ul>
      )}
    </div>
  );
}
