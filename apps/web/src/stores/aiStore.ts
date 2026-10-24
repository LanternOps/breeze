import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AiAttachState, AiPageContext, AiStreamEvent, AiApprovalMode, AiTopologyProgressPhase, TopologyAiSelection, AiContinuationRequired, AiModelChoice, AiTurnModel } from '@breeze/shared';
import { fetchWithAuth } from './auth';
import { noSessionOrgId, useAiModelPickerStore } from './aiModelPickerStore';
import { classifySendRefusal } from './aiSendRefusal';
import { isChatSessionType } from './aiSessionOpen';
import { attachAiSession, attachBackoffMs, shouldReattach, trackAttach, type AttachOutcome } from './aiSessionAttach';
import { extractApiError } from '@/lib/apiError';
import { i18n } from '@/lib/i18n';
import { ActionError, handleActionError, runAction } from '@/lib/runAction';
import {
  attachAnchorMissing,
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
  /**
   * #9427: attached to a running turn whose reply so far could not be replayed
   * (`attach_state.partial`); the full reply appears when it finishes.
   */
  joinedMidResponse: boolean;
  /**
   * #9427: the side-panel composer's text, held here (not persisted) so a
   * refused send can put its text back and a move can carry a draft.
   */
  composerDraft: string;

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
  createSession: (opts?: { deviceId?: string; pageContext?: AiPageContext; model?: AiModelChoice }) => Promise<void>;
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
  setComposerDraft: (text: string) => void;
  /**
   * #9427: attach to the bound session's current turn (GET …/stream) and apply
   * it until the turn ends, re-attaching per shouldReattach. Takes a new stream
   * token, so the next send, rebind, release or attach supersedes it. Never
   * rejects. Exported on the state for tests; the store calls it itself.
   */
  attachCurrent: (opts?: { afterClosedOr409?: boolean }) => Promise<void>;
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
  joinedMidResponse: false,
} as const;

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
  // A bind change ends the live attach now, not at its next frame (#9427).
  abortCurrentAttach();
  return () => sessionOwnerToken === token;
};

/**
 * #9427: the send stream's reader, held so releaseSession can cancel a parked
 * `read()` synchronously — the stream token alone is only noticed after the
 * next chunk arrives.
 */
let currentSendReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

/** #9427: the live attach loop's controller (one per attachCurrent call). */
let currentAttachController: AbortController | null = null;

function abortCurrentAttach(): void {
  const controller = currentAttachController;
  currentAttachController = null;
  controller?.abort();
}

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

type AiSet = (partial: Partial<AiState> | ((s: AiState) => Partial<AiState>)) => void;
type AiGet = () => AiState;

/** Per-attempt bookkeeping of one attach (one GET …/stream). */
interface AttachAttempt {
  /** False once a newer send/rebind/release/attach took the store over. */
  owns: () => boolean;
  /** Aborts this attempt's reader (stale writer, or a missing anchor). */
  abort: () => void;
  topology: boolean;
  currentAssistantId: string | null;
}

/**
 * #9427: the one place attach-delivered events reach the store (the seam
 * #9429's notifications will hook). Guarded by the attach token and the session
 * owner: a superseded attach stops its reader and writes nothing.
 */
function applyAttachEvent(set: AiSet, get: AiGet, event: AiStreamEvent, attempt: AttachAttempt): boolean {
  if (!attempt.owns()) {
    attempt.abort();
    return false;
  }
  attempt.currentAssistantId = processStreamEvent(event, set, get, attempt.currentAssistantId);
  // Same rule as a topology send: the events that normally withdraw an approval
  // card never reach a topology turn, so the run announcement or the turn's end does.
  if (attempt.topology && (event.type === 'done' || event.type === 'topology_diagnostic_run')) set({ pendingApproval: null });
  return true;
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

type AttachLoopReady = 'ready' | 'not_found' | 'stopped';

/**
 * #9427 (spec §3.5): attach the bound session's current turn and keep it
 * applied until the turn ends. One attach covers one turn; a running attach
 * that ends without `done` re-attaches per W1's shouldReattach/attachBackoffMs
 * (Gate B #6). When the loop stops without `done`: one messages re-read (only
 * if the loop saw or retried anything), `isStreaming:false`,
 * `joinedMidResponse:false`, `error` untouched. `not_found` unbinds like
 * loadSession's 404 path.
 *
 * `ready` settles once a snapshot is applied (or the loop ends first);
 * `finished` when the loop ends. Neither rejects.
 */
function startAttach(
  set: AiSet,
  get: AiGet,
  opts: { afterClosedOr409?: boolean } = {},
): { ready: Promise<AttachLoopReady>; finished: Promise<void> } {
  const sessionId = get().sessionId;
  if (!sessionId) {
    const stopped = Promise.resolve<AttachLoopReady>('stopped');
    return { ready: stopped, finished: stopped.then(() => undefined) };
  }

  const streamToken = ++activeStreamToken;
  // Observed, not claimed: an attach is a reader and must not cancel an
  // in-flight create/load/switch/close. Any later one invalidates this attach.
  const ownerToken = sessionOwnerToken;
  abortCurrentAttach();
  const controller = new AbortController();
  currentAttachController = controller;
  const untrack = trackAttach(controller);

  const owns = () =>
    !controller.signal.aborted
    && activeStreamToken === streamToken
    && sessionOwnerToken === ownerToken
    && get().sessionId === sessionId;
  const topology = get().topologySiteId !== null;
  const filter = topology ? (e: AiStreamEvent) => TOPOLOGY_TURN_EVENTS.has(e.type) : undefined;

  let settleReady!: (r: AttachLoopReady) => void;
  const ready = new Promise<AttachLoopReady>((resolve) => { settleReady = resolve; });

  /** One owner-guarded messages re-read (reconciliation). */
  const rehydrate = async (): Promise<void> => {
    try {
      const res = await fetchWithAuth(`/ai/sessions/${sessionId}`);
      if (!owns()) return;
      if (!res.ok) {
        console.warn('[AI] Attach re-hydrate failed: HTTP', res.status);
        return;
      }
      const data = await res.json();
      if (!owns()) return;
      set({ messages: mapMessagesFromApi(data.messages || []) });
    } catch (err) {
      console.warn('[AI] Attach re-hydrate failed:', err);
    }
  };

  const run = async (): Promise<void> => {
    const cycle = { attempt: 0, afterClosedOr409: !!opts.afterClosedOr409 };
    let anchorRetried = false;
    // Whether a stop re-reads messages: something may have changed since the
    // hydrate (a refused send, a running snapshot, a re-attach).
    let reconcileOnStop = cycle.afterClosedOr409;
    for (;;) {
      if (!owns()) return;
      const attemptController = new AbortController();
      const abortAttempt = () => attemptController.abort();
      controller.signal.addEventListener('abort', abortAttempt, { once: true });
      const attempt: AttachAttempt = { owns, abort: abortAttempt, topology, currentAssistantId: null };
      const seen: { snapshot: AiAttachState | null; messagesBefore: AiMessage[] | null; anchorMissing: boolean; rehydrateOnDone: boolean } = {
        snapshot: null, messagesBefore: null, anchorMissing: false, rehydrateOnDone: false,
      };

      const { finished } = attachAiSession(sessionId, {
        signal: attemptController.signal,
        filter,
        onEvent: (event) => {
          if (event.type !== 'attach_state') {
            applyAttachEvent(set, get, event, attempt);
            return;
          }
          if (owns() && !anchorRetried && attachAnchorMissing(event, get().messages)) {
            // Hydrated before this turn's user row was written: re-read, then
            // attach once more (Advisor findings 2 and 4).
            seen.anchorMissing = true;
            abortAttempt();
            return;
          }
          const messagesBefore = get().messages;
          if (!applyAttachEvent(set, get, event, attempt)) return;
          seen.messagesBefore = messagesBefore;
          seen.snapshot = event;
          // The reply on screen is not the full persisted turn: re-read on done.
          seen.rehydrateOnDone = event.turn === 'running'
            && (event.partial || event.turnUserMessageId === null || attachAnchorMissing(event, messagesBefore));
          settleReady('ready');
        },
      });
      let outcome: AttachOutcome;
      try {
        outcome = await finished;
      } finally {
        controller.signal.removeEventListener('abort', abortAttempt);
      }
      if (!owns()) return;

      if (seen.anchorMissing) {
        anchorRetried = true;
        await rehydrate();
        continue;
      }
      const applied = seen.snapshot;
      if (applied?.turn === 'running') reconcileOnStop = true;

      if (outcome.kind === 'done') {
        if (seen.rehydrateOnDone) await rehydrate();
        return;
      }
      if (outcome.kind === 'idle') {
        // Gate B #15: a turn ran on this instance (possibly finishing between
        // the hydrate and this attach) — re-read once.
        if (applied?.turnId != null || reconcileOnStop) await rehydrate();
        return;
      }
      if (outcome.kind === 'not_found') {
        settleReady('not_found');
        set({
          sessionId: null, sessionOrgId: null, messages: [], isLoading: false,
          isStreaming: false, joinedMidResponse: false, pendingApproval: null, pendingPlan: null, activePlan: null,
        });
        return;
      }
      if (shouldReattach(outcome, cycle)) {
        // The next snapshot replays the turn from scratch: un-apply this one.
        if (applied?.turn === 'running' && seen.messagesBefore) set({ messages: seen.messagesBefore });
        if (outcome.kind === 'closed') cycle.afterClosedOr409 = true;
        reconcileOnStop = true;
        await sleep(attachBackoffMs(cycle.attempt), controller.signal);
        cycle.attempt += 1;
        continue;
      }
      if (outcome.kind === 'error') console.warn('[AI] Attach failed:', outcome.message);
      if (reconcileOnStop) await rehydrate();
      if (owns()) set({ isStreaming: false, joinedMidResponse: false });
      return;
    }
  };

  const finished = run()
    .catch((err) => { console.error('[AI] Attach loop failed:', err); })
    .finally(() => {
      untrack();
      if (currentAttachController === controller) currentAttachController = null;
      settleReady('stopped');
    });
  return { ready, finished };
}

/**
 * #9427 W2: a send refused because another turn is running (Gate B #7). Drop
 * the refused bubble, put its text back in the composer, no error banner, and
 * attach to the running turn. #9428's retry will call this with neither
 * option: it keeps its original bubble and has no fresh text to restore.
 */
function attachAfterTurnInProgress(
  set: AiSet,
  get: AiGet,
  refused: { dropMessageId?: string; restoreDraft?: string },
): void {
  set((s) => ({
    messages: refused.dropMessageId ? s.messages.filter((m) => m.id !== refused.dropMessageId) : s.messages,
    isStreaming: false,
    ...(refused.restoreDraft !== undefined ? { composerDraft: refused.restoreDraft } : {}),
  }));
  void get().attachCurrent({ afterClosedOr409: true });
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
  joinedMidResponse: false,
  composerDraft: '',

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
        ? (resetModelPicker(), abortCurrentAttach(), { pageContext: ctx, ...CLEARED_SESSION })
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
    try {
      const orgId = pageContext?.type === 'device' || opts?.deviceId ? null : await readSelectedOrgId();
      const res = await fetchWithAuth('/ai/sessions', {
        method: 'POST',
        body: JSON.stringify({
          // #9529: with no device on the page, the session belongs to the org
          // selected in the header. A device page / device task lets the
          // server anchor to the device's org instead (#5593), and no
          // selection (All organizations) sends nothing.
          orgId: orgId ?? undefined,
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
        throw new Error(extractApiError(data, 'Failed to create session'));
      }
      const data = await res.json();
      if (!ownsSession()) return;
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
      // #9427: only chat sessions are reachable here; any other type (e.g. a
      // persisted script_builder id) is handled exactly like the 404 above.
      if (!isChatSessionType(data.session?.type)) {
        set({ sessionId: null, sessionOrgId: null, messages: [], isLoading: false });
        return;
      }
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
      });
      adoptSessionModelPicker(sessionId);
      // #9427: a successful, still-owned hydrate — join the turn if one runs.
      void get().attachCurrent();
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
    // This send supersedes any attach (#9427): stop its reader now.
    abortCurrentAttach();
    /** False once this stream has been superseded — by a rebind, or a newer send. */
    const ownsStream = () => activeStreamToken === streamToken && get().sessionId === currentSessionId;
    let heldReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

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

        const refusal = classifySendRefusal(res.status, code);

        if (refusal === 'attach') {
          // #9427 (Gate B #7): another turn is running on this conversation
          // (turn_in_progress, or an uncoded 409 from an older API). Join it;
          // the refused text goes back in the composer, no error banner. The
          // pick is kept for the next send (it was never committed).
          attachAfterTurnInProgress(set, get, { dropMessageId: userMsgId, restoreDraft: trimmedContent });
          return;
        }

        if (refusal === 'continuation') {
          // W05: the switch cannot resume. The message is parked for the
          // continuation prompt, not lost or errored.
          useAiModelPickerStore.getState().requireContinuation(data as AiContinuationRequired, trimmedContent, currentSessionId);
          set((s) => ({ messages: s.messages.filter((m) => m.id !== userMsgId), isStreaming: false }));
          return;
        }

        if (refusal === 'choose_model') {
          // The chosen / stored model is no longer usable: refresh the menu so
          // the tech can pick another (spec §9.1 "choose another"). The turn
          // was rejected before it ran: drop the optimistic bubble so the
          // transcript matches the server's.
          void useAiModelPickerStore.getState().load({ sessionId: currentSessionId });
          set((s) => ({
            messages: s.messages.filter((m) => m.id !== userMsgId),
            error: extractApiError(data, 'Failed to send message'),
            errorCode: code,
            isStreaming: false,
          }));
          return;
        }

        if (refusal === 'credits') {
          // The credit / plan gate refused the turn before it ran (#9450): drop
          // the optimistic bubble like the coded 409s and keep the code so the
          // chat can offer a way forward (Buy credits) instead of bare text.
          set((s) => ({
            messages: s.messages.filter((m) => m.id !== userMsgId),
            error: extractApiError(data, 'Failed to send message'),
            errorCode: code,
            isStreaming: false,
          }));
          return;
        }

        // refusal === 'error': the generic failure path (#9428 slots its
        // classifyHttpFailure in here).
        set({ errorCode: code });
        throw new Error(extractApiError(data, 'Failed to send message'));
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');
      heldReader = reader;
      currentSendReader = reader;

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
      if (heldReader && currentSendReader === heldReader) currentSendReader = null;
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
      // #9427: only chat sessions are reachable; any other type takes the same
      // path as a non-OK response (the current session stays bound).
      if (!isChatSessionType(data.session?.type)) throw new Error('Failed to load session');

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
      });
      adoptSessionModelPicker(sessionId);
      // #9427: a successful, still-owned hydrate — join the turn if one runs.
      void get().attachCurrent();
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

  setComposerDraft: (text: string) => set({ composerDraft: text }),

  attachCurrent: (opts) => startAttach(set, get, opts).finished,
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
