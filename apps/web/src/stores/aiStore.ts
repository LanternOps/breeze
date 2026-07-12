import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AiPageContext, AiStreamEvent, AiApprovalMode } from '@breeze/shared';
import { fetchWithAuth } from './auth';
import {
  awaitForWebSession,
  captureWebSessionGeneration,
  isCurrentWebSessionGeneration,
  registerSessionTeardown,
} from './sessionTeardown';
import { extractApiError } from '@/lib/apiError';
import {
  processStreamEvent,
  mapMessagesFromApi,
  type AiMessage,
  type PendingApproval,
  type PendingPlan,
  type ActivePlan,
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

const activeAiReaders = new Set<ReadableStreamDefaultReader<Uint8Array>>();

interface AiState {
  isOpen: boolean;
  sessionId: string | null;
  messages: AiMessage[];
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
  createSession: (opts?: { deviceId?: string }) => Promise<void>;
  startDeviceTask: (deviceId: string, ctx: AiPageContext, initialMessage?: string) => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  loadSessions: () => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  approveExecution: (executionId: string, approved: boolean) => Promise<void>;
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

export const useAiStore = create<AiState>()(
  persist(
    (set, get) => ({
  isOpen: false,
  sessionId: null,
  messages: [],
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
      const generation = captureWebSessionGeneration();
      import('./helpStore').then(({ useHelpStore }) => {
        if (isCurrentWebSessionGeneration(generation)) useHelpStore.getState().close();
      }).catch((err) => console.warn('[AiStore] Failed to close help panel:', err));
    }
    set({ isOpen: opening });
  },
  open: () => {
    const generation = captureWebSessionGeneration();
    import('./helpStore').then(({ useHelpStore }) => {
      if (isCurrentWebSessionGeneration(generation)) useHelpStore.getState().close();
    }).catch((err) => console.warn('[AiStore] Failed to close help panel:', err));
    set({ isOpen: true });
  },
  close: () => set({ isOpen: false }),
  clearError: () => set({ error: null }),

  setPageContext: (ctx) => set({ pageContext: ctx }),

  createSession: async (opts) => {
    const generation = captureWebSessionGeneration();
    set({ isLoading: true, error: null });
    try {
      const { pageContext, selectedM365ConnectionId, approvalMode } = get();
      const res = await awaitForWebSession(generation, fetchWithAuth('/ai/sessions', {
        method: 'POST',
        body: JSON.stringify({
          pageContext: pageContext ?? undefined,
          delegantM365ConnectionId: selectedM365ConnectionId ?? undefined,
          deviceId: opts?.deviceId ?? undefined,
          approvalMode
        })
      }));
      if (!res.ok) {
        const data = await awaitForWebSession(generation, res.json().catch(() => null));
        throw new Error(extractApiError(data, 'Failed to create session'));
      }
      const data = await awaitForWebSession(generation, res.json());
      set({
        sessionId: data.id,
        messages: [],
        isLoading: false,
        isFlagged: false,
        flagReason: null,
        boundM365ConnectionId: data.delegantM365ConnectionId ?? null
      });
    } catch (err) {
      if (!isCurrentWebSessionGeneration(generation)) return;
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
    const generation = captureWebSessionGeneration();
    set({ pageContext: ctx, sessionId: null, messages: [], isFlagged: false, flagReason: null, isOpen: true });
    await get().createSession({ deviceId });
    if (!isCurrentWebSessionGeneration(generation)) return;
    // Only send if the session was actually created — createSession leaves
    // sessionId null and sets `error` on failure; sending then would be session-less.
    if (initialMessage && initialMessage.trim() && get().sessionId) {
      await get().sendMessage(initialMessage);
    }
  },

  loadSession: async (sessionId: string) => {
    const generation = captureWebSessionGeneration();
    set({ isLoading: true, error: null });
    try {
      const res = await awaitForWebSession(generation, fetchWithAuth(`/ai/sessions/${sessionId}`));
      if (!res.ok) {
        if (res.status === 404) {
          set({ sessionId: null, messages: [], isLoading: false });
        } else {
          set({ error: 'Failed to load session', isLoading: false });
        }
        return;
      }
      const data = await awaitForWebSession(generation, res.json());
      if (data.session?.status !== 'active') {
        set({ sessionId: null, messages: [], isLoading: false });
        return;
      }

      const messages = mapMessagesFromApi(data.messages || []);

      set({
        sessionId,
        messages,
        isLoading: false,
        isFlagged: !!data.session.flaggedAt,
        flagReason: data.session.flagReason ?? null,
        boundM365ConnectionId: data.session.delegantM365ConnectionId ?? null,
      });
    } catch (err) {
      if (!isCurrentWebSessionGeneration(generation)) return;
      set({
        sessionId: null,
        messages: [],
        error: err instanceof Error ? err.message : 'Failed to load session',
        isLoading: false
      });
    }
  },

  loadSessions: async () => {
    const generation = captureWebSessionGeneration();
    try {
      const res = await awaitForWebSession(generation, fetchWithAuth('/ai/sessions?status=active'));
      if (!res.ok) {
        console.error('[AI] Failed to load sessions: HTTP', res.status);
        return;
      }
      const data = await awaitForWebSession(generation, res.json());
      set({ sessions: data.data || [] });
    } catch (err) {
      if (!isCurrentWebSessionGeneration(generation)) return;
      console.error('[AI] Failed to load sessions:', err);
    }
  },

  sendMessage: async (content: string) => {
    const generation = captureWebSessionGeneration();
    const trimmedContent = content.trim();
    if (!trimmedContent) return;

    const { sessionId, isStreaming, isLoading } = get();

    if (isStreaming || isLoading) return;

    if (!sessionId) {
      await get().createSession();
      if (!isCurrentWebSessionGeneration(generation)) return;
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

    let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const { pageContext } = get();
      const res = await awaitForWebSession(generation, fetchWithAuth(`/ai/sessions/${currentSessionId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: trimmedContent, pageContext: pageContext ?? undefined })
      }));

      if (!res.ok) {
        const data = await awaitForWebSession(generation, res.json().catch(() => null));

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
      activeReader = reader;
      activeAiReaders.add(reader);

      const decoder = new TextDecoder();
      let buffer = '';
      let currentAssistantId: string | null = null;

      while (true) {
        const { done, value } = await awaitForWebSession(generation, reader.read());
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data:')) {
            const jsonStr = line.slice(5).trim();
            if (!jsonStr) continue;

            try {
              const event = JSON.parse(jsonStr) as AiStreamEvent;
              currentAssistantId = processStreamEvent(event, set, get, currentAssistantId);
            } catch (parseErr) {
              console.error('[AI] Failed to parse SSE event:', jsonStr.slice(0, 200), parseErr);
            }
          }
        }
      }
    } catch (err) {
      if (!isCurrentWebSessionGeneration(generation)) return;
      set({
        error: err instanceof Error ? err.message : 'Failed to send message',
        isStreaming: false
      });
    } finally {
      if (activeReader) activeAiReaders.delete(activeReader);
      if (!isCurrentWebSessionGeneration(generation)) return;
      const state = get();
      if (state.isStreaming) {
        set({ isStreaming: false });
      }
    }
  },

  approveExecution: async (executionId: string, approved: boolean) => {
    const generation = captureWebSessionGeneration();
    const { sessionId } = get();
    if (!sessionId) return;

    try {
      const res = await awaitForWebSession(generation, fetchWithAuth(`/ai/sessions/${sessionId}/approve/${executionId}`, {
        method: 'POST',
        body: JSON.stringify({ approved })
      }));
      if (!res.ok) {
        const data = await awaitForWebSession(generation, res.json().catch(() => null));
        set({ error: extractApiError(data, 'Failed to process approval. It may have timed out.') });
        return;
      }
      set({ pendingApproval: null });
    } catch (err) {
      if (!isCurrentWebSessionGeneration(generation)) return;
      console.error('[AI] Approval failed:', err);
      set({ error: 'Failed to process approval' });
    }
  },

  approvePlan: async (approved: boolean) => {
    const generation = captureWebSessionGeneration();
    const { sessionId } = get();
    if (!sessionId) return;

    try {
      const res = await awaitForWebSession(generation, fetchWithAuth(`/ai/sessions/${sessionId}/approve-plan`, {
        method: 'POST',
        body: JSON.stringify({ approved })
      }));
      if (!res.ok) {
        const data = await awaitForWebSession(generation, res.json().catch(() => null));
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
      if (!isCurrentWebSessionGeneration(generation)) return;
      console.error('[AI] Plan approval failed:', err);
      set({ error: 'Failed to process plan approval' });
    }
  },

  abortPlan: async () => {
    const generation = captureWebSessionGeneration();
    const { sessionId } = get();
    if (!sessionId) return;

    try {
      const res = await awaitForWebSession(generation, fetchWithAuth(`/ai/sessions/${sessionId}/abort-plan`, {
        method: 'POST'
      }));
      if (!res.ok) {
        const data = await awaitForWebSession(generation, res.json().catch(() => null));
        set({ error: extractApiError(data, 'Failed to abort plan') });
        return;
      }
      set({ activePlan: null });
    } catch (err) {
      if (!isCurrentWebSessionGeneration(generation)) return;
      console.error('[AI] Plan abort failed:', err);
      set({ error: 'Failed to abort plan' });
    }
  },

  pauseAi: async (paused: boolean) => {
    const generation = captureWebSessionGeneration();
    const { sessionId } = get();
    if (!sessionId) return;

    try {
      const res = await awaitForWebSession(generation, fetchWithAuth(`/ai/sessions/${sessionId}/pause`, {
        method: 'POST',
        body: JSON.stringify({ paused })
      }));
      if (!res.ok) {
        const data = await awaitForWebSession(generation, res.json().catch(() => null));
        set({ error: extractApiError(data, 'Failed to pause AI') });
        return;
      }
      set({ isPaused: paused });
    } catch (err) {
      if (!isCurrentWebSessionGeneration(generation)) return;
      console.error('[AI] Pause failed:', err);
      set({ error: 'Failed to pause AI' });
    }
  },

  closeSession: async () => {
    const generation = captureWebSessionGeneration();
    const { sessionId } = get();
    if (!sessionId) return;

    try {
      const res = await awaitForWebSession(generation, fetchWithAuth(`/ai/sessions/${sessionId}`, { method: 'DELETE' }));
      if (!res.ok) {
        set({ error: 'Failed to close session' });
        return;
      }
      set({ sessionId: null, messages: [], boundM365ConnectionId: null });
    } catch (err) {
      if (!isCurrentWebSessionGeneration(generation)) return;
      console.error('[AI] Failed to close session:', err);
      set({ error: 'Failed to close session' });
    }
  },

  toggleHistory: () => set((s) => ({ showHistory: !s.showHistory, searchResults: [] })),

  interruptResponse: async () => {
    const generation = captureWebSessionGeneration();
    const { sessionId } = get();
    if (!sessionId) return;

    set({ isInterrupting: true });
    try {
      const res = await awaitForWebSession(generation, fetchWithAuth(`/ai/sessions/${sessionId}/interrupt`, { method: 'POST' }));
      const data = await awaitForWebSession(generation, res.json().catch(() => ({})));
      if (!res.ok || data.interrupted === false) {
        set({ error: data.reason || 'Could not interrupt the response' });
      }
    } catch (err) {
      if (!isCurrentWebSessionGeneration(generation)) return;
      console.error('[AI] Interrupt failed:', err);
      set({ error: 'Failed to interrupt the response' });
    } finally {
      if (!isCurrentWebSessionGeneration(generation)) return;
      set({ isInterrupting: false });
    }
  },

  searchConversations: async (query: string) => {
    const generation = captureWebSessionGeneration();
    if (query.length < 2) {
      set({ searchResults: [], isSearching: false });
      return;
    }
    set({ isSearching: true });
    try {
      const res = await awaitForWebSession(generation, fetchWithAuth(`/ai/sessions/search?q=${encodeURIComponent(query)}&limit=20`));
      if (res.ok) {
        const data = await awaitForWebSession(generation, res.json());
        set({ searchResults: data.data || [], isSearching: false });
      } else {
        const data = await awaitForWebSession(generation, res.json().catch(() => null));
        set({ isSearching: false, error: extractApiError(data, 'Search failed') });
      }
    } catch (err) {
      if (!isCurrentWebSessionGeneration(generation)) return;
      console.error('[AI] Search failed:', err);
      set({ isSearching: false, error: 'Search failed' });
    }
  },

  switchSession: async (sessionId: string) => {
    const generation = captureWebSessionGeneration();
    set({ showHistory: false, isLoading: true, error: null });
    try {
      const res = await awaitForWebSession(generation, fetchWithAuth(`/ai/sessions/${sessionId}`));
      if (!res.ok) throw new Error('Failed to load session');
      const data = await awaitForWebSession(generation, res.json());

      const messages = mapMessagesFromApi(data.messages || []);

      set({
        sessionId,
        messages,
        isLoading: false,
        isFlagged: !!data.session?.flaggedAt,
        flagReason: data.session?.flagReason ?? null,
        boundM365ConnectionId: data.session?.delegantM365ConnectionId ?? null,
      });
    } catch (err) {
      if (!isCurrentWebSessionGeneration(generation)) return;
      set({
        error: err instanceof Error ? err.message : 'Failed to load session',
        isLoading: false
      });
    }
  },

  flagSession: async (reason?: string) => {
    const generation = captureWebSessionGeneration();
    const { sessionId } = get();
    if (!sessionId) return;
    try {
      const res = await awaitForWebSession(generation, fetchWithAuth(`/ai/sessions/${sessionId}/flag`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }));
      if (!res.ok) {
        const data = await awaitForWebSession(generation, res.json().catch(() => null));
        set({ error: extractApiError(data, 'Failed to flag session') });
        return;
      }
      set({ isFlagged: true, flagReason: reason ?? null });
    } catch (err) {
      if (!isCurrentWebSessionGeneration(generation)) return;
      console.error('Failed to flag session:', err);
      set({ error: 'Failed to flag session' });
    }
  },

  unflagSession: async () => {
    const generation = captureWebSessionGeneration();
    const { sessionId } = get();
    if (!sessionId) return;
    try {
      const res = await awaitForWebSession(generation, fetchWithAuth(`/ai/sessions/${sessionId}/flag`, { method: 'DELETE' }));
      if (!res.ok) {
        const data = await awaitForWebSession(generation, res.json().catch(() => null));
        set({ error: extractApiError(data, 'Failed to unflag session') });
        return;
      }
      set({ isFlagged: false, flagReason: null });
    } catch (err) {
      if (!isCurrentWebSessionGeneration(generation)) return;
      console.error('Failed to unflag session:', err);
      set({ error: 'Failed to unflag session' });
    }
  },

  loadM365Connections: async () => {
    const generation = captureWebSessionGeneration();
    try {
      const res = await awaitForWebSession(generation, fetchWithAuth('/ai/m365-connections'));
      if (!res.ok) {
        console.error('[AI] Failed to load M365 connections: HTTP', res.status);
        return;
      }
      const data = await awaitForWebSession(generation, res.json());
      set({ m365Connections: data.data || [] });
    } catch (err) {
      if (!isCurrentWebSessionGeneration(generation)) return;
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
      }),
    }
  )
);

registerSessionTeardown(() => {
  let cancelFailureReported = false;
  const reportCancelFailure = (error: unknown) => {
    if (cancelFailureReported) return;
    cancelFailureReported = true;
    console.warn('[AI] Failed to cancel an active response during session teardown:', error);
  };
  for (const reader of activeAiReaders) {
    try {
      void Promise.resolve(reader.cancel()).catch(reportCancelFailure);
    } catch (error) {
      reportCancelFailure(error);
    }
  }
  activeAiReaders.clear();
  useAiStore.setState({
    isOpen: false,
    sessionId: null,
    messages: [],
    isStreaming: false,
    isLoading: false,
    error: null,
    pageContext: null,
    pendingApproval: null,
    pendingPlan: null,
    activePlan: null,
    approvalMode: 'per_step',
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
  });
});
