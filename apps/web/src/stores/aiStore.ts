import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AiPageContext, AiStreamEvent, AiApprovalMode, AiTopologyProgressPhase, TopologyAiSelection, AiContinuationRequired, AiModelChoice, AiTurnModel } from '@breeze/shared';
import { fetchWithAuth } from './auth';
import { RECOVERABLE_MODEL_CODES, noSessionOrgId, useAiModelPickerStore } from './aiModelPickerStore';
import { extractApiError } from '@/lib/apiError';
import { i18n } from '@/lib/i18n';
import { ActionError, handleActionError, runAction } from '@/lib/runAction';
import { showToast } from '@/components/shared/Toast';
import {
  processStreamEvent,
  mapMessagesFromApi,
  type AiMessage,
  type PendingApproval,
  type PendingPlan,
  type ActivePlan,
  type ChatRunState,
} from './processStreamEvent';

interface SearchResult {
  id: string;
  title: string | null;
  matchedContent: string;
  createdAt: string;
}

interface M365Connection {
  id: string;
  customerLabel: string;
  customerDisplayName: string;
}

export type WispGrantStatus = 'active' | 'paused' | 'revoked' | 'expired';

/**
 * Wisp mode (W04, spec §5/§6): the delegation grant this chat runs under and
 * the durable thread for that grant. Null = ordinary chat. The server is the
 * authority (every session created while this is set carries `wispGrantId`
 * and is ceiling-gated per tool call); this is the panel's mirror of it.
 * `focus*` is the customer the thread is working on (w00 A24).
 */
export type WispState = {
  grantId: string;
  threadId: string;
  /** The grant's org; null for a partner-wide ("All organizations") grant. */
  scopeOrgId: string | null;
  focusOrgId: string | null;
  focusOrgName: string | null;
  status: WispGrantStatus;
  expiresAt: string;
  summary: string;
  budgetCentsPerDay: number;
  floorTickMinutes: number;
  /** Live reach exceeds the grant's snapshot (W02 `wideningAvailable`, spec §4.4). */
  wideningAvailable: boolean;
} | null;

interface AiState {
  isOpen: boolean;
  sessionId: string | null;
  /**
   * Org the current session is anchored to, as reported by the API (#5684).
   * Null when unknown — a session restored from localStorage only carries its
   * id until `loadSession` resolves the rest.
   */
  sessionOrgId: string | null;
  /**
   * Session whose `messages` in memory are already authoritative — created
   * here, or loaded/switched to from the API. The sidebar's restore effect
   * skips it, so it never re-fetches a session this tab just created and is
   * streaming into (that fetch replaced the optimistic first message, #6933).
   * Not persisted: after a page reload only the id survives, and it restores.
   */
  hydratedSessionId: string | null;
  messages: AiMessage[];
  /** Analysis runs launched from this conversation, keyed by run id (W05). */
  chatRuns: Record<string, ChatRunState>;
  isStreaming: boolean;
  isLoading: boolean;
  error: string | null;
  /**
   * Machine refusal code of the last failed session create / message send
   * (e.g. `investigation_scope_changed`, `topology_ai_disabled`), so a surface
   * can choose honest copy without parsing `error`. Null on success.
   */
  errorCode: string | null;
  /**
   * Topology M4 (#6000): the site the CURRENT session is pinned to when it is
   * an "Explain this" investigation (server-owned pin, echoed here for the
   * stream filter and the Explain panel). Null for every other session.
   */
  topologySiteId: string | null;
  /** The investigation's stored selection (IDs only); null when unknown. */
  topologySelection: TopologyAiSelection | null;
  /** Fixed progress phase of the running topology turn; null when none. */
  topologyPhase: AiTopologyProgressPhase | null;
  /** Accepted run of an approved diagnostic proposal in this session's latest turn. */
  topologyRunId: string | null;
  pageContext: AiPageContext | null;
  pendingApproval: PendingApproval | null;
  pendingPlan: PendingPlan | null;
  activePlan: ActivePlan | null;
  approvalMode: AiApprovalMode;
  isPaused: boolean;
  sessions: Array<{ id: string; title: string | null; status: string; createdAt: string }>;
  showHistory: boolean;
  searchResults: SearchResult[];
  isSearching: boolean;
  isInterrupting: boolean;
  isFlagged: boolean;
  flagReason: string | null;
  // M365 customer binding (Delegant helpdesk tools)
  m365Connections: M365Connection[];
  selectedM365ConnectionId: string | null;
  boundM365ConnectionId: string | null;
  /** W05: the model is thinking (budget/adaptive thinking indicator). */
  thinking: boolean;
  /** W05: what actually ran the last turn (provenance badge). */
  turnModel: AiTurnModel | null;
  /** W05: offering ids suggested after a model refusal. */
  refusalAlternatives: string[];
  /** Wisp mode (W04); null = ordinary chat. Not persisted. */
  wisp: WispState;

  // Actions
  toggle: () => void;
  open: () => void;
  close: () => void;
  setPageContext: (ctx: AiPageContext | null) => void;
  /**
   * `pageContext` overrides the store's current page context for THIS session
   * (topology "Explain this", M4 #6000). A topology context is sent alone: the
   * server pins the session to its site and refuses a device or M365 binding.
   */
  createSession: (opts?: { deviceId?: string; pageContext?: AiPageContext; model?: AiModelChoice; wispGrantId?: string; orgId?: string }) => Promise<void>;
  /** Turn Wisp mode on for a granted thread and open a fresh session under the grant. */
  enterWispMode: (w: NonNullable<WispState>) => Promise<void>;
  /** Change the thread's customer focus (PATCH /wisp/thread/:id/focus); the next turn runs in a new session anchored to it. */
  setWispFocus: (orgId: string | null, orgName: string | null) => Promise<void>;
  /** Merge server-confirmed grant fields (refresh / settings) into the Wisp state. */
  updateWisp: (patch: Partial<NonNullable<WispState>>) => void;
  /** Close the current session and leave Wisp mode. */
  exitWispMode: () => Promise<void>;
  startDeviceTask: (deviceId: string, ctx: AiPageContext, initialMessage?: string) => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  loadSessions: () => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  approveExecution: (executionId: string, approved: boolean) => Promise<void>;
  /**
   * An inline intent decide (Touch ID self-approve) already POSTed to the
   * approvals decide API and the SSE stream carries the actual outcome —
   * this only drops the now-stale card. Never call it as a substitute for
   * approveExecution: it talks to no endpoint.
   */
  clearPendingApproval: () => void;
  approvePlan: (approved: boolean) => Promise<void>;
  abortPlan: () => Promise<void>;
  pauseAi: (paused: boolean) => Promise<void>;
  closeSession: () => Promise<void>;
  clearError: () => void;
  toggleHistory: () => void;
  interruptResponse: () => Promise<void>;
  searchConversations: (query: string) => Promise<void>;
  switchSession: (sessionId: string) => Promise<void>;
  flagSession: (reason?: string) => Promise<void>;
  unflagSession: () => Promise<void>;
  loadM365Connections: () => Promise<void>;
  setSelectedM365Connection: (connectionId: string | null) => void;
}

/**
 * True when an open session belongs to a different org than the device page the
 * chat is now sitting on (#5684).
 *
 * Both sides must be known: a device page context with no `orgId` (an older
 * caller) and a session with no recorded org both mean "cannot tell", and the
 * session is left alone rather than dropped on a guess.
 */
function pageContextOrgMismatch(
  ctx: AiPageContext | null,
  sessionOrgId: string | null,
): boolean {
  return (
    !!ctx && ctx.type === 'device' && !!ctx.orgId && !!sessionOrgId && ctx.orgId !== sessionOrgId
  );
}

/**
 * Session-scoped state to wipe when the chat rebinds to another tenant — the
 * next message then creates a session anchored to the device's org (#5593).
 */
const CLEARED_SESSION = {
  sessionId: null,
  sessionOrgId: null,
  topologySiteId: null,
  topologySelection: null,
  topologyPhase: null,
  topologyRunId: null,
  hydratedSessionId: null,
  messages: [] as AiMessage[],
  isFlagged: false,
  flagReason: null,
  boundM365ConnectionId: null,
  pendingApproval: null,
  pendingPlan: null,
  activePlan: null,
  // A response still streaming for the old tenant is abandoned by the ownership
  // check in `sendMessage`; without clearing these the indicator would spin and
  // `sendMessage`'s `isStreaming` guard would silently refuse the next message.
  isStreaming: false,
  isInterrupting: false,
  isPaused: false,
  thinking: false,
  turnModel: null as AiTurnModel | null,
  refusalAlternatives: [] as string[],
} as const;

/**
 * Wisp mode survives loading a session only when that session runs under the
 * same grant. A session the API reports without `wispGrantId` (a plain chat,
 * or an API that predates W04) drops the Wisp header rather than showing a
 * ceiling the server is not applying.
 */
function wispForLoadedSession(wisp: WispState, session: Record<string, unknown> | undefined): WispState {
  if (!wisp) return null;
  return session?.wispGrantId === wisp.grantId ? wisp : null;
}

/**
 * A loaded session that runs under a grant the panel is not showing (a page
 * reload — `wisp` is not persisted — or a pick from history) gets its Wisp
 * state back from that grant's thread, so the header (scope, focus, revoke)
 * matches the ceiling the server is enforcing. A grant that is no longer live
 * for the session's scope stays headerless: its tool calls are refused anyway.
 */
async function rehydrateWispForSession(sessionId: string, session: Record<string, unknown> | undefined): Promise<void> {
  const grantId = typeof session?.wispGrantId === 'string' ? session.wispGrantId : null;
  if (!grantId || useAiStore.getState().wisp?.grantId === grantId) return;
  const orgId = typeof session?.orgId === 'string' ? session.orgId : null;
  try {
    // Lazy: the step-up/WebAuthn graph stays out of every page's chat bundle.
    const { fetchWispThread } = await import('@/lib/wispGrant');
    // An org grant is keyed by the session's org; a partner-wide one by none.
    for (const scope of orgId ? [orgId, null] : [null]) {
      const state = await fetchWispThread(scope).catch(() => null);
      if (state?.grantId === grantId) {
        if (useAiStore.getState().sessionId === sessionId) useAiStore.setState({ wisp: state });
        return;
      }
    }
  } catch (err) {
    console.warn('[AiStore] Could not restore Wisp mode for the session:', err);
  }
}

/** Session-create refusals that mean the grant cannot carry a session at all. */
const WISP_GRANT_UNUSABLE = new Set(['grant_inactive', 'grant_not_found', 'grant_not_yours', 'wisp_disabled', 'entitlement_required']);

/** A cleared session has no stamped model: drop the picker, then reload the default menu. */
function resetModelPicker(): void {
  const picker = useAiModelPickerStore.getState();
  picker.reset();
  const pageContext = useAiStore.getState().pageContext;
  void readSelectedOrgId()
    .catch(() => null)
    .then((selectedOrgId) => picker.load({ orgId: noSessionOrgId(pageContext, selectedOrgId) }));
}

/**
 * The org selected in the header, or null for none (All organizations).
 * orgStore is read lazily (the way helpStore is) so this store does not pull
 * the org/auth graph in at import time.
 */
async function readSelectedOrgId(): Promise<string | null> {
  const { useOrgStore } = await import('./orgStore');
  return useOrgStore.getState().currentOrgId ?? null;
}

/**
 * The chat on screen just became `sessionId` (reload, History pick,
 * continuation): dismiss a continuation parked
 * for another chat, and reload that chat's menu. `load` bumps its request token,
 * so a still-in-flight load for the old chat can no longer overwrite this one
 * (#7769).
 */
function adoptSessionModelPicker(sessionId: string): void {
  const picker = useAiModelPickerStore.getState();
  const parked = picker.continuation;
  if (parked && parked.sourceSessionId !== sessionId) picker.dismissContinuation();
  void picker.load({ sessionId });
}

/**
 * Identifies the stream `sendMessage` currently owns. A rebind (or any later
 * send) supersedes an in-flight one: the superseded reader must stop appending
 * into the store, or another tenant's assistant output lands in the new chat
 * (#5684).
 */
let activeStreamToken = 0;

/**
 * Identifies the request that currently owns WHICH session the store is bound
 * to (create / load / switch / close). Each such request takes a new token; a
 * response arriving after a newer one began is stale and must not rebind the
 * store — a late create for an abandoned investigation would otherwise
 * overwrite the session (and live stream) the user has since moved to.
 */
let sessionOwnerToken = 0;
const claimSessionOwnership = (): (() => boolean) => {
  const token = ++sessionOwnerToken;
  return () => sessionOwnerToken === token;
};

/**
 * Topology M4 (#6000): the only events a topology investigation turn may
 * render. The server already withholds raw text and tool traffic for such a
 * turn; this is the client-side defense in depth — a generic `content_delta`,
 * tool or plan event arriving on a topology turn is dropped, never rendered.
 */
const TOPOLOGY_TURN_EVENTS: ReadonlySet<AiStreamEvent['type']> = new Set<AiStreamEvent['type']>([
  'message_start', 'topology_progress', 'topology_explanation', 'topology_diagnostic_run',
  'approval_required', 'message_end', 'error', 'done', 'title_updated', 'approval_mode_changed',
]);

/** IDs-only selection of a topology page context, or null for any other context. */
function topologySelectionOf(ctx: unknown): TopologyAiSelection | null {
  if (!ctx || typeof ctx !== 'object') return null;
  const c = ctx as Record<string, unknown>;
  const subject = c.subject as Record<string, unknown> | undefined;
  if (c.type !== 'topology' || typeof c.siteId !== 'string' || typeof c.graphRevision !== 'string'
    || (c.view !== 'overview' && c.view !== 'physical' && c.view !== 'logical')
    || !subject || (subject.kind !== 'node' && subject.kind !== 'relationship') || typeof subject.id !== 'string') return null;
  return { siteId: c.siteId, subject: { kind: subject.kind, id: subject.id }, view: c.view, graphRevision: c.graphRevision };
}

/** Pin + selection fields for a session loaded from `GET /ai/sessions/:id`. */
function topologyFieldsOf(session: Record<string, unknown> | undefined) {
  const siteId = session?.type === 'topology' && typeof session.topologySiteId === 'string' ? session.topologySiteId : null;
  const selection = siteId ? topologySelectionOf(session?.contextSnapshot) : null;
  return {
    topologySiteId: siteId,
    topologySelection: selection && selection.siteId === siteId ? selection : null,
    topologyPhase: null,
    topologyRunId: null,
  };
}

export const useAiStore = create<AiState>()(
  persist(
    (set, get) => ({
  isOpen: false,
  sessionId: null,
  sessionOrgId: null,
  hydratedSessionId: null,
  messages: [],
  chatRuns: {},
  isStreaming: false,
  isLoading: false,
  error: null,
  errorCode: null,
  topologySiteId: null,
  topologySelection: null,
  topologyPhase: null,
  topologyRunId: null,
  pageContext: null,
  pendingApproval: null,
  pendingPlan: null,
  activePlan: null,
  approvalMode: 'per_step' as AiApprovalMode,
  isPaused: false,
  sessions: [],
  showHistory: false,
  searchResults: [],
  isSearching: false,
  isInterrupting: false,
  isFlagged: false,
  flagReason: null,
  m365Connections: [],
  selectedM365ConnectionId: null,
  boundM365ConnectionId: null,
  thinking: false,
  turnModel: null,
  refusalAlternatives: [],
  wisp: null,

  toggle: () => {
    const opening = !get().isOpen;
    if (opening) {
      import('./helpStore').then(({ useHelpStore }) => useHelpStore.getState().close()).catch((err) => console.warn('[AiStore] Failed to close help panel:', err));
    }
    set({ isOpen: opening });
  },
  open: () => {
    import('./helpStore').then(({ useHelpStore }) => useHelpStore.getState().close()).catch((err) => console.warn('[AiStore] Failed to close help panel:', err));
    set({ isOpen: true });
  },
  close: () => set({ isOpen: false }),
  clearError: () => set({ error: null, errorCode: null }),

  setPageContext: (ctx) =>
    set((s) =>
      pageContextOrgMismatch(ctx, s.sessionOrgId)
        ? (resetModelPicker(), { pageContext: ctx, ...CLEARED_SESSION })
        : { pageContext: ctx },
    ),

  createSession: async (opts) => {
    const ownsSession = claimSessionOwnership();
    // A different chat begins: the previous chat's pick must not ride along.
    // (A pick handed in via opts.model is the one this create commits.)
    if (!opts?.model) useAiModelPickerStore.getState().clearSelection();
    set({ isLoading: true, error: null, errorCode: null });
    const { pageContext: storeContext, selectedM365ConnectionId, approvalMode } = get();
    const pageContext = opts?.pageContext ?? storeContext;
    const topology = pageContext?.type === 'topology';
    if (topology) {
      // Topology M4 (#6000) "Explain this": the ONLY model-start path of an
      // investigation, so its outcome is always surfaced (runAction). Sent
      // alone — the server pins the session to the authorized site and
      // refuses a device or M365 binding.
      const selection = topologySelectionOf(pageContext);
      const errorFallback = i18n.t('topology:ai.startFailed');
      // Take the shared store over from whatever it was streaming: a superseded
      // stream must stop writing, and a stale `isStreaming` would make the
      // investigation's first sendMessage a silent no-op.
      const streamToken = ++activeStreamToken;
      /** False once a newer create/load/switch or a newer send took the store over. */
      const ownsCreate = () => ownsSession() && activeStreamToken === streamToken;
      set({ isStreaming: false, isInterrupting: false, pendingApproval: null, pendingPlan: null, activePlan: null });
      try {
        const data = await runAction<{ id: string; orgId?: string | null }>({
          request: () => fetchWithAuth('/ai/sessions', {
            method: 'POST',
            body: JSON.stringify({ pageContext, approvalMode }),
          }),
          errorFallback,
          successMessage: i18n.t('topology:ai.started'),
        });
        if (!ownsCreate()) return;
        set({
          sessionId: data.id,
          sessionOrgId: data.orgId ?? null,
          hydratedSessionId: data.id,
          messages: [],
          isLoading: false,
          isFlagged: false,
          flagReason: null,
          boundM365ConnectionId: null,
          pendingApproval: null,
          topologySiteId: selection?.siteId ?? null,
          topologySelection: selection,
          topologyPhase: null,
          topologyRunId: null,
        });
      } catch (err) {
        handleActionError(err, errorFallback);
        if (!ownsCreate()) return;
        set({
          error: err instanceof Error ? err.message : errorFallback,
          errorCode: err instanceof ActionError ? err.code ?? null : null,
          isLoading: false,
        });
      }
      return;
    }
    // Wisp (W04): while Wisp mode is on, every new conversation stays on the
    // grant, anchored to the thread's focus org (else the grant's org) — the
    // server refuses an explicit org that differs from the focus (409
    // focus_mismatch) rather than re-anchoring silently.
    const wisp = get().wisp;
    const wispGrantId = opts?.wispGrantId ?? wisp?.grantId;
    const wispOrgId = opts?.wispGrantId ? null : wisp ? (wisp.focusOrgId ?? wisp.scopeOrgId) : null;
    try {
      const orgId = opts?.orgId
        ?? wispOrgId
        ?? (pageContext?.type === 'device' || opts?.deviceId ? null : await readSelectedOrgId());
      const res = await fetchWithAuth('/ai/sessions', {
        method: 'POST',
        body: JSON.stringify({
          // #9529: with no device on the page, the session belongs to the org
          // selected in the header. A device page / device task lets the
          // server anchor to the device's org instead (#5593), and no
          // selection (All organizations) sends nothing.
          orgId: orgId ?? undefined,
          ...(wispGrantId ? { wispGrantId } : {}),
          pageContext: pageContext ?? undefined,
          delegantM365ConnectionId: selectedM365ConnectionId ?? undefined,
          deviceId: opts?.deviceId ?? undefined,
          approvalMode,
          // W05 (Codex review finding 12): a model picked before the first
          // message creates the session ON that model (W03 create contract).
          ...(opts?.model ? { offeringId: opts.model.offeringId, options: opts.model.options } : {}),
        })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        // A refused Wisp create (grant_inactive, focus_mismatch, …) keeps its
        // machine code so the panel can tell it apart; plain chat is unchanged.
        if (wispGrantId && ownsSession()) {
          const code = typeof data?.code === 'string' ? data.code : null;
          // A dead grant must not keep the Wisp header up over a panel with no
          // session; the error banner keeps the server's reason.
          set({ errorCode: code, ...(code && WISP_GRANT_UNUSABLE.has(code) ? { wisp: null } : {}) });
        }
        throw new Error(extractApiError(data, 'Failed to create session'));
      }
      const data = await res.json();
      if (!ownsSession()) return;
      // w00 A24: the server clears a focus that fell outside the live ceiling
      // and reports `wispFocusOrgId: null`; mirror it and say so.
      const current = get().wisp;
      if (wispGrantId && current?.grantId === wispGrantId && current.focusOrgId && data.wispFocusOrgId === null) {
        set({ wisp: { ...current, focusOrgId: null, focusOrgName: null } });
        showToast({ message: i18n.t('ai:wisp.toast.focusCleared'), type: 'warning' });
      }
      set({
        sessionId: data.id,
        sessionOrgId: data.orgId ?? null,
        hydratedSessionId: data.id,
        messages: [],
        isLoading: false,
        isFlagged: false,
        flagReason: null,
        boundM365ConnectionId: data.delegantM365ConnectionId ?? null,
        topologySiteId: null,
        topologySelection: null,
        topologyPhase: null,
        topologyRunId: null,
      });
      if (opts?.model) useAiModelPickerStore.getState().commitSelection();
      void useAiModelPickerStore.getState().load({ sessionId: data.id });
    } catch (err) {
      if (!ownsSession()) return;
      set({
        error: err instanceof Error ? err.message : 'Failed to create session',
        isLoading: false
      });
    }
  },

  // Start a fresh AI session bound to a specific device ("Ask AI about reliability"
  // on the device page). Sets the device page-context, opens the panel, creates a
  // device-scoped session, and — when an initial message is supplied — auto-sends it
  // so the tech gets an answer without retyping the context.
  startDeviceTask: async (deviceId, ctx, initialMessage) => {
    useAiModelPickerStore.getState().clearSelection();
    set({ pageContext: ctx, sessionId: null, sessionOrgId: null, messages: [], isFlagged: false, flagReason: null, isOpen: true });
    await get().createSession({ deviceId });
    // Only send if the session was actually created — createSession leaves
    // sessionId null and sets `error` on failure; sending then would be session-less.
    if (initialMessage && initialMessage.trim() && get().sessionId) {
      await get().sendMessage(initialMessage);
    }
  },

  loadSession: async (sessionId: string) => {
    const ownsSession = claimSessionOwnership();
    // Another chat's pick must never ride on this chat's next message.
    if (get().sessionId !== sessionId) useAiModelPickerStore.getState().clearSelection();
    set({ isLoading: true, error: null });
    try {
      const res = await fetchWithAuth(`/ai/sessions/${sessionId}`);
      if (!ownsSession()) return;
      if (!res.ok) {
        if (res.status === 404) {
          set({ sessionId: null, sessionOrgId: null, messages: [], isLoading: false });
        } else {
          set({ error: 'Failed to load session', isLoading: false });
        }
        return;
      }
      const data = await res.json();
      if (!ownsSession()) return;
      if (data.session?.status !== 'active') {
        set({ sessionId: null, sessionOrgId: null, messages: [], isLoading: false });
        return;
      }

      // Only the session id survives a reload, so the org arrives here — this is
      // where a persisted Org A session opened on an Org B device page is
      // caught and dropped (#5684).
      const restoredOrgId: string | null = data.session.orgId ?? null;
      if (pageContextOrgMismatch(get().pageContext, restoredOrgId)) {
        set({ ...CLEARED_SESSION, isLoading: false });
        resetModelPicker();
        return;
      }

      const messages = mapMessagesFromApi(data.messages || []);

      set({
        sessionId,
        sessionOrgId: restoredOrgId,
        hydratedSessionId: sessionId,
        messages,
        isLoading: false,
        isFlagged: !!data.session.flaggedAt,
        flagReason: data.session.flagReason ?? null,
        boundM365ConnectionId: data.session.delegantM365ConnectionId ?? null,
        turnModel: (data.session.lastTurnModel ?? null) as AiTurnModel | null,
        thinking: false,
        refusalAlternatives: [],
        ...topologyFieldsOf(data.session),
        wisp: wispForLoadedSession(get().wisp, data.session),
      });
      adoptSessionModelPicker(sessionId);
      void rehydrateWispForSession(sessionId, data.session);
    } catch (err) {
      if (!ownsSession()) return;
      set({
        sessionId: null,
        sessionOrgId: null,
        messages: [],
        error: err instanceof Error ? err.message : 'Failed to load session',
        isLoading: false
      });
    }
  },

  loadSessions: async () => {
    try {
      const res = await fetchWithAuth('/ai/sessions?status=active');
      if (!res.ok) {
        console.error('[AI] Failed to load sessions: HTTP', res.status);
        return;
      }
      const data = await res.json();
      set({ sessions: data.data || [] });
    } catch (err) {
      console.error('[AI] Failed to load sessions:', err);
    }
  },

  sendMessage: async (content: string) => {
    const trimmedContent = content.trim();
    if (!trimmedContent) return;

    const { sessionId, isStreaming, isLoading } = get();

    if (isStreaming || isLoading) return;

    // W05: the composer's pending choice rides on this message — or, for the
    // first message of a new chat, on the session create.
    const model = useAiModelPickerStore.getState().pendingChoice();
    const createdNow = !sessionId;

    if (!sessionId) {
      await get().createSession(model ? { model } : undefined);
    }

    const currentSessionId = get().sessionId;
    if (!currentSessionId) return;

    const userMsgId = crypto.randomUUID();
    const userMsg: AiMessage = {
      id: userMsgId,
      role: 'user',
      content: trimmedContent,
      createdAt: new Date()
    };

    set((s) => ({
      messages: [...s.messages, userMsg],
      isStreaming: true,
      error: null,
      errorCode: null,
      pendingApproval: null,
      topologyPhase: null,
      topologyRunId: null,
    }));
    // A topology investigation turn renders only vetted events (see TOPOLOGY_TURN_EVENTS).
    const topologyTurn = get().topologySiteId !== null;

    const streamToken = ++activeStreamToken;
    /** False once this stream has been superseded — by a rebind, or a newer send. */
    const ownsStream = () => activeStreamToken === streamToken && get().sessionId === currentSessionId;

    try {
      const { pageContext } = get();
      const res = await fetchWithAuth(`/ai/sessions/${currentSessionId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: trimmedContent, pageContext: pageContext ?? undefined, ...(model && !createdNow ? { model } : {}) })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);

        const code = data && typeof data === 'object' && typeof (data as { code?: unknown }).code === 'string'
          ? (data as { code: string }).code : null;

        if (res.status === 409 && code === 'continuation_required') {
          // W05: the switch cannot resume. The message is parked for the
          // continuation prompt, not lost or errored.
          useAiModelPickerStore.getState().requireContinuation(data as AiContinuationRequired, trimmedContent, currentSessionId);
          set((s) => ({ messages: s.messages.filter((m) => m.id !== userMsgId), isStreaming: false }));
          return;
        }
        if (res.status === 409 && code && (RECOVERABLE_MODEL_CODES.has(code) || code === 'topology_model_changed')) {
          // The chosen / stored model is no longer usable: refresh the menu so
          // the tech can pick another (spec §9.1 "choose another").
          void useAiModelPickerStore.getState().load({ sessionId: currentSessionId });
        }

        // A coded 409 that is not the continuation prompt rejected this turn
        // before it ran: drop the optimistic bubble so the transcript matches
        // the server's (turn_in_progress keeps the pick for the retry).
        if (res.status === 409 && code && (code === 'turn_in_progress' || code === 'topology_model_changed' || RECOVERABLE_MODEL_CODES.has(code))) {
          set((s) => ({
            messages: s.messages.filter((m) => m.id !== userMsgId),
            error: extractApiError(data, 'Failed to send message'),
            errorCode: code,
            isStreaming: false,
          }));
          return;
        }

        // The credit / plan gate refused the turn before it ran (#9450): drop
        // the optimistic bubble like the coded 409s and keep the code so the
        // chat can offer a way forward (Buy credits) instead of bare text.
        if (res.status === 402 && code) {
          set((s) => ({
            messages: s.messages.filter((m) => m.id !== userMsgId),
            error: extractApiError(data, 'Failed to send message'),
            errorCode: code,
            isStreaming: false,
          }));
          return;
        }

        if (res.status === 409 && !code) {
          set((s) => ({
            messages: s.messages.filter((m) => m.id !== userMsgId),
            error: extractApiError(data, 'Another response is still in progress for this conversation.')
          }));
          return;
        }

        set({ errorCode: code });
        throw new Error(extractApiError(data, 'Failed to send message'));
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let currentAssistantId: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (ownsStream()) useAiModelPickerStore.getState().commitSelection();
          break;
        }
        // The chat can rebind to another org mid-response (#5684). Drop the
        // rest of this stream rather than replay it into whatever session is
        // live now — its content belongs to the previous tenant.
        if (!ownsStream()) {
          await reader.cancel().catch(() => undefined);
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data:')) {
            const jsonStr = line.slice(5).trim();
            if (!jsonStr) continue;

            try {
              const event = JSON.parse(jsonStr) as AiStreamEvent;
              if (!ownsStream()) break;
              if (topologyTurn && !TOPOLOGY_TURN_EVENTS.has(event.type)) continue;
              currentAssistantId = processStreamEvent(event, set, get, currentAssistantId);
              // The tool_result / unattended_release events that normally withdraw
              // an approval card never reach a topology turn: withdraw it when the
              // run is announced or the turn ends (decided elsewhere, or timed out).
              if (topologyTurn && (event.type === 'done' || event.type === 'topology_diagnostic_run')) set({ pendingApproval: null });
            } catch (parseErr) {
              console.error('[AI] Failed to parse SSE event:', jsonStr.slice(0, 200), parseErr);
            }
          }
        }
      }
    } catch (err) {
      // A superseded stream must not raise an error on the session that
      // replaced it — its failure is no longer anything the user can act on.
      if (!ownsStream()) return;
      set({
        error: err instanceof Error ? err.message : 'Failed to send message',
        isStreaming: false
      });
    } finally {
      if (activeStreamToken === streamToken && get().isStreaming) {
        set({ isStreaming: false });
      }
    }
  },

  approveExecution: async (executionId: string, approved: boolean) => {
    const { sessionId } = get();
    if (!sessionId) return;

    try {
      const res = await fetchWithAuth(`/ai/sessions/${sessionId}/approve/${executionId}`, {
        method: 'POST',
        body: JSON.stringify({ approved })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        set({ error: extractApiError(data, 'Failed to process approval. It may have timed out.') });
        return;
      }
      set({ pendingApproval: null });
    } catch (err) {
      console.error('[AI] Approval failed:', err);
      set({ error: 'Failed to process approval' });
    }
  },

  clearPendingApproval: () => set({ pendingApproval: null }),

  approvePlan: async (approved: boolean) => {
    const { sessionId } = get();
    if (!sessionId) return;

    try {
      const res = await fetchWithAuth(`/ai/sessions/${sessionId}/approve-plan`, {
        method: 'POST',
        body: JSON.stringify({ approved })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        set({ error: extractApiError(data, 'Failed to process plan approval') });
        return;
      }
      if (approved) {
        const plan = get().pendingPlan;
        if (plan) {
          set({
            pendingPlan: null,
            activePlan: {
              planId: plan.planId,
              steps: plan.steps,
              currentStepIndex: 0,
              status: 'executing',
            },
          });
        }
      } else {
        set({ pendingPlan: null });
      }
    } catch (err) {
      console.error('[AI] Plan approval failed:', err);
      set({ error: 'Failed to process plan approval' });
    }
  },

  abortPlan: async () => {
    const { sessionId } = get();
    if (!sessionId) return;

    try {
      const res = await fetchWithAuth(`/ai/sessions/${sessionId}/abort-plan`, {
        method: 'POST'
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        set({ error: extractApiError(data, 'Failed to abort plan') });
        return;
      }
      set({ activePlan: null });
    } catch (err) {
      console.error('[AI] Plan abort failed:', err);
      set({ error: 'Failed to abort plan' });
    }
  },

  pauseAi: async (paused: boolean) => {
    const { sessionId } = get();
    if (!sessionId) return;

    try {
      const res = await fetchWithAuth(`/ai/sessions/${sessionId}/pause`, {
        method: 'POST',
        body: JSON.stringify({ paused })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        set({ error: extractApiError(data, 'Failed to pause AI') });
        return;
      }
      set({ isPaused: paused });
    } catch (err) {
      console.error('[AI] Pause failed:', err);
      set({ error: 'Failed to pause AI' });
    }
  },

  closeSession: async () => {
    const { sessionId } = get();
    if (!sessionId) return;
    const ownsSession = claimSessionOwnership();

    try {
      const res = await fetchWithAuth(`/ai/sessions/${sessionId}`, { method: 'DELETE' });
      if (!ownsSession()) return;
      if (!res.ok) {
        set({ error: 'Failed to close session' });
        return;
      }
      set({ sessionId: null, sessionOrgId: null, messages: [], boundM365ConnectionId: null });
      resetModelPicker();
    } catch (err) {
      console.error('[AI] Failed to close session:', err);
      set({ error: 'Failed to close session' });
    }
  },

  toggleHistory: () => set((s) => ({ showHistory: !s.showHistory, searchResults: [] })),

  interruptResponse: async () => {
    const { sessionId } = get();
    if (!sessionId) return;

    set({ isInterrupting: true });
    try {
      const res = await fetchWithAuth(`/ai/sessions/${sessionId}/interrupt`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.interrupted === false) {
        set({ error: data.reason || 'Could not interrupt the response' });
      }
    } catch (err) {
      console.error('[AI] Interrupt failed:', err);
      set({ error: 'Failed to interrupt the response' });
    } finally {
      set({ isInterrupting: false });
    }
  },

  searchConversations: async (query: string) => {
    if (query.length < 2) {
      set({ searchResults: [], isSearching: false });
      return;
    }
    set({ isSearching: true });
    try {
      const res = await fetchWithAuth(`/ai/sessions/search?q=${encodeURIComponent(query)}&limit=20`);
      if (res.ok) {
        const data = await res.json();
        set({ searchResults: data.data || [], isSearching: false });
      } else {
        const data = await res.json().catch(() => null);
        set({ isSearching: false, error: extractApiError(data, 'Search failed') });
      }
    } catch (err) {
      console.error('[AI] Search failed:', err);
      set({ isSearching: false, error: 'Search failed' });
    }
  },

  switchSession: async (sessionId: string) => {
    const ownsSession = claimSessionOwnership();
    // Another chat's pick must never ride on this chat's next message.
    if (get().sessionId !== sessionId) useAiModelPickerStore.getState().clearSelection();
    set({ showHistory: false, isLoading: true, error: null });
    try {
      const res = await fetchWithAuth(`/ai/sessions/${sessionId}`);
      if (!res.ok) throw new Error('Failed to load session');
      const data = await res.json();
      if (!ownsSession()) return;

      const messages = mapMessagesFromApi(data.messages || []);

      set({
        sessionId,
        // An explicit pick from the history panel is authoritative — it is not
        // dropped on an org mismatch, but the org is recorded so a later page
        // navigation can rebind (#5684).
        sessionOrgId: data.session?.orgId ?? null,
        hydratedSessionId: sessionId,
        messages,
        isLoading: false,
        isFlagged: !!data.session?.flaggedAt,
        flagReason: data.session?.flagReason ?? null,
        boundM365ConnectionId: data.session?.delegantM365ConnectionId ?? null,
        turnModel: (data.session?.lastTurnModel ?? null) as AiTurnModel | null,
        thinking: false,
        refusalAlternatives: [],
        ...topologyFieldsOf(data.session),
        wisp: wispForLoadedSession(get().wisp, data.session),
      });
      adoptSessionModelPicker(sessionId);
      void rehydrateWispForSession(sessionId, data.session);
    } catch (err) {
      if (!ownsSession()) return;
      set({
        error: err instanceof Error ? err.message : 'Failed to load session',
        isLoading: false
      });
    }
  },

  flagSession: async (reason?: string) => {
    const { sessionId } = get();
    if (!sessionId) return;
    try {
      const res = await fetchWithAuth(`/ai/sessions/${sessionId}/flag`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        set({ error: extractApiError(data, 'Failed to flag session') });
        return;
      }
      set({ isFlagged: true, flagReason: reason ?? null });
    } catch (err) {
      console.error('Failed to flag session:', err);
      set({ error: 'Failed to flag session' });
    }
  },

  unflagSession: async () => {
    const { sessionId } = get();
    if (!sessionId) return;
    try {
      const res = await fetchWithAuth(`/ai/sessions/${sessionId}/flag`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        set({ error: extractApiError(data, 'Failed to unflag session') });
        return;
      }
      set({ isFlagged: false, flagReason: null });
    } catch (err) {
      console.error('Failed to unflag session:', err);
      set({ error: 'Failed to unflag session' });
    }
  },

  loadM365Connections: async () => {
    try {
      const res = await fetchWithAuth('/ai/m365-connections');
      if (!res.ok) {
        console.error('[AI] Failed to load M365 connections: HTTP', res.status);
        return;
      }
      const data = await res.json();
      set({ m365Connections: data.data || [] });
    } catch (err) {
      console.error('[AI] Failed to load M365 connections:', err);
    }
  },

  setSelectedM365Connection: (connectionId: string | null) =>
    set({ selectedM365ConnectionId: connectionId }),

  enterWispMode: async (w) => {
    // A Wisp conversation starts fresh on the grant's thread; the plain chat
    // that was open stays in history (not closed — it is not the thread's).
    set({ wisp: w, ...CLEARED_SESSION });
    await get().createSession({ wispGrantId: w.grantId, orgId: w.focusOrgId ?? w.scopeOrgId ?? undefined });
  },

  setWispFocus: async (orgId, orgName) => {
    const w = get().wisp;
    if (!w) return;
    const errorFallback = i18n.t('ai:wisp.toast.focusFailed');
    let focus: { focusOrgId: string | null; focusOrgName: string | null };
    try {
      const body = await runAction<{ data?: { focusOrgId?: string | null; focusOrgName?: string | null } }>({
        request: () => fetchWithAuth(`/wisp/thread/${w.threadId}/focus`, { method: 'PATCH', body: JSON.stringify({ orgId }) }),
        errorFallback,
        successMessage: (res) => {
          const name = res?.data?.focusOrgName ?? orgName;
          return orgId ? i18n.t('ai:wisp.toast.focusSet', { org: name ?? '' }) : i18n.t('ai:wisp.toast.focusCleared');
        },
      });
      // The server's answer wins; an older body without `data` keeps what was asked for.
      focus = {
        focusOrgId: body?.data?.focusOrgId !== undefined ? body.data.focusOrgId : orgId,
        focusOrgName: body?.data?.focusOrgName !== undefined ? body.data.focusOrgName : orgName,
      };
    } catch (err) {
      handleActionError(err, errorFallback);
      return;
    }
    const live = get().wisp;
    if (!live || live.threadId !== w.threadId) return;
    set({ wisp: { ...live, ...focus } });
    // Switching focus is a chat action on the same thread, not a new thread
    // (spec §6.1): close the current session so its summary lands on the
    // thread, then anchor the next turn's session to the new focus.
    if (get().sessionId) await get().closeSession();
    set({ ...CLEARED_SESSION });
    await get().createSession({ wispGrantId: w.grantId, orgId: focus.focusOrgId ?? live.scopeOrgId ?? undefined });
  },

  updateWisp: (patch) => set((s) => (s.wisp ? { wisp: { ...s.wisp, ...patch } } : {})),

  exitWispMode: async () => {
    // Best-effort close: a session left open idles out and the server
    // finalizes its thread summary on expiry, so a failed close is not
    // surfaced over the plain chat the user is returning to.
    if (get().sessionId) await get().closeSession();
    set({ wisp: null, ...CLEARED_SESSION, error: null, errorCode: null });
  },
    }),
    {
      name: 'breeze-ai-chat',
      partialize: (state) => ({
        sessionId: state.sessionId,
        sessionOrgId: state.sessionOrgId,
      }),
    }
  )
);
