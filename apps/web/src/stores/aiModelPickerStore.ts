/**
 * The chat composer's model menu (AI model registry W05, #7603). A choice is
 * PENDING until the next message carries it; the server resolves it strictly
 * and the turn claim stamps it, so a switch only ever lands between turns.
 */
import { create } from 'zustand';
import type { AiContinuationRequired, AiModelChoice, AiModelChoicesDto, OfferingOptions } from '@breeze/shared';
import { fetchWithAuth } from './auth';

export const RECOVERABLE_MODEL_CODES: ReadonlySet<string> = new Set([
  'model_unavailable', 'not_permitted', 'permission_required', 'plan_required',
  'residency_unavailable', 'unpriced', 'connection_unavailable', 'tools_unsupported',
]);

export interface AiModelPickerState {
  choices: AiModelChoicesDto | null;
  loading: boolean;
  selection: AiModelChoice | null;
  continuation: { required: AiContinuationRequired; pendingContent: string; sourceSessionId: string } | null;
  load(key: { sessionId?: string | null }): Promise<void>;
  select(offeringId: string): void;
  setOption<K extends keyof OfferingOptions>(key: K, value: OfferingOptions[K] | undefined): void;
  effective(): { offeringId: string | null; options: OfferingOptions };
  pendingChoice(): AiModelChoice | undefined;
  commitSelection(): void;
  clearSelection(): void;
  requireContinuation(required: AiContinuationRequired, pendingContent: string, sourceSessionId: string): void;
  dismissContinuation(): void;
  reset(): void;
}

const INITIAL = { choices: null, loading: false, selection: null, continuation: null };

function sameOptions(a: OfferingOptions | null | undefined, b: OfferingOptions | null | undefined): boolean {
  const norm = (o: OfferingOptions | null | undefined) =>
    JSON.stringify(Object.entries(o ?? {}).filter(([, v]) => v !== undefined).sort(([x], [y]) => x.localeCompare(y)));
  return norm(a) === norm(b);
}

let loadToken = 0;

export const useAiModelPickerStore = create<AiModelPickerState>()((set, get) => ({
  ...INITIAL,

  load: async ({ sessionId }) => {
    const token = ++loadToken;
    set({ loading: true });
    try {
      const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
      const res = await fetchWithAuth(`/ai/models/choices/chat${qs}`);
      if (token !== loadToken) return;
      if (!res.ok) { set({ choices: null, selection: null, loading: false }); return; }
      const body = await res.json() as { data: AiModelChoicesDto };
      if (token !== loadToken) return;
      set({ choices: body.data, selection: null, loading: false });
    } catch {
      if (token === loadToken) set({ choices: null, selection: null, loading: false });
    }
  },

  select: (offeringId) => {
    const choice = get().choices?.choices.find((c) => c.offeringId === offeringId);
    if (!choice || choice.disabled) return;
    const current = get().choices?.current;
    const options = current?.offeringId === offeringId && current.options ? current.options : choice.defaults;
    set({ selection: { offeringId, options: { ...options } } });
  },

  setOption: (key, value) => {
    const { offeringId, options } = get().effective();
    if (!offeringId) return;
    const next = { ...options, [key]: value };
    if (value === undefined) delete next[key];
    set({ selection: { offeringId, options: next } });
  },

  effective: () => {
    const { selection, choices } = get();
    if (selection) return { offeringId: selection.offeringId, options: selection.options ?? {} };
    const current = choices?.current;
    const offeringId = current?.offeringId ?? choices?.defaultOfferingId ?? null;
    const choice = choices?.choices.find((c) => c.offeringId === offeringId);
    return { offeringId, options: current?.options ?? choice?.defaults ?? {} };
  },

  pendingChoice: () => {
    const { selection, choices } = get();
    if (!selection || !choices?.allowUserChoice) return undefined;
    const current = choices.current;
    if (current?.offeringId === selection.offeringId && sameOptions(current.options, selection.options)) return undefined;
    return selection;
  },

  commitSelection: () => {
    const { selection, choices } = get();
    if (!selection || !choices) return;
    set({ choices: { ...choices, current: { offeringId: selection.offeringId, options: selection.options ?? {} } }, selection: null });
  },

  clearSelection: () => set({ selection: null }),
  requireContinuation: (required, pendingContent, sourceSessionId) => set({ continuation: { required, pendingContent, sourceSessionId } }),
  dismissContinuation: () => set({ continuation: null }),
  reset: () => { loadToken++; set({ ...INITIAL }); },
}));
