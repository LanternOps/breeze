import { useCallback, useMemo, useRef, useState } from 'react';

import { getChatModelChoices } from '../../services/aiChat';
import { loadAiModelPref, saveAiModelPref } from '../../services/aiModelPrefs';
import {
  commitSelection,
  pendingChoice,
  resolvePersistedPref,
  selectOffering,
  survivingSelection,
  withOption,
  type AiContinuationRequired,
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
      // No menu (registry unavailable, no org context, offline): the composer
      // keeps working on the server default; the picker just isn't shown.
      selectionKeyRef.current = null;
      update({ choices: null, loading: false, selection: null });
      return;
    }
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

  const commit = useCallback(() => update(commitSelection(stateRef.current)), [update]);

  const clearSelection = useCallback(() => {
    selectionKeyRef.current = null;
    update({ ...stateRef.current, selection: null });
  }, [update]);

  /** A new chat: drop everything, including a continuation parked for the old one. */
  const reset = useCallback(() => {
    tokenRef.current += 1;
    keyRef.current = 'none';
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
    commit,
    clearSelection,
    reset,
    setSuggested,
    setContinuation,
  }), [state, suggested, continuation, load, select, setOption, pending, selection, hasMenu, commit, clearSelection, reset, setContinuation]);
}

export type ChatModelPicker = ReturnType<typeof useChatModelPicker>;
