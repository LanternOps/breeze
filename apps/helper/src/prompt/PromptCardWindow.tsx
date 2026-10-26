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
  hide(promptId: string): Promise<void>;
  subscribe(promptId: string, onView: (view: PromptView) => void): Promise<() => void>;
}

const tauriApi: PromptCardApi = {
  getView: (promptId) => invoke<PromptView>('get_prompt_view', { promptId }),
  action: (promptId, actionId, via) => invoke<void>('prompt_card_action', { promptId, actionId, via }),
  hide: (promptId) => invoke<void>('prompt_card_hide', { promptId }),
  subscribe: (promptId, onView) =>
    listen<PromptView>('prompt-updated', (e) => {
      if (e.payload.promptId === promptId) onView(e.payload);
    }),
};

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

/** The `#prompt/<promptId>` card window: pulls its view, follows updates, reports actions. */
export function PromptCardWindow({
  promptId,
  api = tauriApi,
  clock = Date.now,
}: {
  promptId: string;
  api?: PromptCardApi;
  clock?: () => number;
}) {
  const [view, setView] = useState<PromptView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nowMs = useNow(clock);

  useEffect(() => {
    let live = true;
    let unlisten: (() => void) | undefined;
    api
      .subscribe(promptId, (v) => {
        if (live) setView(v);
      })
      .then((fn) => {
        if (live) unlisten = fn;
        else fn();
      })
      .catch(() => {});
    api
      .getView(promptId)
      .then((v) => {
        if (live) setView(v);
      })
      .catch(() => {
        // Closed or refused before it painted: take the empty frame down
        // rather than leave a blank always-on-top window.
        if (live) void api.hide(promptId).catch(() => {});
      });
    return () => {
      live = false;
      unlisten?.();
    };
  }, [api, promptId]);

  const onAction = useCallback(
    (actionId: string, via: ActionVia) => {
      setError(null);
      api.action(promptId, actionId, via).catch((err) => setError(errorText(err)));
    },
    [api, promptId],
  );
  const onHide = useCallback(() => {
    api.hide(promptId).catch((err) => setError(errorText(err)));
  }, [api, promptId]);

  if (!view) return null;
  return <PromptCard view={view} nowMs={nowMs} onAction={onAction} onHide={onHide} error={error} />;
}
