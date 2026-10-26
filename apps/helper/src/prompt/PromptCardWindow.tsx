import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { PromptCard } from './PromptCard';
import type { ActionVia, PromptView } from './types';

/** The Tauri commands and event the `#prompt/<id>` window uses (all label-checked in Rust). */
export interface PromptCardApi {
  getView(promptId: string): Promise<PromptView>;
  action(promptId: string, actionId: string, via: ActionVia): Promise<void>;
  /** Esc / hide: Rust maps it to the safe action on a pending decision. */
  hide(promptId: string, via: ActionVia): Promise<void>;
  subscribe(promptId: string, onView: (view: PromptView) => void): Promise<() => void>;
}

const tauriApi: PromptCardApi = {
  getView: (promptId) => invoke<PromptView>('get_prompt_view', { promptId }),
  action: (promptId, actionId, via) => invoke<void>('prompt_card_action', { promptId, actionId, via }),
  hide: (promptId, via) => invoke<void>('prompt_card_hide', { promptId, via }),
  subscribe: (promptId, onView) =>
    listen<PromptView>('prompt-updated', (e) => {
      if (e.payload.promptId === promptId) onView(e.payload);
    }),
};

const STALE_NOTICE = 'Live updates are unavailable; this card may be out of date.';

function errorText(err: unknown): string {
  return typeof err === 'string' && err ? err : "Couldn't send your choice. Please try again.";
}

/** A 1 s wall clock for `{remaining}` (display only: expiry is the agent's). */
function useNow(clock: () => number): number {
  const [now, setNow] = useState(clock);
  useEffect(() => {
    const t = setInterval(() => setNow(clock()), 1000);
    return () => clearInterval(t);
  }, [clock]);
  return now;
}

/**
 * The `#prompt/<promptId>` card window: subscribes to its updates FIRST, then
 * pulls its view, and keeps whichever has the higher `version`, so an update
 * that lands while the fetch is in flight (an action result, say) is never
 * lost or overwritten. Failures are logged and retried once.
 */
export function PromptCardWindow({
  promptId,
  api = tauriApi,
  clock = Date.now,
  retryDelayMs = 250,
}: {
  promptId: string;
  api?: PromptCardApi;
  clock?: () => number;
  retryDelayMs?: number;
}) {
  const [view, setView] = useState<PromptView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const nowMs = useNow(clock);

  useEffect(() => {
    let live = true;
    let unlisten: (() => void) | undefined;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (fn: () => void) => timers.push(setTimeout(fn, retryDelayMs));
    const apply = (v: PromptView) => {
      if (live) setView((cur) => (cur && cur.version > v.version ? cur : v));
    };
    // Initial pull: retried once; a prompt still unavailable after that is
    // gone (closed before it painted), so take the empty frame down rather
    // than leave a blank always-on-top window.
    const fetchView = (attempt: number) => {
      api
        .getView(promptId)
        .then(apply)
        .catch((err) => {
          if (!live) return;
          console.warn(`[prompt] could not load card ${promptId} (attempt ${attempt + 1})`, err);
          if (attempt === 0) later(() => fetchView(1));
          else void api.hide(promptId, 'click').catch(() => {});
        });
    };
    // An extra pull when live updates are unavailable; never closes the card.
    const repull = () => {
      api
        .getView(promptId)
        .then(apply)
        .catch((err) => console.warn(`[prompt] could not refresh card ${promptId}`, err));
    };
    api
      .subscribe(promptId, apply)
      .then((fn) => {
        if (!live) {
          fn();
          return;
        }
        unlisten = fn;
        fetchView(0);
      })
      .catch((err) => {
        if (!live) return;
        console.warn(`[prompt] could not subscribe to card ${promptId} updates`, err);
        setLiveError(STALE_NOTICE);
        fetchView(0);
        later(repull);
      });
    return () => {
      live = false;
      timers.forEach(clearTimeout);
      unlisten?.();
    };
  }, [api, promptId, retryDelayMs]);

  const onAction = useCallback(
    (actionId: string, via: ActionVia) => {
      setError(null);
      api.action(promptId, actionId, via).catch((err) => setError(errorText(err)));
    },
    [api, promptId],
  );
  // PromptCard calls onHide only for Esc.
  const onHide = useCallback(() => {
    api.hide(promptId, 'keyboard').catch((err) => setError(errorText(err)));
  }, [api, promptId]);

  if (!view) return null;
  return <PromptCard view={view} nowMs={nowMs} onAction={onAction} onHide={onHide} error={error ?? liveError} />;
}
