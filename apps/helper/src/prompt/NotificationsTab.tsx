import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { orderActions, outcomeMessage } from './PromptCard';
import { applyPlaceholders } from './placeholders';
import type { PromptState, PromptView } from './types';
import './prompt.css';

/*
 * The Notifications tab (#10190, spec section 3.2): the in-memory list of this
 * session's prompts that Rust keeps (persistent entries until they expire,
 * plus open prompts without a card). Assist stores nothing; the agent replays
 * the list after every reconnect. English chrome for W02 (catalog in W03).
 */

/** The main-window commands and event behind the tab. */
export interface PromptListApi {
  getList(): Promise<PromptView[]>;
  action(promptId: string, actionId: string): Promise<void>;
  subscribe(onList: (list: PromptView[]) => void): Promise<() => void>;
}

const tauriListApi: PromptListApi = {
  getList: () => invoke<PromptView[]>('get_prompt_list'),
  action: (promptId, actionId) => invoke<void>('prompt_list_action', { promptId, actionId }),
  subscribe: (onList) => listen<PromptView[]>('prompt-list-updated', (e) => onList(e.payload)),
};

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * The list, kept current from Rust. Outside Tauri (browser dev mode, tests of
 * other components) it stays empty and calls nothing.
 */
export function usePromptList(api: PromptListApi = tauriListApi, enabled: boolean = inTauri()) {
  const [entries, setEntries] = useState<PromptView[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let unlisten: (() => void) | undefined;
    api
      .subscribe((list) => {
        if (live) setEntries(list);
      })
      .then((fn) => {
        if (live) unlisten = fn;
        else fn();
      })
      .catch(() => {});
    api
      .getList()
      .then((list) => {
        if (live) setEntries(list);
      })
      .catch(() => {});
    return () => {
      live = false;
      unlisten?.();
    };
  }, [api, enabled]);

  const act = useCallback(
    async (promptId: string, actionId: string) => {
      setError(null);
      try {
        await api.action(promptId, actionId);
      } catch (err) {
        setError(typeof err === 'string' && err ? err : "Couldn't send your choice. Please try again.");
      }
    },
    [api],
  );

  return { entries, act, error };
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

export function NotificationsTab({
  entries,
  onAction,
  error,
  clock = Date.now,
}: {
  entries: PromptView[];
  onAction: (promptId: string, actionId: string) => void | Promise<void>;
  error?: string | null;
  clock?: () => number;
}) {
  const [nowMs, setNowMs] = useState(clock);
  useEffect(() => {
    const t = setInterval(() => setNowMs(clock()), 1000);
    return () => clearInterval(t);
  }, [clock]);

  return (
    <div className="helper-history prompt-list" data-testid="notifications-tab">
      <div className="helper-history-header">
        <span className="helper-history-title">Notifications</span>
        <div className="helper-header-drag-spacer" />
      </div>
      {error && (
        <div className="helper-error-banner" role="alert">
          <span>{error}</span>
        </div>
      )}
      {entries.length === 0 ? (
        <div className="helper-history-empty">No notifications</div>
      ) : (
        <ul className="prompt-list-items">
          {entries.map((v) => {
            const fill = (text: string) => applyPlaceholders(text, nowMs, v.locale, v.countdownDeadlineUnixMs);
            const pending = v.pendingActionId !== null;
            const notice = outcomeMessage(v.lastOutcome);
            const detail = v.copy.stateDetail ?? v.copy.consequence;
            return (
              <li key={v.promptId} className={`prompt-list-item is-${v.state}`} dir={v.direction} lang={v.locale}>
                <div className="prompt-list-state">{STATE_LABEL[v.state]}</div>
                <div className="prompt-list-title">{fill(v.copy.title)}</div>
                {v.copy.body && <div className="prompt-list-body">{fill(v.copy.body)}</div>}
                {detail && <div className="prompt-list-body">{fill(detail)}</div>}
                {notice && <div className="prompt-notice">{notice}</div>}
                {pending && <div className="prompt-working">Working…</div>}
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
        </ul>
      )}
    </div>
  );
}
