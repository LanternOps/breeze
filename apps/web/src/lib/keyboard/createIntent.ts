import { useEffect, useRef } from 'react';
import type { CreateIntentKind } from './goToShortcuts';

/**
 * One-shot "open the create dialog" handoff for the `c then <key>` chords
 * whose create form is a dialog on a list page (quotes, invoices) rather than
 * a `/new` route. Those pages already use the hash for filters and tabs, so
 * the intent travels in sessionStorage across the navigation and is consumed
 * on mount; when the chord fires on the page that is already showing, a
 * window event opens the dialog in place. An intent older than
 * `CREATE_INTENT_TTL_MS` is ignored, so one left behind (navigation failed,
 * no permission) can never pop a dialog later.
 */
export const CREATE_INTENT_STORAGE_KEY = 'breeze.createIntent';
export const CREATE_INTENT_TTL_MS = 10_000;
const CREATE_INTENT_EVENT = 'breeze:create-intent';

export function requestCreate(kind: CreateIntentKind): void {
  try {
    sessionStorage.setItem(CREATE_INTENT_STORAGE_KEY, JSON.stringify({ kind, at: Date.now() }));
  } catch {
    /* Storage unavailable — the chord still navigates to the list. */
  }
  window.dispatchEvent(new CustomEvent<CreateIntentKind>(CREATE_INTENT_EVENT, { detail: kind }));
}

function takeIntent(kind: CreateIntentKind): boolean {
  try {
    const raw = sessionStorage.getItem(CREATE_INTENT_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { kind?: unknown; at?: unknown } | null;
    const fresh = typeof parsed?.at === 'number' && Date.now() - parsed.at <= CREATE_INTENT_TTL_MS;
    if (fresh && parsed?.kind !== kind) return false;
    // Ours, or stale (whoever's it was): either way it is spent.
    sessionStorage.removeItem(CREATE_INTENT_STORAGE_KEY);
    return fresh;
  } catch {
    return false;
  }
}

/**
 * Call on the list page that owns `kind`'s create dialog. `enabled` mirrors
 * the page's own create-button gate; while it is false (permissions still
 * loading, or none) the intent is left in place until it expires.
 */
export function useCreateIntent(kind: CreateIntentKind, open: () => void, enabled = true): void {
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    if (!enabled) return;
    if (takeIntent(kind)) openRef.current();
    // Same page: the event itself carries the kind, so storage is only
    // cleared here (best effort), never needed to open.
    const onIntent = (event: Event) => {
      if ((event as CustomEvent<CreateIntentKind>).detail !== kind) return;
      takeIntent(kind);
      openRef.current();
    };
    window.addEventListener(CREATE_INTENT_EVENT, onIntent);
    return () => window.removeEventListener(CREATE_INTENT_EVENT, onIntent);
  }, [kind, enabled]);
}
