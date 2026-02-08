import { create } from 'zustand';
import type { AiPageContext, AiStreamEvent } from '@breeze/shared';
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

interface PendingApproval {
  executionId: string;
  toolName: string;
  input: Record<string, unknown>;
  description: string;
}

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
  sessions: Array<{ id: string; title: string | null; status: string; createdAt: string }>;
  showHistory: boolean;
  searchResults: SearchResult[];
  isSearching: boolean;

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
  closeSession: () => Promise<void>;
  clearError: () => void;
  toggleHistory: () => void;
  searchConversations: (query: string) => Promise<void>;
  switchSession: (sessionId: string) => Promise<void>;
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

export const useAiStore = create<AiState>()((set, get) => ({
  isOpen: false,
  sessionId: null,
  messages: [],
  isStreaming: false,
  isLoading: false,
  error: null,
  pageContext: null,
  pendingApproval: null,
  sessions: [],
  showHistory: false,
  searchResults: [],
  isSearching: false,

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
      set({ sessionId: data.id, messages: [], isLoading: false });
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
      if (!res.ok) throw new Error('Failed to load session');
      const data = await res.json();

      const messages = mapMessagesFromApi(data.messages || []);

      set({ sessionId, messages, isLoading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to load session',
        isLoading: false
      });
    }
  },

  loadSessions: async () => {
    try {
      const res = await fetchWithAuth('/ai/sessions?status=active');
      if (!res.ok) return;
      const data = await res.json();
      set({ sessions: data.data || [] });
    } catch (err) {
      console.error('[AI] Failed to load sessions:', err);
    }
  },

  sendMessage: async (content: string) => {
    const { sessionId } = get();

    // Create session if needed
    if (!sessionId) {
      await get().createSession();
    }

    const currentSessionId = get().sessionId;
    if (!currentSessionId) return;

    // Add user message
    const userMsg: AiMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
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
        body: JSON.stringify({ content, pageContext: pageContext ?? undefined })
      });

      if (!res.ok) {
        const data = await res.json();
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
      set({ isSearching: false });
    }
  },

  switchSession: async (sessionId: string) => {
    set({ showHistory: false, isLoading: true, error: null });
    try {
      const res = await fetchWithAuth(`/ai/sessions/${sessionId}`);
      if (!res.ok) throw new Error('Failed to load session');
      const data = await res.json();

      const messages = mapMessagesFromApi(data.messages || []);

      set({ sessionId, messages, isLoading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to load session',
        isLoading: false
      });
    }
  }
}));

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
        toolInput: event.input,
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
          description: event.description
        }
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

    case 'done':
      set(() => ({ isStreaming: false }));
      return null;
  }

  return null;
}
