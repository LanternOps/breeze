/**
 * The chat composer's model menu (AI model registry W05, #7603). A choice is
 * PENDING until the next message carries it; the server resolves it strictly
 * and the turn claim stamps it, so a switch only ever lands between turns.
 */
import { create } from 'zustand';
import type { AiContinuationRequired, AiModelChoice, AiModelChoicesDto, AiPageContext, OfferingOptions } from '@breeze/shared';
import { fetchWithAuth } from './auth';

export const RECOVERABLE_MODEL_CODES: ReadonlySet<string> = new Set([
  'model_unavailable', 'not_permitted', 'permission_required', 'plan_required',
  'residency_unavailable', 'unpriced', 'connection_unavailable', 'tools_unsupported',
]);

export interface AiModelPickerState {
  choices: AiModelChoicesDto | null;
  loading: boolean;
  selection: AiModelChoice | null;
  /** The load key the current selection was made under (session id, org, or none). */
  selectionKey: string | null;
  continuation: { required: AiContinuationRequired; pendingContent: string; sourceSessionId: string } | null;
  load(key: { sessionId?: string | null; orgId?: string | null }): Promise<void>;
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

const INITIAL = { choices: null, loading: false, selection: null, selectionKey: null, continuation: null };

/**
 * The org whose menu a chat with NO session yet should show. A partner-scope
 * token has no org of its own, so the API needs `?orgId=`. Mirrors where
 * createSession lands a new session: the page-context device's org first,
 * then the org the user has selected.
 */
export function noSessionOrgId(pageContext: AiPageContext | null | undefined, selectedOrgId: string | null | undefined): string | null {
  if (pageContext?.type === 'device' && pageContext.orgId) return pageContext.orgId;
  return selectedOrgId ?? null;
}

const keyOf = (k: { sessionId?: string | null; orgId?: string | null }): string =>
  k.sessionId ? `s:${k.sessionId}` : k.orgId ? `o:${k.orgId}` : 'none';

let currentKey = 'none';

function sameOptions(a: OfferingOptions | null | undefined, b: OfferingOptions | null | undefined): boolean {
  const norm = (o: OfferingOptions | null | undefined) =>
    JSON.stringify(Object.entries(o ?? {}).filter(([, v]) => v !== undefined).sort(([x], [y]) => x.localeCompare(y)));
  return norm(a) === norm(b);
}

let loadToken = 0;

export const useAiModelPickerStore = create<AiModelPickerState>()((set, get) => ({
  ...INITIAL,

  load: async ({ sessionId, orgId }) => {
    const token = ++loadToken;
    const key = keyOf({ sessionId, orgId });
    currentKey = key;
    set({ loading: true });
    /** Keep a pick made under THIS key while it is still selectable; drop anything else. */
    const survivingSelection = (next: AiModelChoicesDto | null): AiModelChoice | null => {
      const { selection, selectionKey } = get();
      if (!selection || !next || selectionKey !== key) return null;
      const still = next.choices.find((c) => c.offeringId === selection.offeringId);
      return still && !still.disabled ? selection : null;
    };
    try {
      // Never both: the API refuses a request carrying a sessionId and an orgId.
      const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : orgId ? `?orgId=${encodeURIComponent(orgId)}` : '';
      // fetchWithAuth injects the ambient `?orgId=` unless told not to, which
      // would turn a session request into the forbidden pair (#7768). The org
      // branch keeps injection: it names the org explicitly anyway.
      const res = await fetchWithAuth(`/ai/models/choices/chat${qs}`, ...(sessionId ? [{ skipOrgIdInjection: true }] as const : []));
      if (token !== loadToken) return;
      if (!res.ok) {
        console.warn('[AiModelPicker] model choices unavailable, status', res.status);
        set({ choices: null, selection: null, selectionKey: null, loading: false });
        return;
      }
      const body = await res.json() as { data: AiModelChoicesDto };
      if (token !== loadToken) return;
      const selection = survivingSelection(body.data);
      set({ choices: body.data, selection, selectionKey: selection ? key : null, loading: false });
    } catch {
      if (token === loadToken) {
        console.warn('[AiModelPicker] model choices request failed');
        set({ choices: null, selection: null, selectionKey: null, loading: false });
      }
    }
  },

  select: (offeringId) => {
    const choice = get().choices?.choices.find((c) => c.offeringId === offeringId);
    if (!choice || choice.disabled) return;
    const current = get().choices?.current;
    const options = current?.offeringId === offeringId && current.options ? current.options : choice.defaults;
    set({ selection: { offeringId, options: { ...options } }, selectionKey: currentKey });
  },

  setOption: (key, value) => {
    const { offeringId, options } = get().effective();
    if (!offeringId) return;
    const next = { ...options, [key]: value };
    if (value === undefined) delete next[key];
    set({ selection: { offeringId, options: next }, selectionKey: currentKey });
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
    const { selection, choices, loading } = get();
    // A load for another key is in flight: the menu on screen is not the one
    // this send would be checked against, so nothing is pending yet.
    if (loading || !selection || !choices?.allowUserChoice) return undefined;
    const current = choices.current;
    if (current?.offeringId === selection.offeringId && sameOptions(current.options, selection.options)) return undefined;
    return selection;
  },

  commitSelection: () => {
    const { selection, choices } = get();
    if (!selection || !choices) return;
    set({ choices: { ...choices, current: { offeringId: selection.offeringId, options: selection.options ?? {} } }, selection: null });
  },

  clearSelection: () => set({ selection: null, selectionKey: null }),
  requireContinuation: (required, pendingContent, sourceSessionId) => set({ continuation: { required, pendingContent, sourceSessionId } }),
  dismissContinuation: () => set({ continuation: null }),
  reset: () => { loadToken++; currentKey = 'none'; set({ ...INITIAL }); },
}));
