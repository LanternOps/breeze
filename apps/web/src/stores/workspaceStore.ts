import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AiAttachState, AiPageContext, AiStreamEvent, AiApprovalMode, AiTicketDraft, CreateTicketFromChatInput } from '@breeze/shared';
import { fetchWithAuth } from './auth';
import { openAiSession, type AiSessionView } from './aiSessionOpen';
import { attachAiSession, attachBackoffMs, shouldReattach, trackAttach, type AttachOutcome } from './aiSessionAttach';
import { classifySendRefusal } from './aiSendRefusal';
import { registerLogoutHook } from './logoutHooks';
import { extractApiError } from '@/lib/apiError';
import { runAction } from '@/lib/runAction';
import { i18n } from '@/lib/i18n';
import { findActiveWispGrant, WISP_GRANT_UNUSABLE, wispSessionOrgId, type WispGrantLookup } from '@/lib/wispSession';
import { showToast } from '../components/shared/Toast';
import {
  processStreamEvent,
  mapMessagesFromApi,
  attachAnchorMissing,
  type AiMessage,
  type PendingApproval,
  type PendingPlan,
  type ActivePlan,
  type ChatRunState,
} from './processStreamEvent';

export const MAX_TABS = 5;

export interface TabState {
  id: string;
  sessionId: string | null;
  title: string;
  /**
   * True once the user has explicitly renamed this tab (vs. the "New Chat"
   * placeholder or a server auto-generated title). Gates two things: whether
   * a `title_updated` SSE event from the backend's first-message auto-title
   * is allowed to overwrite it, and whether the title is sent along when the
   * session is first created so it survives past that auto-title step.
   */
  isTitleCustom: boolean;
  contextLabel: string | null;
  pageContext: AiPageContext | null;
  messages: AiMessage[];
  /** Analysis runs launched from this tab's conversation, keyed by run id (W05). */
  chatRuns: Record<string, ChatRunState>;
  isStreaming: boolean;
  isLoading: boolean;
  error: string | null;
  pendingApproval: PendingApproval | null;
  pendingPlan: PendingPlan | null;
  activePlan: ActivePlan | null;
  approvalMode: AiApprovalMode;
  isPaused: boolean;
  isInterrupting: boolean;
  isFlagged: boolean;
  unreadCount: number;
  hasApprovalPending: boolean;
  /** #9427 W3 (chips): the session's org, from GET /ai/sessions/:id. Null for a tab that created its own session. */
  orgId: string | null;
  deviceId: string | null;
  /** Hostname from the rebuilt device page context, for the device chip. */
  deviceLabel: string | null;
  m365ConnectionId: string | null;
  /** The composer text, held here so a move carries it (not persisted). */
  composerDraft: string;
  /** Attached to a running turn whose replay was too large; cleared when the turn ends or the attach stops. */
  joinedMidResponse: boolean;
  /** A refusal the workspace cannot resolve itself: the banner offers the side panel. */
  errorAction: 'continue_in_panel' | null;
  /**
   * #10142: whether this tab's conversation runs (or, before its first
   * message, will be created) under a Wisp grant. Absent = not known yet (the
   * grant lookup is in flight, or a restored tab has not been checked). An
   * opened session reports its own grant, which is immutable for it.
   */
  wisp?: TabWisp;
}

/** `orgId` is the org a new session under the grant is created in (focus, else the grant's org). */
export type TabWisp = { kind: 'plain' } | { kind: 'wisp'; grantId: string; orgId: string | null };

/** Shown when a send needs a model choice or a continuation the workspace has no UI for. */
export const CHOOSE_MODEL_IN_PANEL = 'Continue in side panel to choose a model';

export type OpenSessionResult = 'focused' | 'opened' | 'tab_cap' | 'not_found' | 'closed' | 'topology' | 'error';

function contextLabelOf(context: AiPageContext | null): string | null {
  if (!context) return null;
  return context.type === 'device' ? context.hostname
    : context.type === 'alert' ? context.title
    : context.type === 'dashboard' ? (context.orgName ?? 'Dashboard')
    : context.type === 'custom' ? context.label
    : null;
}

/** Chip fields and flags a tab takes from a hydrated session. */
function sessionFieldsOf(view: AiSessionView): Partial<TabState> {
  return {
    orgId: view.orgId || null,
    deviceId: view.deviceId,
    deviceLabel: view.pageContext?.type === 'device' ? view.pageContext.hostname : null,
    m365ConnectionId: view.m365ConnectionId,
    isFlagged: view.isFlagged,
    wisp: view.wispGrantId ? { kind: 'wisp', grantId: view.wispGrantId, orgId: view.orgId || null } : { kind: 'plain' },
  };
}

/**
 * The org selected in the header, or null for none (All organizations).
 * orgStore is read lazily, as aiStore does, so this store does not pull the
 * org/auth graph in at import time.
 */
async function readSelectedOrgId(): Promise<string | null> {
  const { useOrgStore } = await import('./orgStore');
  return useOrgStore.getState().currentOrgId ?? null;
}

/**
 * #9427 W3: bumped by resetForLogout. Every async action captures it; a
 * continuation whose captured generation is stale writes nothing, so a late
 * send/open/attach cannot re-persist the previous user's tabs (Codex finding 1).
 */
let workspaceGeneration = 0;

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

type TabAttachReady = 'ready' | 'not_found' | 'stopped';

/** Per-attempt bookkeeping of one tab attach (one GET …/stream). */
interface TabAttachAttempt {
  owns: () => boolean;
  abort: () => void;
  currentAssistantId: string | null;
}

function createEmptyTab(title?: string): TabState {
  return {
    id: crypto.randomUUID(),
    sessionId: null,
    title: title ?? 'New Chat',
    isTitleCustom: false,
    contextLabel: null,
    pageContext: null,
    messages: [],
    chatRuns: {},
    isStreaming: false,
    isLoading: false,
    error: null,
    pendingApproval: null,
    pendingPlan: null,
    activePlan: null,
    approvalMode: 'per_step',
    isPaused: false,
    isInterrupting: false,
    isFlagged: false,
    unreadCount: 0,
    hasApprovalPending: false,
    orgId: null,
    deviceId: null,
    deviceLabel: null,
    m365ConnectionId: null,
    composerDraft: '',
    joinedMidResponse: false,
    errorAction: null,
  };
}

interface WorkspaceState {
  tabs: TabState[];
  activeTabId: string | null;
  _readers: Map<string, ReadableStreamDefaultReader<Uint8Array>>;
  /** #9427 W3: one live attach loop per tab, keyed by tab id. */
  _attachControllers: Map<string, AbortController>;

  // Tab lifecycle
  createTab: (title?: string, context?: AiPageContext) => void;
  /**
   * #9427 W3: open an existing conversation. An existing tab is focused (no
   * fetch); a full tab bar is `tab_cap` (no fetch, never an eviction); topology
   * never opens here. `'opened'` resolves once the new tab's attach is ready.
   * An aborted `signal` (a dead hand-off) commits no tab.
   */
  openSession: (sessionId: string, opts?: { draft?: string; signal?: AbortSignal }) => Promise<OpenSessionResult | 'aborted'>;
  setComposerDraft: (tabId: string, text: string) => void;
  /** #9427 W3 (T14): logout — stop every reader and attach, drop all tabs, stale every in-flight action. */
  resetForLogout: () => void;
  closeTab: (tabId: string) => void;
  switchTab: (tabId: string) => void;
  /**
   * Renames a tab. Updates local state immediately; if the tab already has a
   * backing session, persists the rename via PATCH /ai/sessions/:id and rolls
   * the local title back if that call fails. A tab with no session yet stays
   * local-only — the title is sent along when the session is created (see
   * sendMessage) so it isn't lost.
   */
  renameTab: (tabId: string, title: string) => Promise<void>;

  // Chat actions (tab-scoped)
  sendMessage: (tabId: string, content: string) => Promise<void>;
  approveExecution: (tabId: string, executionId: string, approved: boolean) => Promise<void>;
  /**
   * An inline intent decide (Touch ID self-approve) already POSTed to the
   * approvals decide API and the SSE stream carries the actual outcome —
   * this only drops the now-stale card. Never call it as a substitute for
   * approveExecution: it talks to no endpoint.
   */
  clearPendingApproval: (tabId: string) => void;
  approvePlan: (tabId: string, approved: boolean) => Promise<void>;
  abortPlan: (tabId: string) => Promise<void>;
  pauseAi: (tabId: string, paused: boolean) => Promise<void>;
  interruptResponse: (tabId: string) => Promise<void>;
  flagSession: (tabId: string, reason?: string) => Promise<void>;
  draftTicketFromChat: (tabId: string) => Promise<AiTicketDraft>;
  saveTicketFromChat: (tabId: string, payload: CreateTicketFromChatInput) => Promise<{ ticketNumber: string; resolved: boolean; timeLogged: boolean; timeLogError?: string }>;
  unflagSession: (tabId: string) => Promise<void>;
  clearError: (tabId: string) => void;

  // Notifications
  markTabRead: (tabId: string) => void;

  // Lifecycle
  restoreWorkspace: () => Promise<void>;
  cleanupAllStreams: () => void;
}

type PersistedWorkspace = {
  tabs: Array<{ id: string; sessionId: string | null; title: string; isTitleCustom: boolean; contextLabel: string | null; pageContext: AiPageContext | null }>;
  activeTabId: string | null;
};

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => {
      const getTab = (tabId: string) => get().tabs.find((t) => t.id === tabId);

      // A write for a tab that no longer exists (closed, or every tab dropped
      // at logout) is skipped outright: even an empty set() would make the
      // persist middleware write `breeze-workspace` again.
      const updateTab = (tabId: string, patch: Partial<TabState>) => {
        if (!getTab(tabId)) return;
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)),
        }));
      };

      /** Tab-scoped setter/getter handed to processStreamEvent. */
      const tabSetFor = (tabId: string) => (fn: (s: TabState) => Partial<TabState>) => {
        if (!getTab(tabId)) return;
        set((state) => ({
          tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, ...fn(t) } : t)),
        }));
      };
      const tabGetFor = (tabId: string) => (): TabState => getTab(tabId) ?? createEmptyTab();

      /** #10142: one grant lookup per sessionless tab; a send waits on it. */
      const wispLookups = new Map<string, Promise<WispGrantLookup['kind'] | 'skipped'>>();
      /** The header org each tab's last answered lookup was for, so a send after a header switch looks again. */
      const wispLookupOrg = new Map<string, string | null>();
      /**
       * Decide whether this tab's first session is a Wisp one: the caller's
       * active grant for the header org (the side panel's anchor), else plain.
       * No usable answer leaves the mode unknown, so the send looks again
       * rather than creating a plain session for good. A tab that already has
       * a session keeps that session's grant.
       */
      const resolveTabWisp = (tabId: string): Promise<WispGrantLookup['kind'] | 'skipped'> => {
        const pending = wispLookups.get(tabId);
        if (pending) return pending;
        const gen = workspaceGeneration;
        const lookup = (async (): Promise<WispGrantLookup['kind'] | 'skipped'> => {
          const orgId = await readSelectedOrgId().catch(() => null);
          const result = await findActiveWispGrant(orgId);
          const tab = getTab(tabId);
          if (gen !== workspaceGeneration || !tab || tab.sessionId) return 'skipped';
          if (result.kind === 'unknown') {
            wispLookupOrg.delete(tabId);
            updateTab(tabId, { wisp: undefined });
          } else {
            wispLookupOrg.set(tabId, orgId);
            updateTab(tabId, {
              wisp: result.kind === 'grant'
                ? { kind: 'wisp', grantId: result.grant.grantId, orgId: wispSessionOrgId(result.grant) }
                : { kind: 'plain' },
            });
          }
          return result.kind;
        })().finally(() => {
          if (wispLookups.get(tabId) === lookup) wispLookups.delete(tabId);
        });
        wispLookups.set(tabId, lookup);
        return lookup;
      };

      /**
       * Before a sessionless tab's first create: wait for an in-flight lookup,
       * look again when the mode is unknown or the header org changed since
       * the lookup answered (the side panel anchors at send time too). Still
       * no answer: the session is created plain and the user is told.
       */
      const settleTabWispForSend = async (tabId: string): Promise<void> => {
        const pending = wispLookups.get(tabId);
        if (pending) await pending;
        let tab = getTab(tabId);
        if (!tab || tab.sessionId) return;
        if (tab.wisp && wispLookupOrg.has(tabId)) {
          const orgId = await readSelectedOrgId().catch(() => null);
          if (wispLookupOrg.get(tabId) !== orgId) updateTab(tabId, { wisp: undefined });
        }
        tab = getTab(tabId);
        if (!tab || tab.wisp) return;
        if ((await resolveTabWisp(tabId)) === 'unknown') {
          showToast({ type: 'warning', message: i18n.t('ai:wisp.toast.grantCheckFailed') });
        }
      };

      /**
       * One stream event (send or attach) applied to one tab: background-tab
       * notification bookkeeping, the title rule, then processStreamEvent.
       */
      const applyTabStreamEvent = (tabId: string, event: AiStreamEvent, currentAssistantId: string | null): string | null => {
        const isBackground = get().activeTabId !== tabId;
        if (isBackground) {
          if (event.type === 'message_start') {
            const t = getTab(tabId);
            if (t) updateTab(tabId, { unreadCount: t.unreadCount + 1 });
          }
          if (event.type === 'approval_required' || event.type === 'plan_approval_required') {
            updateTab(tabId, { hasApprovalPending: true });
          }
          if (event.type === 'attach_state' && event.pendingCards.length > 0) {
            updateTab(tabId, { hasApprovalPending: true });
          }
        }

        // Update title from title_updated events — but never stomp on a title
        // the user explicitly set (guards a race where the rename lands after
        // the auto-title generation already started server-side).
        if (event.type === 'title_updated') {
          const currentTab = getTab(tabId);
          if (!currentTab?.isTitleCustom) {
            updateTab(tabId, { title: event.title });
          }
        }

        return processStreamEvent(
          event,
          tabSetFor(tabId) as (fn: (s: any) => Partial<any>) => void,
          tabGetFor(tabId) as () => any,
          currentAssistantId,
        );
      };

      /**
       * #9427 W3: the one place attach-delivered events reach a tab (the seam
       * #9429's notifications will hook). A superseded attach stops its reader
       * and writes nothing.
       */
      const applyTabAttachEvent = (tabId: string, event: AiStreamEvent, attempt: TabAttachAttempt): boolean => {
        if (!attempt.owns()) {
          attempt.abort();
          return false;
        }
        attempt.currentAssistantId = applyTabStreamEvent(tabId, event, attempt.currentAssistantId);
        return true;
      };

      const abortTabAttach = (tabId: string) => {
        const controllers = get()._attachControllers;
        const controller = controllers.get(tabId);
        if (!controller) return;
        controllers.delete(tabId);
        controller.abort();
      };

      /**
       * #9427 W3 (spec §3.5, the T9 rules per tab): attach a tab's session and
       * keep the turn applied until it ends. Owned while the workspace
       * generation is unchanged, the tab still holds the same session, and this
       * controller is still the tab's — closeTab, cleanupAllStreams,
       * resetForLogout and a newer attach for the tab each end it
       * synchronously. Re-attach per W1's shouldReattach/attachBackoffMs (Gate
       * B #6); on any other stop (not `done`/`idle`): one messages re-read if anything may
       * have changed, `isStreaming:false`, `joinedMidResponse:false`, no
       * banner. `not_found` unbinds the tab like restore's 404 path.
       */
      const startTabAttach = (
        tabId: string,
        opts: { afterClosedOr409?: boolean } = {},
      ): { ready: Promise<TabAttachReady>; finished: Promise<void> } => {
        const sessionId = getTab(tabId)?.sessionId;
        if (!sessionId) {
          const stopped = Promise.resolve<TabAttachReady>('stopped');
          return { ready: stopped, finished: stopped.then(() => undefined) };
        }
        const gen = workspaceGeneration;
        abortTabAttach(tabId);
        const controller = new AbortController();
        get()._attachControllers.set(tabId, controller);
        const untrack = trackAttach(controller);

        const owns = () =>
          !controller.signal.aborted
          && gen === workspaceGeneration
          && get()._attachControllers.get(tabId) === controller
          && getTab(tabId)?.sessionId === sessionId;

        let settleReady!: (r: TabAttachReady) => void;
        const ready = new Promise<TabAttachReady>((resolve) => { settleReady = resolve; });

        /** One owner-guarded messages re-read (reconciliation). */
        const rehydrate = async (): Promise<void> => {
          try {
            const res = await fetchWithAuth(`/ai/sessions/${sessionId}`);
            if (!owns()) return;
            if (!res.ok) {
              console.warn('[Workspace] Attach re-hydrate failed: HTTP', res.status);
              return;
            }
            const data = await res.json();
            if (!owns()) return;
            updateTab(tabId, { messages: mapMessagesFromApi(data.messages || []) });
          } catch (err) {
            console.warn('[Workspace] Attach re-hydrate failed:', err);
          }
        };

        const run = async (): Promise<void> => {
          const cycle = { attempt: 0, afterClosedOr409: !!opts.afterClosedOr409 };
          let anchorRetried = false;
          // Whether a stop re-reads messages: something may have changed since
          // the hydrate (a refused send, a running snapshot, a re-attach).
          let reconcileOnStop = cycle.afterClosedOr409;
          for (;;) {
            if (!owns()) return;
            const attemptController = new AbortController();
            const abortAttempt = () => attemptController.abort();
            controller.signal.addEventListener('abort', abortAttempt, { once: true });
            const attempt: TabAttachAttempt = { owns, abort: abortAttempt, currentAssistantId: null };
            const seen: { snapshot: AiAttachState | null; messagesBefore: AiMessage[] | null; anchorMissing: boolean; rehydrateOnDone: boolean } = {
              snapshot: null, messagesBefore: null, anchorMissing: false, rehydrateOnDone: false,
            };

            const { finished } = attachAiSession(sessionId, {
              signal: attemptController.signal,
              onEvent: (event) => {
                if (event.type !== 'attach_state') {
                  applyTabAttachEvent(tabId, event, attempt);
                  return;
                }
                const messagesBefore = getTab(tabId)?.messages ?? [];
                if (owns() && !anchorRetried && attachAnchorMissing(event, messagesBefore)) {
                  // Hydrated before this turn's user row was written: re-read,
                  // then attach once more (Advisor findings 2 and 4).
                  seen.anchorMissing = true;
                  abortAttempt();
                  return;
                }
                if (!applyTabAttachEvent(tabId, event, attempt)) return;
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
              // Gate B #15: a turn ran on this instance — re-read once.
              if (applied?.turnId != null || reconcileOnStop) await rehydrate();
              return;
            }
            if (outcome.kind === 'not_found') {
              settleReady('not_found');
              updateTab(tabId, {
                sessionId: null, messages: [], isLoading: false, isStreaming: false, joinedMidResponse: false,
                pendingApproval: null, pendingPlan: null, activePlan: null, wisp: undefined,
              });
              // The next conversation in this tab is a new session: find out
              // again whether it runs under a grant (#10142).
              void resolveTabWisp(tabId);
              return;
            }
            if (shouldReattach(outcome, cycle)) {
              // The next snapshot replays the turn from scratch: un-apply this one.
              if (applied?.turn === 'running' && seen.messagesBefore) updateTab(tabId, { messages: seen.messagesBefore });
              if (outcome.kind === 'closed') cycle.afterClosedOr409 = true;
              reconcileOnStop = true;
              await sleep(attachBackoffMs(cycle.attempt), controller.signal);
              cycle.attempt += 1;
              continue;
            }
            if (outcome.kind === 'error') console.warn('[Workspace] Attach failed:', outcome.message);
            if (reconcileOnStop) await rehydrate();
            if (owns()) updateTab(tabId, { isStreaming: false, joinedMidResponse: false });
            return;
          }
        };

        const finished = run()
          .catch((err) => {
            console.error('[Workspace] Attach loop failed:', err);
            if (owns()) updateTab(tabId, { isStreaming: false, joinedMidResponse: false });
          })
          .finally(() => {
            untrack();
            const controllers = get()._attachControllers;
            if (controllers.get(tabId) === controller) controllers.delete(tabId);
            settleReady('stopped');
          });
        return { ready, finished };
      };

      return {
        tabs: [],
        activeTabId: null,
        _readers: new Map(),
        _attachControllers: new Map(),

        createTab: (title?: string, context?: AiPageContext) => {
          const { tabs } = get();
          if (tabs.length >= MAX_TABS) return;
          const tab = createEmptyTab(title);
          if (context) {
            tab.pageContext = context;
            tab.contextLabel = contextLabelOf(context);
          }
          set((s) => ({
            tabs: [...s.tabs, tab],
            activeTabId: tab.id,
          }));
          void resolveTabWisp(tab.id);
        },

        openSession: async (sessionId, opts = {}) => {
          const { signal, draft } = opts;
          if (signal?.aborted) return 'aborted';
          const focusExisting = (): boolean => {
            const existing = get().tabs.find((t) => t.sessionId === sessionId);
            if (!existing) return false;
            get().switchTab(existing.id);
            // A handed-over draft is not dropped because the tab was already open.
            if (draft) {
              updateTab(existing.id, {
                composerDraft: existing.composerDraft ? `${existing.composerDraft}\n${draft}` : draft,
              });
            }
            return true;
          };
          if (focusExisting()) return 'focused';
          // A full tab bar is a toast, never an eviction (D5) — and no request.
          if (get().tabs.length >= MAX_TABS) return 'tab_cap';

          const gen = workspaceGeneration;
          const result = await openAiSession(sessionId);
          if (gen !== workspaceGeneration || signal?.aborted) return 'aborted';
          if (result.kind !== 'ok') return result.kind;
          // Topology investigations live in the side panel only (D4).
          if (result.view.type === 'topology') return 'topology';
          if (focusExisting()) return 'focused';
          if (get().tabs.length >= MAX_TABS) return 'tab_cap';

          const { view } = result;
          const tab: TabState = {
            ...createEmptyTab(view.title ?? undefined),
            sessionId,
            pageContext: view.pageContext,
            contextLabel: contextLabelOf(view.pageContext),
            messages: result.messages,
            composerDraft: draft ?? '',
            ...sessionFieldsOf(view),
          };
          set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));

          // Resolve on the attach's ready (attach_state), never on the turn's end.
          const { ready } = startTabAttach(tab.id);
          const outcome = await (signal
            ? Promise.race([ready, new Promise<'signal'>((resolve) => {
              signal.addEventListener('abort', () => resolve('signal'), { once: true });
            })])
            : ready);
          if (gen !== workspaceGeneration || !getTab(tab.id)) return 'aborted';
          // The hand-off died while this tab was being prepared: the origin
          // keeps the session, so withdraw the tab rather than mirror it (D3).
          if (outcome === 'signal' || signal?.aborted) {
            get().closeTab(tab.id);
            return 'aborted';
          }
          if (outcome === 'not_found') {
            get().closeTab(tab.id);
            return 'not_found';
          }
          return 'opened';
        },

        setComposerDraft: (tabId: string, text: string) => {
          updateTab(tabId, { composerDraft: text });
        },

        closeTab: (tabId: string) => {
          const { _readers, tabs, activeTabId } = get();
          const tab = tabs.find((t) => t.id === tabId);
          if (!tab) return;

          // Stop this tab's attach now: its later events must write nothing.
          abortTabAttach(tabId);

          // Cancel any active stream
          const reader = _readers.get(tab.sessionId ?? '');
          if (reader) {
            reader.cancel().catch(() => {});
            _readers.delete(tab.sessionId ?? '');
          }

          const remaining = tabs.filter((t) => t.id !== tabId);
          let newActiveId: string | null = null;
          if (remaining.length > 0) {
            if (activeTabId === tabId) {
              const idx = tabs.findIndex((t) => t.id === tabId);
              newActiveId = remaining[Math.min(idx, remaining.length - 1)]?.id ?? null;
            } else {
              newActiveId = activeTabId;
            }
          }

          set({ tabs: remaining, activeTabId: newActiveId });
        },

        switchTab: (tabId: string) => {
          set({ activeTabId: tabId });
          // Clear unread when switching to tab
          updateTab(tabId, { unreadCount: 0, hasApprovalPending: false });
        },

        renameTab: async (tabId: string, title: string) => {
          const trimmed = title.trim();
          if (!trimmed) return;

          const tab = getTab(tabId);
          if (!tab) return;
          if (trimmed === tab.title && tab.isTitleCustom) return;

          const previousTitle = tab.title;
          const previousIsTitleCustom = tab.isTitleCustom;
          updateTab(tabId, { title: trimmed, isTitleCustom: true });

          if (!tab.sessionId) return;

          // Only roll back if THIS call's title is still the tab's current
          // title. Two renames can be in flight at once (fire-and-forget from
          // the UI, no in-flight guard) and their PATCH responses can arrive
          // out of order — without this check, an older call's failure could
          // stomp a newer, already-successful rename.
          const rollbackIfStillCurrent = (patch: Partial<TabState>) => {
            if (getTab(tabId)?.title === trimmed) {
              updateTab(tabId, { title: previousTitle, isTitleCustom: previousIsTitleCustom, ...patch });
            }
          };

          try {
            const res = await fetchWithAuth(`/ai/sessions/${tab.sessionId}`, {
              method: 'PATCH',
              body: JSON.stringify({ title: trimmed }),
            });
            if (!res.ok) {
              const data = await res.json().catch(() => null);
              rollbackIfStillCurrent({ error: extractApiError(data, 'Failed to rename chat') });
            }
          } catch (err) {
            console.error('[Workspace] Rename failed:', err);
            rollbackIfStillCurrent({ error: 'Failed to rename chat' });
          }
        },

        sendMessage: async (tabId: string, content: string) => {
          const trimmed = content.trim();
          if (!trimmed) return;

          const tab = getTab(tabId);
          if (!tab || tab.isStreaming || tab.isLoading) return;

          // #9427 W3: a logout during any await below makes every later write
          // a no-op (including the finally) — nothing re-persists old tabs.
          const gen = workspaceGeneration;
          const stale = () => gen !== workspaceGeneration;
          // This send supersedes the tab's attach (an idle one still closing).
          abortTabAttach(tabId);

          // Create session lazily if needed
          let sessionId = tab.sessionId;
          if (!sessionId) {
            updateTab(tabId, { isLoading: true, error: null });
            // #10142: the session is created under the tab's Wisp grant, so a
            // send that beats the lookup waits for it (or runs it, for a
            // restored tab never checked).
            // (No await when nothing is pending or unknown: the create stays on this tick.)
            if (wispLookups.has(tabId) || !getTab(tabId)?.wisp || wispLookupOrg.has(tabId)) {
              await settleTabWispForSend(tabId);
            }
            // Logged out, or the tab was closed meanwhile: create nothing.
            if (stale() || !getTab(tabId)) return;
            const tabWisp = getTab(tabId)?.wisp;
            const wisp = tabWisp?.kind === 'wisp' ? tabWisp : null;
            // Snapshot the title sent with session creation. renameTab() is a
            // no-op against the API while sessionId is still null (there's no
            // session yet to PATCH), so a rename that lands *during* this
            // await would otherwise be silently dropped — the tab shows the
            // new title locally, but the backend record it's about to create
            // never carries it, and nothing ever revisits it. Compare against
            // the tab's title once a sessionId exists below and PATCH if it
            // has since diverged.
            const titleAtCreation = tab.isTitleCustom ? tab.title : undefined;
            try {
              const res = await fetchWithAuth('/ai/sessions', {
                method: 'POST',
                body: JSON.stringify({
                  // The side panel's Wisp create: the grant, its anchor org
                  // and the tab's approval mode. A plain tab sends none of it.
                  ...(wisp
                    ? { orgId: wisp.orgId ?? undefined, wispGrantId: wisp.grantId, approvalMode: tab.approvalMode }
                    : {}),
                  pageContext: tab.pageContext ?? undefined,
                  // Carry a user-set title through to the new session so the
                  // server's first-message auto-title (gated on `!title`)
                  // never clobbers a rename made before the first message.
                  title: titleAtCreation,
                }),
              });
              if (stale()) return;
              if (!res.ok) {
                const data = await res.json().catch(() => null);
                // A grant that can no longer carry a session (revoked,
                // expired, Wisp turned off), or a thread focus that moved
                // (409 focus_mismatch): drop the tab's Wisp mode and look
                // again, so the next send is not refused the same way. The
                // error banner keeps the server's reason.
                const code = typeof data?.code === 'string' ? data.code : null;
                if (wisp && code && (WISP_GRANT_UNUSABLE.has(code) || code === 'focus_mismatch')) {
                  updateTab(tabId, { wisp: undefined });
                  void resolveTabWisp(tabId);
                }
                throw new Error(extractApiError(data, 'Failed to create session'));
              }
              const data = await res.json();
              if (stale()) return;
              sessionId = data.id;
              // A session created without a grant is a plain chat for good.
              updateTab(tabId, { sessionId, isLoading: false, ...(wisp ? {} : { wisp: { kind: 'plain' } }) });

              const latestTab = getTab(tabId);
              if (latestTab?.isTitleCustom && latestTab.title !== titleAtCreation) {
                fetchWithAuth(`/ai/sessions/${sessionId}`, {
                  method: 'PATCH',
                  body: JSON.stringify({ title: latestTab.title }),
                }).catch((err) => console.error('[Workspace] Failed to sync title after session creation:', err));
              }
            } catch (err) {
              if (stale()) return;
              updateTab(tabId, {
                error: err instanceof Error ? err.message : 'Failed to create session',
                isLoading: false,
              });
              return;
            }
          }

          if (!sessionId) return;

          const userMsgId = crypto.randomUUID();
          const userMsg: AiMessage = {
            id: userMsgId,
            role: 'user',
            content: trimmed,
            createdAt: new Date(),
          };

          updateTab(tabId, {
            messages: [...(getTab(tabId)?.messages ?? []), userMsg],
            isStreaming: true,
            error: null,
            errorAction: null,
            pendingApproval: null,
          });

          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
          // Set when a refusal hands the tab to an attach: the finally must not
          // touch isStreaming then (the attach owns it).
          let handedToAttach = false;
          try {
            const currentTab = getTab(tabId);
            const res = await fetchWithAuth(`/ai/sessions/${sessionId}/messages`, {
              method: 'POST',
              body: JSON.stringify({ content: trimmed, pageContext: currentTab?.pageContext ?? undefined }),
            });
            if (stale()) return;

            if (!res.ok) {
              const data = await res.json().catch(() => null);
              if (stale()) return;
              const code = data && typeof data === 'object' && typeof (data as { code?: unknown }).code === 'string'
                ? (data as { code: string }).code : null;
              const refusal = classifySendRefusal(res.status, code);
              const dropBubble = (patch: Partial<TabState>) => {
                if (!getTab(tabId)) return;
                set((s) => ({
                  tabs: s.tabs.map((t) =>
                    t.id === tabId ? { ...t, messages: t.messages.filter((m) => m.id !== userMsgId), ...patch } : t
                  ),
                }));
              };

              if (refusal === 'attach') {
                // #9427 (Gate B #7): another turn is running on this
                // conversation (turn_in_progress, or an uncoded 409 from an
                // older API). Join it; the refused text goes back in the
                // composer, no error banner.
                if (!getTab(tabId)) return;
                dropBubble({ isStreaming: false, composerDraft: trimmed, error: null, errorAction: null });
                handedToAttach = true;
                void startTabAttach(tabId, { afterClosedOr409: true }).finished;
                return;
              }
              if (refusal === 'continuation' || refusal === 'choose_model') {
                // The workspace has no model picker or continuation prompt:
                // the banner offers the side panel, which has both.
                dropBubble({ isStreaming: false, error: CHOOSE_MODEL_IN_PANEL, errorAction: 'continue_in_panel' });
                return;
              }
              // Any other refusal (e.g. 503 ai_not_configured) came before the
              // turn ran, so the server never stored the message: drop the
              // bubble and give the text back to the composer (#10108).
              dropBubble({
                isStreaming: false,
                composerDraft: trimmed,
                error: extractApiError(data, 'Failed to send message'),
              });
              return;
            }

            reader = res.body?.getReader();
            if (!reader) throw new Error('No response body');

            // Store reader for interrupt/cleanup
            get()._readers.set(sessionId, reader);

            const decoder = new TextDecoder();
            let buffer = '';
            let currentAssistantId: string | null = null;

            while (true) {
              const { done, value } = await reader.read();
              if (done || stale()) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() ?? '';

              for (const line of lines) {
                if (line.startsWith('data:')) {
                  const jsonStr = line.slice(5).trim();
                  if (!jsonStr) continue;

                  try {
                    const event = JSON.parse(jsonStr) as AiStreamEvent;
                    currentAssistantId = applyTabStreamEvent(tabId, event, currentAssistantId);
                  } catch (parseErr) {
                    console.error('[Workspace] Failed to parse SSE event:', jsonStr.slice(0, 200), parseErr);
                  }
                }
              }
            }
          } catch (err) {
            if (stale()) return;
            updateTab(tabId, {
              error: err instanceof Error ? err.message : 'Failed to send message',
              isStreaming: false,
            });
          } finally {
            // A stale send (logout since it started) writes nothing at all,
            // so the persist middleware has nothing to write back.
            if (!stale()) {
              const t = getTab(tabId);
              if (t?.isStreaming && !handedToAttach) {
                updateTab(tabId, { isStreaming: false });
              }
              const readers = get()._readers;
              if (reader && readers.get(sessionId) === reader) readers.delete(sessionId);
            }
          }
        },

        approveExecution: async (tabId: string, executionId: string, approved: boolean) => {
          const tab = getTab(tabId);
          if (!tab?.sessionId) return;

          try {
            const res = await fetchWithAuth(`/ai/sessions/${tab.sessionId}/approve/${executionId}`, {
              method: 'POST',
              body: JSON.stringify({ approved }),
            });
            if (!res.ok) {
              const data = await res.json().catch(() => null);
              updateTab(tabId, { error: extractApiError(data, 'Failed to process approval. It may have timed out.') });
              return;
            }
            updateTab(tabId, { pendingApproval: null, hasApprovalPending: false });
          } catch (err) {
            console.error('[Workspace] Approval failed:', err);
            updateTab(tabId, { error: 'Failed to process approval' });
          }
        },

        clearPendingApproval: (tabId: string) => {
          updateTab(tabId, { pendingApproval: null, hasApprovalPending: false });
        },

        approvePlan: async (tabId: string, approved: boolean) => {
          const tab = getTab(tabId);
          if (!tab?.sessionId) return;

          try {
            const res = await fetchWithAuth(`/ai/sessions/${tab.sessionId}/approve-plan`, {
              method: 'POST',
              body: JSON.stringify({ approved }),
            });
            if (!res.ok) {
              const data = await res.json().catch(() => null);
              updateTab(tabId, { error: extractApiError(data, 'Failed to process plan approval') });
              return;
            }
            if (approved && tab.pendingPlan) {
              updateTab(tabId, {
                pendingPlan: null,
                hasApprovalPending: false,
                activePlan: {
                  planId: tab.pendingPlan.planId,
                  steps: tab.pendingPlan.steps,
                  currentStepIndex: 0,
                  status: 'executing',
                },
              });
            } else {
              updateTab(tabId, { pendingPlan: null, hasApprovalPending: false });
            }
          } catch (err) {
            console.error('[Workspace] Plan approval failed:', err);
            updateTab(tabId, { error: 'Failed to process plan approval' });
          }
        },

        abortPlan: async (tabId: string) => {
          const tab = getTab(tabId);
          if (!tab?.sessionId) return;

          try {
            const res = await fetchWithAuth(`/ai/sessions/${tab.sessionId}/abort-plan`, {
              method: 'POST',
            });
            if (!res.ok) {
              const data = await res.json().catch(() => null);
              updateTab(tabId, { error: extractApiError(data, 'Failed to abort plan') });
              return;
            }
            updateTab(tabId, { activePlan: null });
          } catch (err) {
            console.error('[Workspace] Plan abort failed:', err);
            updateTab(tabId, { error: 'Failed to abort plan' });
          }
        },

        pauseAi: async (tabId: string, paused: boolean) => {
          const tab = getTab(tabId);
          if (!tab?.sessionId) return;

          try {
            const res = await fetchWithAuth(`/ai/sessions/${tab.sessionId}/pause`, {
              method: 'POST',
              body: JSON.stringify({ paused }),
            });
            if (!res.ok) {
              const data = await res.json().catch(() => null);
              updateTab(tabId, { error: extractApiError(data, 'Failed to pause AI') });
              return;
            }
            updateTab(tabId, { isPaused: paused });
          } catch (err) {
            console.error('[Workspace] Pause failed:', err);
            updateTab(tabId, { error: 'Failed to pause AI' });
          }
        },

        interruptResponse: async (tabId: string) => {
          const tab = getTab(tabId);
          if (!tab?.sessionId) return;

          updateTab(tabId, { isInterrupting: true });
          try {
            const res = await fetchWithAuth(`/ai/sessions/${tab.sessionId}/interrupt`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.interrupted === false) {
              updateTab(tabId, { error: data.reason || 'Could not interrupt the response' });
            }
          } catch (err) {
            console.error('[Workspace] Interrupt failed:', err);
            updateTab(tabId, { error: 'Failed to interrupt the response' });
          } finally {
            updateTab(tabId, { isInterrupting: false });
          }
        },

        flagSession: async (tabId: string, reason?: string) => {
          const tab = getTab(tabId);
          if (!tab?.sessionId) return;

          try {
            const res = await fetchWithAuth(`/ai/sessions/${tab.sessionId}/flag`, {
              method: 'POST',
              body: JSON.stringify({ reason }),
            });
            if (!res.ok) {
              const data = await res.json().catch(() => null);
              updateTab(tabId, { error: extractApiError(data, 'Failed to flag session') });
              return;
            }
            updateTab(tabId, { isFlagged: true });
          } catch (err) {
            console.error('[Workspace] Flag failed:', err);
            updateTab(tabId, { error: 'Failed to flag session' });
          }
        },

        draftTicketFromChat: async (tabId) => {
          const tab = getTab(tabId);
          if (!tab?.sessionId) throw new Error('No active session');
          const res = await fetchWithAuth(`/ai/sessions/${tab.sessionId}/ticket-draft`, { method: 'POST' });
          if (!res.ok) {
            const data = await res.json().catch(() => null);
            throw new Error(extractApiError(data, 'Could not draft a ticket from this conversation'));
          }
          const body = await res.json();
          return body.data as AiTicketDraft;
        },

        saveTicketFromChat: async (tabId, payload) => {
          const tab = getTab(tabId);
          if (!tab?.sessionId) throw new Error('No active session');
          const sessionId = tab.sessionId;
          const requestedResolve = payload.status === 'resolved';
          const requestedTime = payload.timeMinutes > 0;
          const result = await runAction<{ ticketNumber: string; resolved: boolean; timeLogged: boolean; timeLogError?: string }>({
            request: () => fetchWithAuth(`/ai/sessions/${sessionId}/ticket`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            }),
            errorFallback: 'Could not create the ticket.',
            parseSuccess: (data) => {
              const d = data as { data?: { internalNumber?: string | null; ticketNumber?: string }; resolved?: boolean; timeLogged?: boolean; timeLogError?: string };
              return {
                ticketNumber: d.data?.internalNumber ?? d.data?.ticketNumber ?? '',
                resolved: !!d.resolved,
                timeLogged: !!d.timeLogged,
                ...(d.timeLogError ? { timeLogError: d.timeLogError } : {}),
              };
            },
            successMessage: (r) => `Ticket ${r.ticketNumber} created${r.resolved ? ' and resolved' : ''}`,
          });
          // Partial-success warnings: only when the user asked for something that didn't happen.
          if (requestedResolve && !result.resolved) {
            showToast({ type: 'warning', message: 'Ticket created, but it could not be resolved automatically — please resolve it manually.' });
          }
          if (requestedTime && !result.timeLogged) {
            showToast({ type: 'warning', message: `Ticket created, but the time entry could not be logged.${result.timeLogError ? ` ${result.timeLogError}` : ''}` });
          }
          return result;
        },

        unflagSession: async (tabId: string) => {
          const tab = getTab(tabId);
          if (!tab?.sessionId) return;

          try {
            const res = await fetchWithAuth(`/ai/sessions/${tab.sessionId}/flag`, { method: 'DELETE' });
            if (!res.ok) {
              const data = await res.json().catch(() => null);
              updateTab(tabId, { error: extractApiError(data, 'Failed to unflag session') });
              return;
            }
            updateTab(tabId, { isFlagged: false });
          } catch (err) {
            console.error('[Workspace] Unflag failed:', err);
            updateTab(tabId, { error: 'Failed to unflag session' });
          }
        },

        clearError: (tabId: string) => {
          updateTab(tabId, { error: null });
        },

        markTabRead: (tabId: string) => {
          updateTab(tabId, { unreadCount: 0, hasApprovalPending: false });
        },

        restoreWorkspace: async () => {
          const gen = workspaceGeneration;
          // #10142: a restored tab with no conversation yet learns whether
          // its first one is a Wisp session (`wisp` is not persisted).
          for (const t of get().tabs) if (!t.sessionId) void resolveTabWisp(t.id);
          const tabsWithSessions = get().tabs.filter((t) => t.sessionId);
          if (tabsWithSessions.length === 0) return;

          // #9427 W3: hydrate through openAiSession, then attach each tab, so
          // returning to /workspace re-joins a turn that is still running.
          // Never moves activeTabId (a deep link may be opening one).
          await Promise.all(
            tabsWithSessions.map(async (tab) => {
              const sessionId = tab.sessionId;
              if (!sessionId) return;
              const result = await openAiSession(sessionId);
              if (gen !== workspaceGeneration || getTab(tab.id)?.sessionId !== sessionId) return;
              if (result.kind === 'error') {
                console.error(`[Workspace] Failed to restore tab ${tab.id}:`, result.message);
                return;
              }
              // Gone, closed, not a chat type, or a topology investigation
              // (side panel only, D4): the tab keeps its slot, not the session.
              if (result.kind !== 'ok' || result.view.type === 'topology') {
                updateTab(tab.id, { sessionId: null, messages: [], wisp: undefined });
                void resolveTabWisp(tab.id);
                return;
              }
              updateTab(tab.id, { messages: result.messages, ...sessionFieldsOf(result.view) });
              await startTabAttach(tab.id).ready;
            })
          );
        },

        cleanupAllStreams: () => {
          const { _readers, _attachControllers } = get();
          for (const reader of _readers.values()) {
            reader.cancel().catch(() => {});
          }
          _readers.clear();
          const controllers = [..._attachControllers.values()];
          _attachControllers.clear();
          for (const controller of controllers) controller.abort();
        },

        resetForLogout: () => {
          // Stale every in-flight send/open/attach first, then stop the
          // streams, then drop the tabs (the persist write this makes is
          // removed by evictLocalAuthState right after its hooks run).
          workspaceGeneration += 1;
          get().cleanupAllStreams();
          wispLookups.clear();
          wispLookupOrg.clear();
          set({ tabs: [], activeTabId: null });
        },
      };
    },
    {
      name: 'breeze-workspace',
      partialize: (state): PersistedWorkspace => ({
        tabs: state.tabs.map((t) => ({
          id: t.id,
          sessionId: t.sessionId,
          title: t.title,
          isTitleCustom: t.isTitleCustom,
          contextLabel: t.contextLabel,
          pageContext: t.pageContext,
        })),
        activeTabId: state.activeTabId,
      }),
      merge: (persisted, current) => {
        const data = persisted as PersistedWorkspace | undefined;
        if (!data?.tabs) return current;
        return {
          ...current,
          activeTabId: data.activeTabId,
          tabs: data.tabs.map((t) => ({
            ...createEmptyTab(t.title),
            id: t.id,
            sessionId: t.sessionId,
            isTitleCustom: t.isTitleCustom ?? false,
            contextLabel: t.contextLabel,
            pageContext: t.pageContext,
          })),
        };
      },
    }
  )
);

// #9427 W3 (T14): logout drops every tab and stales every in-flight action
// before evictLocalAuthState removes breeze-workspace.
registerLogoutHook(() => useWorkspaceStore.getState().resetForLogout());
