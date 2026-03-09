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

const MAX_TABS = 5;

export interface TabState {
  id: string;
  sessionId: string | null;
  title: string;
  contextLabel: string | null;
  pageContext: AiPageContext | null;
  messages: AiMessage[];
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
}

function createEmptyTab(title?: string): TabState {
  return {
    id: crypto.randomUUID(),
    sessionId: null,
    title: title ?? 'New Chat',
    contextLabel: null,
    pageContext: null,
    messages: [],
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
  };
}

interface WorkspaceState {
  tabs: TabState[];
  activeTabId: string | null;
  _readers: Map<string, ReadableStreamDefaultReader<Uint8Array>>;

  // Tab lifecycle
  createTab: (title?: string, context?: AiPageContext) => void;
  closeTab: (tabId: string) => void;
  switchTab: (tabId: string) => void;
  renameTab: (tabId: string, title: string) => void;

  // Chat actions (tab-scoped)
  sendMessage: (tabId: string, content: string) => Promise<void>;
  approveExecution: (tabId: string, executionId: string, approved: boolean) => Promise<void>;
  approvePlan: (tabId: string, approved: boolean) => Promise<void>;
  abortPlan: (tabId: string) => Promise<void>;
  pauseAi: (tabId: string, paused: boolean) => Promise<void>;
  interruptResponse: (tabId: string) => Promise<void>;
  flagSession: (tabId: string, reason?: string) => Promise<void>;
  unflagSession: (tabId: string) => Promise<void>;
  clearError: (tabId: string) => void;

  // Notifications
  markTabRead: (tabId: string) => void;

  // Lifecycle
  restoreWorkspace: () => Promise<void>;
  cleanupAllStreams: () => void;
}

type PersistedWorkspace = {
  tabs: Array<{ id: string; sessionId: string | null; title: string; contextLabel: string | null; pageContext: AiPageContext | null }>;
  activeTabId: string | null;
};

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => {
      const updateTab = (tabId: string, patch: Partial<TabState>) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)),
        }));

      const getTab = (tabId: string) => get().tabs.find((t) => t.id === tabId);

      return {
        tabs: [],
        activeTabId: null,
        _readers: new Map(),

        createTab: (title?: string, context?: AiPageContext) => {
          const { tabs } = get();
          if (tabs.length >= MAX_TABS) return;
          const tab = createEmptyTab(title);
          if (context) {
            tab.pageContext = context;
            tab.contextLabel = context.type === 'device' ? context.hostname
              : context.type === 'alert' ? context.title
              : context.type === 'dashboard' ? (context.orgName ?? 'Dashboard')
              : context.type === 'custom' ? context.label
              : null;
          }
          set((s) => ({
            tabs: [...s.tabs, tab],
            activeTabId: tab.id,
          }));
        },

        closeTab: (tabId: string) => {
          const { _readers, tabs, activeTabId } = get();
          const tab = tabs.find((t) => t.id === tabId);
          if (!tab) return;

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

        renameTab: (tabId: string, title: string) => {
          updateTab(tabId, { title });
        },

        sendMessage: async (tabId: string, content: string) => {
          const trimmed = content.trim();
          if (!trimmed) return;

          const tab = getTab(tabId);
          if (!tab || tab.isStreaming || tab.isLoading) return;

          // Create session lazily if needed
          let sessionId = tab.sessionId;
          if (!sessionId) {
            updateTab(tabId, { isLoading: true, error: null });
            try {
              const res = await fetchWithAuth('/ai/sessions', {
                method: 'POST',
                body: JSON.stringify({ pageContext: tab.pageContext ?? undefined }),
              });
              if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'Failed to create session');
              }
              const data = await res.json();
              sessionId = data.id;
              updateTab(tabId, { sessionId, isLoading: false });
            } catch (err) {
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
            pendingApproval: null,
          });

          try {
            const currentTab = getTab(tabId);
            const res = await fetchWithAuth(`/ai/sessions/${sessionId}/messages`, {
              method: 'POST',
              body: JSON.stringify({ content: trimmed, pageContext: currentTab?.pageContext ?? undefined }),
            });

            if (!res.ok) {
              const data = await res.json().catch(() => ({ error: 'Failed to send message' }));
              if (res.status === 409) {
                set((s) => ({
                  tabs: s.tabs.map((t) =>
                    t.id === tabId
                      ? { ...t, messages: t.messages.filter((m) => m.id !== userMsgId), error: data.error || 'Another response is still in progress.' }
                      : t
                  ),
                }));
                return;
              }
              throw new Error(data.error || 'Failed to send message');
            }

            const reader = res.body?.getReader();
            if (!reader) throw new Error('No response body');

            // Store reader for interrupt/cleanup
            get()._readers.set(sessionId, reader);

            const decoder = new TextDecoder();
            let buffer = '';
            let currentAssistantId: string | null = null;

            // Create tab-scoped setter/getter that route updates to the correct tab
            const tabSet = (fn: (s: TabState) => Partial<TabState>) => {
              set((state) => ({
                tabs: state.tabs.map((t) => {
                  if (t.id !== tabId) return t;
                  return { ...t, ...fn(t) };
                }),
              }));

              // Increment unread if this tab is in the background
              const { activeTabId } = get();
              if (activeTabId !== tabId) {
                // Check if the update added a message_start or approval
                const updatedTab = getTab(tabId);
                if (updatedTab) {
                  // We'll handle notification tracking in the event processing below
                }
              }
            };

            const tabGet = (): TabState => {
              return getTab(tabId) ?? createEmptyTab();
            };

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

                    // Track notifications for background tabs
                    const { activeTabId: currentActive } = get();
                    const isBackground = currentActive !== tabId;

                    if (isBackground) {
                      if (event.type === 'message_start') {
                        const t = getTab(tabId);
                        if (t) updateTab(tabId, { unreadCount: t.unreadCount + 1 });
                      }
                      if (event.type === 'approval_required' || event.type === 'plan_approval_required') {
                        updateTab(tabId, { hasApprovalPending: true });
                      }
                    }

                    // Update title from title_updated events
                    if (event.type === 'title_updated') {
                      updateTab(tabId, { title: event.title });
                    }

                    currentAssistantId = processStreamEvent(
                      event,
                      tabSet as (fn: (s: any) => Partial<any>) => void,
                      tabGet as () => any,
                      currentAssistantId
                    );
                  } catch (parseErr) {
                    console.error('[Workspace] Failed to parse SSE event:', jsonStr.slice(0, 200), parseErr);
                  }
                }
              }
            }
          } catch (err) {
            updateTab(tabId, {
              error: err instanceof Error ? err.message : 'Failed to send message',
              isStreaming: false,
            });
          } finally {
            const t = getTab(tabId);
            if (t?.isStreaming) {
              updateTab(tabId, { isStreaming: false });
            }
            if (sessionId) {
              get()._readers.delete(sessionId);
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
              const data = await res.json().catch(() => ({ error: 'Unknown error' }));
              updateTab(tabId, { error: data.error || 'Failed to process approval. It may have timed out.' });
              return;
            }
            updateTab(tabId, { pendingApproval: null, hasApprovalPending: false });
          } catch (err) {
            console.error('[Workspace] Approval failed:', err);
            updateTab(tabId, { error: 'Failed to process approval' });
          }
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
              const data = await res.json().catch(() => ({ error: 'Unknown error' }));
              updateTab(tabId, { error: data.error || 'Failed to process plan approval' });
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
              const data = await res.json().catch(() => ({ error: 'Unknown error' }));
              updateTab(tabId, { error: data.error || 'Failed to abort plan' });
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
              const data = await res.json().catch(() => ({ error: 'Unknown error' }));
              updateTab(tabId, { error: data.error || 'Failed to pause AI' });
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
              const data = await res.json().catch(() => ({ error: 'Failed to flag session' }));
              updateTab(tabId, { error: data.error || 'Failed to flag session' });
              return;
            }
            updateTab(tabId, { isFlagged: true });
          } catch (err) {
            console.error('[Workspace] Flag failed:', err);
            updateTab(tabId, { error: 'Failed to flag session' });
          }
        },

        unflagSession: async (tabId: string) => {
          const tab = getTab(tabId);
          if (!tab?.sessionId) return;

          try {
            const res = await fetchWithAuth(`/ai/sessions/${tab.sessionId}/flag`, { method: 'DELETE' });
            if (!res.ok) {
              const data = await res.json().catch(() => ({ error: 'Failed to unflag session' }));
              updateTab(tabId, { error: data.error || 'Failed to unflag session' });
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
          const { tabs } = get();
          const tabsWithSessions = tabs.filter((t) => t.sessionId);
          if (tabsWithSessions.length === 0) return;

          await Promise.all(
            tabsWithSessions.map(async (tab) => {
              if (!tab.sessionId) return;
              try {
                const res = await fetchWithAuth(`/ai/sessions/${tab.sessionId}`);
                if (!res.ok) {
                  if (res.status === 404) {
                    updateTab(tab.id, { sessionId: null, messages: [] });
                  }
                  return;
                }
                const data = await res.json();
                if (data.session?.status !== 'active') {
                  updateTab(tab.id, { sessionId: null, messages: [] });
                  return;
                }
                const messages = mapMessagesFromApi(data.messages || []);
                updateTab(tab.id, {
                  messages,
                  isFlagged: !!data.session.flaggedAt,
                });
              } catch (err) {
                console.error(`[Workspace] Failed to restore tab ${tab.id}:`, err);
              }
            })
          );
        },

        cleanupAllStreams: () => {
          const { _readers } = get();
          for (const reader of _readers.values()) {
            reader.cancel().catch(() => {});
          }
          _readers.clear();
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
            contextLabel: t.contextLabel,
            pageContext: t.pageContext,
          })),
        };
      },
    }
  )
);
