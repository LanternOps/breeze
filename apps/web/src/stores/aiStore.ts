import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AiPageContext, AiStreamEvent, AiApprovalMode } from '@breeze/shared';
import { fetchWithAuth } from './auth';
import { extractApiError } from '@/lib/apiError';
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
  createSession: (opts?: { deviceId?: string; pageContext?: AiPageContext }) => Promise<void>;
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
} as const;

/**
 * Identifies the stream `sendMessage` currently owns. A rebind (or any later
 * send) supersedes an in-flight one: the superseded reader must stop appending
 * into the store, or another tenant's assistant output lands in the new chat
 * (#5684).
 */
let activeStreamToken = 0;

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
  clearError: () => set({ error: null }),

  setPageContext: (ctx) =>
    set((s) =>
      pageContextOrgMismatch(ctx, s.sessionOrgId)
        ? { pageContext: ctx, ...CLEARED_SESSION }
        : { pageContext: ctx },
    ),

  createSession: async (opts) => {
    set({ isLoading: true, error: null });
    try {
      const { pageContext: storeContext, selectedM365ConnectionId, approvalMode } = get();
      const pageContext = opts?.pageContext ?? storeContext;
      const topology = pageContext?.type === 'topology';
      const res = await fetchWithAuth('/ai/sessions', {
        method: 'POST',
        body: JSON.stringify({
          pageContext: pageContext ?? undefined,
          delegantM365ConnectionId: topology ? undefined : selectedM365ConnectionId ?? undefined,
          deviceId: topology ? undefined : opts?.deviceId ?? undefined,
          approvalMode
        })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(extractApiError(data, 'Failed to create session'));
      }
      const data = await res.json();
      set({
        sessionId: data.id,
        sessionOrgId: data.orgId ?? null,
        hydratedSessionId: data.id,
        messages: [],
        isLoading: false,
        isFlagged: false,
        flagReason: null,
        boundM365ConnectionId: data.delegantM365ConnectionId ?? null
      });
    } catch (err) {
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
    set({ pageContext: ctx, sessionId: null, sessionOrgId: null, messages: [], isFlagged: false, flagReason: null, isOpen: true });
    await get().createSession({ deviceId });
    // Only send if the session was actually created — createSession leaves
    // sessionId null and sets `error` on failure; sending then would be session-less.
    if (initialMessage && initialMessage.trim() && get().sessionId) {
      await get().sendMessage(initialMessage);
    }
  },

  loadSession: async (sessionId: string) => {
    set({ isLoading: true, error: null });
    try {
      const res = await fetchWithAuth(`/ai/sessions/${sessionId}`);
      if (!res.ok) {
        if (res.status === 404) {
          set({ sessionId: null, sessionOrgId: null, messages: [], isLoading: false });
        } else {
          set({ error: 'Failed to load session', isLoading: false });
        }
        return;
      }
      const data = await res.json();
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
      });
    } catch (err) {
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

    if (!sessionId) {
      await get().createSession();
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
      pendingApproval: null
    }));

    const streamToken = ++activeStreamToken;
    /** False once this stream has been superseded — by a rebind, or a newer send. */
    const ownsStream = () => activeStreamToken === streamToken && get().sessionId === currentSessionId;

    try {
      const { pageContext } = get();
      const res = await fetchWithAuth(`/ai/sessions/${currentSessionId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: trimmedContent, pageContext: pageContext ?? undefined })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);

        if (res.status === 409) {
          set((s) => ({
            messages: s.messages.filter((m) => m.id !== userMsgId),
            error: extractApiError(data, 'Another response is still in progress for this conversation.')
          }));
          return;
        }

        throw new Error(extractApiError(data, 'Failed to send message'));
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let currentAssistantId: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
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
              currentAssistantId = processStreamEvent(event, set, get, currentAssistantId);
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

    try {
      const res = await fetchWithAuth(`/ai/sessions/${sessionId}`, { method: 'DELETE' });
      if (!res.ok) {
        set({ error: 'Failed to close session' });
        return;
      }
      set({ sessionId: null, sessionOrgId: null, messages: [], boundM365ConnectionId: null });
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
    set({ showHistory: false, isLoading: true, error: null });
    try {
      const res = await fetchWithAuth(`/ai/sessions/${sessionId}`);
      if (!res.ok) throw new Error('Failed to load session');
      const data = await res.json();

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
      });
    } catch (err) {
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
