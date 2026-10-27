import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { usePromptIdentity, type PromptIdentityApi } from './identity';
import { cardForKind } from './kinds/registry';
import type { ActionVia, PromptView, VersionNotice } from './types';

/** The Tauri commands and event the `#prompt/<id>` window uses (all label-checked in Rust). */
export interface PromptCardApi {
  getView(promptId: string): Promise<PromptView>;
  action(promptId: string, actionId: string, via: ActionVia): Promise<void>;
  /** Esc / hide: Rust maps it to the safe action on a pending decision. */
  hide(promptId: string, via: ActionVia): Promise<void>;
  /**
   * `prompt-updated`: a version notice only (W04). Every window's listener
   * hears it, so it carries no view; the card pulls its own (`getView`).
   */
  subscribe(onNotice: (notice: VersionNotice) => void): Promise<() => void>;
}

const tauriApi: PromptCardApi = {
  getView: (promptId) => invoke<PromptView>('get_prompt_view', { promptId }),
  action: (promptId, actionId, via) => invoke<void>('prompt_card_action', { promptId, actionId, via }),
  hide: (promptId, via) => invoke<void>('prompt_card_hide', { promptId, via }),
  subscribe: (onNotice) => listen<VersionNotice>('prompt-updated', (e) => onNotice(e.payload)),
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
 * The `#prompt/<promptId>` card window: subscribes to change notices FIRST,
 * then pulls its view; every newer notice pulls again, and the pull with the
 * higher `version` wins, so a change that lands while a pull is in flight (an
 * action result, say) is never lost or overwritten. The card is drawn by its
 * kind's component (`kinds/registry.ts`). Failures are logged and retried once.
 */
export function PromptCardWindow({
  promptId,
  api = tauriApi,
  clock = Date.now,
  retryDelayMs = 250,
  identityApi,
  identityEnabled,
}: {
  promptId: string;
  api?: PromptCardApi;
  clock?: () => number;
  retryDelayMs?: number;
  /** Tests inject these; in Tauri the defaults read `get_prompt_identity`. */
  identityApi?: PromptIdentityApi;
  identityEnabled?: boolean;
}) {
  const { identity, logoUrl } = usePromptIdentity(identityApi, identityEnabled);
  const [view, setView] = useState<PromptView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const nowMs = useNow(clock);

  useEffect(() => {
    let live = true;
    let unlisten: (() => void) | undefined;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (fn: () => void) => timers.push(setTimeout(fn, retryDelayMs));
    // The highest version applied: a notice at or below it needs no pull.
    let held = -1;
    const apply = (v: PromptView) => {
      if (!live) return;
      held = Math.max(held, v.version);
      setView((cur) => (cur && cur.version > v.version ? cur : v));
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
    // A pull after a change notice, or when live updates are unavailable;
    // never closes the card.
    const repull = () => {
      api
        .getView(promptId)
        .then(apply)
        .catch((err) => console.warn(`[prompt] could not refresh card ${promptId}`, err));
    };
    // A change notice (any prompt's: it carries no id) pulls this card's view.
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
  const KindCard = cardForKind(view.kind);
  return (
    <KindCard
      view={view}
      nowMs={nowMs}
      onAction={onAction}
      onHide={onHide}
      error={error ?? liveError}
      identity={identity}
      logoUrl={logoUrl}
    />
  );
}
