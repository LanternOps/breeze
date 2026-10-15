import { useCallback, useMemo, useRef, useState } from 'react';

import { getChatModelChoices } from '../../services/aiChat';
import { clearAiModelPref, loadAiModelPref, saveAiModelPref } from '../../services/aiModelPrefs';
import {
  commitSelection,
  pendingChoice,
  resolvePersistedPref,
  selectOffering,
  stateAfterFailedLoad,
  survivingSelection,
  withOption,
  type AiContinuationRequired,
  type ChoicesLoadFailure,
  type ModelChoice,
  type OfferingOptions,
  type PickerState,
} from './modelPicker';

const INITIAL: PickerState = { choices: null, loading: false, selection: null };

/** A continuation parked for the chat it came from, with the message it refused. */
export interface ParkedContinuation {
  required: AiContinuationRequired;
  pendingContent: string;
  sourceSessionId: string;
  /** Set once `/continue` created the new chat: a retry opens it, never re-POSTs. */
  createdSessionId?: string;
}

/**
 * The chat composer's model menu for one HomeScreen (W05). The state machine
 * is `modelPicker.ts` (pure, tested); this hook only owns the load keying,
 * the on-device preference and React state. Every getter reads a ref so the
 * screen's send path sees the live value, never a stale render's.
 */
export function useChatModelPicker() {
  const [state, setState] = useState<PickerState>(INITIAL);
  const stateRef = useRef(state);
  /** The load key on screen: `s:<sessionId>` or `none` (a new chat). */
  const keyRef = useRef('none');
  /** The load key the menu on screen (`state.choices`) belongs to. */
  const choicesKeyRef = useRef<string | null>(null);
  /** Why the last finished load produced no menu, or null when it did. */
  const lastFailureRef = useRef<ChoicesLoadFailure | null>(null);
  /** The key the current selection was made under; a pick never crosses chats. */
  const selectionKeyRef = useRef<string | null>(null);
  const tokenRef = useRef(0);
  const [suggested, setSuggested] = useState<string[]>([]);
  const [continuation, setContinuationState] = useState<ParkedContinuation | null>(null);
  const continuationRef = useRef(continuation);

  const update = useCallback((next: PickerState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const setContinuation = useCallback((next: ParkedContinuation | null) => {
    continuationRef.current = next;
    setContinuationState(next);
  }, []);

  /**
   * Load the menu for a chat (`sessionId`) or a new chat (none). A new chat
   * starts from the stored preference while its offering is still offered;
   * `applyPref` does the same for a session created a moment ago without a
   * menu (a partner-scope token has no org menu before the session exists).
   */
  const load = useCallback(async (key: { sessionId?: string | null; applyPref?: boolean }) => {
    const token = ++tokenRef.current;
    const loadKey = key.sessionId ? `s:${key.sessionId}` : 'none';
    keyRef.current = loadKey;
    update({ ...stateRef.current, loading: true });
    const wantPref = !key.sessionId || key.applyPref === true;
    const [result, pref] = await Promise.all([
      getChatModelChoices({ sessionId: key.sessionId }),
      wantPref ? loadAiModelPref() : Promise.resolve(null),
    ]);
    if (token !== tokenRef.current) return;
    if (!result.ok) {
      // No org context / 404: no menu, the composer works on the server
      // default. Offline, 5xx or registry_unavailable is transient: keep the
      // menu and the pick rather than wipe them on a blip.
      lastFailureRef.current = { status: result.status, code: result.code };
      const next = stateAfterFailedLoad(stateRef.current, result, choicesKeyRef.current === loadKey);
      if (!next.choices) choicesKeyRef.current = null;
      if (!next.selection) selectionKeyRef.current = null;
      update(next);
      return;
    }
    lastFailureRef.current = null;
    choicesKeyRef.current = loadKey;
    let selection = selectionKeyRef.current === loadKey
      ? survivingSelection(result.choices, stateRef.current.selection)
      : null;
    if (!selection && wantPref) selection = resolvePersistedPref(result.choices, pref);
    selectionKeyRef.current = selection ? loadKey : null;
    update({ choices: result.choices, loading: false, selection });
  }, [update]);

  const choose = useCallback((selection: ModelChoice | null) => {
    if (!selection) return;
    selectionKeyRef.current = keyRef.current;
    update({ ...stateRef.current, selection });
    void saveAiModelPref(selection);
  }, [update]);

  const select = useCallback((offeringId: string) => {
    choose(selectOffering(stateRef.current, offeringId));
  }, [choose]);

  const setOption = useCallback(<K extends keyof OfferingOptions>(k: K, v: OfferingOptions[K] | undefined) => {
    choose(withOption(stateRef.current, k, v));
  }, [choose]);

  const pending = useCallback(() => pendingChoice(stateRef.current), []);
  const selection = useCallback(() => stateRef.current.selection, []);
  const hasMenu = useCallback(() => stateRef.current.choices !== null, []);
  const lastLoadFailure = useCallback(() => lastFailureRef.current, []);

  const commit = useCallback(() => update(commitSelection(stateRef.current)), [update]);

  const clearSelection = useCallback(() => {
    selectionKeyRef.current = null;
    update({ ...stateRef.current, selection: null });
  }, [update]);

  /**
   * The server refused the stored pick outright (plan, residency,
   * permission): drop it on this device too, or every new chat re-applies it.
   */
  const forgetPref = useCallback(async () => {
    selectionKeyRef.current = null;
    update({ ...stateRef.current, selection: null });
    try {
      await clearAiModelPref();
    } catch {
      // best effort: the reload below still resolves the pref against the menu
    }
  }, [update]);

  /** A new chat: drop everything, including a continuation parked for the old one. */
  const reset = useCallback(() => {
    tokenRef.current += 1;
    keyRef.current = 'none';
    choicesKeyRef.current = null;
    lastFailureRef.current = null;
    selectionKeyRef.current = null;
    update(INITIAL);
    setSuggested([]);
    setContinuation(null);
  }, [setContinuation, update]);

  return useMemo(() => ({
    state,
    suggested,
    continuation,
    continuationRef,
    load,
    select,
    setOption,
    pending,
    selection,
    hasMenu,
    lastLoadFailure,
    commit,
    clearSelection,
    forgetPref,
    reset,
    setSuggested,
    setContinuation,
  }), [state, suggested, continuation, load, select, setOption, pending, selection, hasMenu, lastLoadFailure, commit, clearSelection, forgetPref, reset, setContinuation]);
}

export type ChatModelPicker = ReturnType<typeof useChatModelPicker>;
