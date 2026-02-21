import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AiPageContext, AiStreamEvent, AiApprovalMode, ActionPlanStep, ActionPlan } from '@breeze/shared';
import { fetchWithAuth } from './auth';

interface AiMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  toolUseId?: string;
  isError?: boolean;
  isStreaming?: boolean;
  createdAt: Date;
}

interface DeviceContext {
  hostname: string;
  displayName?: string;
  status: string;
  lastSeenAt?: string;
  activeSessions?: Array<{ username: string; activityState?: string; idleMinutes?: number; sessionType: string }>;
}

interface PendingApproval {
  executionId: string;
  toolName: string;
  input: Record<string, unknown>;
  description: string;
  deviceContext?: DeviceContext;
}

interface SearchResult {
  id: string;
  title: string | null;
  matchedContent: string;
  createdAt: string;
}

interface PendingPlan {
  planId: string;
  steps: ActionPlanStep[];
}

interface ActivePlan {
  planId: string;
  steps: ActionPlanStep[];
  currentStepIndex: number;
  status: 'executing' | 'completed' | 'aborted';
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

function mapMessagesFromApi(rawMessages: Record<string, unknown>[]): AiMessage[] {
  return rawMessages.map((m) => ({
    id: m.id as string,
    role: m.role as AiMessage['role'],
    content: (m.content as string) ?? '',
    toolName: m.toolName as string | undefined,
    toolInput: m.toolInput as Record<string, unknown> | undefined,
    toolOutput: m.toolOutput,
    toolUseId: m.toolUseId as string | undefined,
    createdAt: new Date(m.createdAt as string)
  }));
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
          // Session gone — clear persisted ID so next message creates a fresh session
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

    // Client-side guard: prevent duplicate submits while a turn is in-flight.
    if (isStreaming || isLoading) return;

    // Create session if needed
    if (!sessionId) {
      await get().createSession();
    }

    const currentSessionId = get().sessionId;
    if (!currentSessionId) return;

    // Add user message
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

        // Conflict means the backend rejected this optimistic message.
        if (res.status === 409) {
          set((s) => ({
            messages: s.messages.filter((m) => m.id !== userMsgId),
            error: data.error || 'Another response is still in progress for this conversation.'
          }));
          return;
        }

        throw new Error(data.error || 'Failed to send message');
      }

      // Process SSE stream
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
      // Ensure isStreaming is always reset even if stream closes without 'done' event
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

function processStreamEvent(
  event: AiStreamEvent,
  set: (fn: (s: AiState) => Partial<AiState>) => void,
  get: () => AiState,
  currentAssistantId: string | null
): string | null {
  switch (event.type) {
    case 'message_start': {
      const msg: AiMessage = {
        id: event.messageId,
        role: 'assistant',
        content: '',
        isStreaming: true,
        createdAt: new Date()
      };
      set((s) => ({ messages: [...s.messages, msg] }));
      return event.messageId;
    }

    case 'content_delta': {
      if (currentAssistantId) {
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === currentAssistantId
              ? { ...m, content: m.content + event.delta }
              : m
          )
        }));
      }
      return currentAssistantId;
    }

    case 'tool_use_start': {
      const toolMsg: AiMessage = {
        id: `tool-${event.toolUseId}`,
        role: 'tool_use',
        content: '',
        toolName: event.toolName,
        toolInput: event.input && Object.keys(event.input).length > 0 ? event.input : undefined,
        toolUseId: event.toolUseId,
        createdAt: new Date()
      };
      set((s) => ({ messages: [...s.messages, toolMsg] }));
      return currentAssistantId;
    }

    case 'tool_result': {
      const resultMsg: AiMessage = {
        id: `result-${event.toolUseId}`,
        role: 'tool_result',
        content: typeof event.output === 'string' ? event.output : JSON.stringify(event.output, null, 2),
        toolOutput: event.output as Record<string, unknown>,
        toolUseId: event.toolUseId,
        isError: event.isError,
        createdAt: new Date()
      };
      set((s) => ({ messages: [...s.messages, resultMsg] }));
      return currentAssistantId;
    }

    case 'approval_required':
      set(() => ({
        pendingApproval: {
          executionId: event.executionId,
          toolName: event.toolName,
          input: event.input,
          description: event.description,
          deviceContext: event.deviceContext,
        }
      }));
      return currentAssistantId;

    case 'title_updated':
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === s.sessionId ? { ...sess, title: event.title } : sess
        )
      }));
      return currentAssistantId;

    case 'message_end': {
      if (currentAssistantId) {
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === currentAssistantId ? { ...m, isStreaming: false } : m
          )
        }));
      }
      return null;
    }

    case 'error':
      set(() => ({ error: event.message, isStreaming: false }));
      return currentAssistantId;

    case 'plan_approval_required':
      set(() => ({
        pendingPlan: {
          planId: (event as { planId: string }).planId,
          steps: (event as { steps: ActionPlanStep[] }).steps,
        },
      }));
      return currentAssistantId;

    case 'plan_step_start': {
      const e = event as { planId: string; stepIndex: number; toolName: string };
      set((s) => ({
        activePlan: s.activePlan ? { ...s.activePlan, currentStepIndex: e.stepIndex } : s.activePlan,
      }));
      return currentAssistantId;
    }

    case 'plan_step_complete': {
      const e = event as { planId: string; stepIndex: number; toolName: string; isError: boolean };
      set((s) => {
        if (!s.activePlan) return {};
        const steps = s.activePlan.steps.map((step, i) =>
          i === e.stepIndex ? { ...step, status: e.isError ? 'failed' as const : 'completed' as const } : step
        );
        return { activePlan: { ...s.activePlan, steps, currentStepIndex: e.stepIndex + 1 } };
      });
      return currentAssistantId;
    }

    case 'plan_complete': {
      const e = event as { planId: string; status: 'completed' | 'aborted' };
      set((s) => ({
        activePlan: s.activePlan ? { ...s.activePlan, status: e.status } : null,
      }));
      // Clear activePlan after a brief delay so UI can show final state
      setTimeout(() => {
        const state = get();
        if (state.activePlan?.status === 'completed' || state.activePlan?.status === 'aborted') {
          set(() => ({ activePlan: null }));
        }
      }, 3000);
      return currentAssistantId;
    }

    case 'plan_screenshot': {
      const e = event as { planId: string; stepIndex: number; imageBase64: string };
      // Insert inline screenshot as a special message
      const screenshotMsg: AiMessage = {
        id: `plan-screenshot-${e.planId}-${e.stepIndex}`,
        role: 'tool_result',
        content: '',
        toolName: 'plan_screenshot',
        toolOutput: { imageBase64: e.imageBase64, stepIndex: e.stepIndex },
        createdAt: new Date(),
      };
      set((s) => ({ messages: [...s.messages, screenshotMsg] }));
      return currentAssistantId;
    }

    case 'approval_mode_changed': {
      const e = event as { mode: AiApprovalMode };
      set(() => ({ approvalMode: e.mode, isPaused: e.mode === 'per_step' }));
      return currentAssistantId;
    }

    case 'done':
      set(() => ({ isStreaming: false }));
      return null;
  }

  return null;
}
