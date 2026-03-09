import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AiPageContext, AiStreamEvent, AiApprovalMode } from '@breeze/shared';
import { fetchWithAuth } from './auth';
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

  // Actions
  toggle: () => void;
  open: () => void;
  close: () => void;
  setPageContext: (ctx: AiPageContext | null) => void;
  createSession: () => Promise<void>;
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

  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  clearError: () => set({ error: null }),

  setPageContext: (ctx) => set({ pageContext: ctx }),

  createSession: async () => {
    set({ isLoading: true, error: null });
    try {
      const { pageContext } = get();
      const res = await fetchWithAuth('/ai/sessions', {
        method: 'POST',
        body: JSON.stringify({ pageContext: pageContext ?? undefined })
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create session');
      }
      const data = await res.json();
      set({ sessionId: data.id, messages: [], isLoading: false, isFlagged: false, flagReason: null });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to create session',
        isLoading: false
      });
    }
  },

  loadSession: async (sessionId: string) => {
    set({ isLoading: true, error: null });
    try {
      const res = await fetchWithAuth(`/ai/sessions/${sessionId}`);
      if (!res.ok) {
        if (res.status === 404) {
          set({ sessionId: null, messages: [], isLoading: false });
        } else {
          set({ error: 'Failed to load session', isLoading: false });
        }
        return;
      }
      const data = await res.json();
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
      });
    } catch (err) {
      set({
        sessionId: null,
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

    try {
      const { pageContext } = get();
      const res = await fetchWithAuth(`/ai/sessions/${currentSessionId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: trimmedContent, pageContext: pageContext ?? undefined })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to send message' }));

        if (res.status === 409) {
          set((s) => ({
            messages: s.messages.filter((m) => m.id !== userMsgId),
            error: data.error || 'Another response is still in progress for this conversation.'
          }));
          return;
        }

        throw new Error(data.error || 'Failed to send message');
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let currentAssistantId: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
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
      set({
        error: err instanceof Error ? err.message : 'Failed to send message',
        isStreaming: false
      });
    } finally {
      const state = get();
      if (state.isStreaming) {
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
        const data = await res.json().catch(() => ({ error: 'Unknown error' }));
        set({ error: data.error || 'Failed to process approval. It may have timed out.' });
        return;
      }
      set({ pendingApproval: null });
    } catch (err) {
      console.error('[AI] Approval failed:', err);
      set({ error: 'Failed to process approval' });
    }
  },

  approvePlan: async (approved: boolean) => {
    const { sessionId } = get();
    if (!sessionId) return;

    try {
      const res = await fetchWithAuth(`/ai/sessions/${sessionId}/approve-plan`, {
        method: 'POST',
        body: JSON.stringify({ approved })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Unknown error' }));
        set({ error: data.error || 'Failed to process plan approval' });
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
        const data = await res.json().catch(() => ({ error: 'Unknown error' }));
        set({ error: data.error || 'Failed to abort plan' });
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
        const data = await res.json().catch(() => ({ error: 'Unknown error' }));
        set({ error: data.error || 'Failed to pause AI' });
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
      set({ sessionId: null, messages: [] });
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
        const data = await res.json().catch(() => ({ error: 'Search failed' }));
        set({ isSearching: false, error: data.error || 'Search failed' });
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
        messages,
        isLoading: false,
        isFlagged: !!data.session?.flaggedAt,
        flagReason: data.session?.flagReason ?? null,
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
        const data = await res.json().catch(() => ({ error: 'Failed to flag session' }));
        set({ error: data.error || 'Failed to flag session' });
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
        const data = await res.json().catch(() => ({ error: 'Failed to unflag session' }));
        set({ error: data.error || 'Failed to unflag session' });
        return;
      }
      set({ isFlagged: false, flagReason: null });
    } catch (err) {
      console.error('Failed to unflag session:', err);
      set({ error: 'Failed to unflag session' });
    }
  },
    }),
    {
      name: 'breeze-ai-chat',
      partialize: (state) => ({
        sessionId: state.sessionId,
      }),
    }
  )
);
