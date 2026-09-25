import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real sidebar + real store: the bug lives in the interaction between the
// sidebar's session-restore effect and `sendMessage`'s create-then-append, so
// neither side may be mocked. Only the network and the heavy children are.
vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: () => true }),
}));
vi.mock('./AiChatMessages', () => ({ default: () => null }));
vi.mock('./AiChatInput', () => ({ default: () => null }));
vi.mock('./AiContextBadge', () => ({ default: () => null }));
vi.mock('./AiCostIndicator', () => ({ default: () => null }));

import AiChatSidebar from './AiChatSidebar';
import { useAiStore } from '@/stores/aiStore';
import { fetchWithAuth } from '@/stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

/** An SSE response whose body never finishes — the assistant is "still streaming". */
const openStream = (): Response =>
  ({
    ok: true,
    status: 200,
    body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: vi.fn() }) },
  }) as unknown as Response;

const resetStore = (over: Partial<ReturnType<typeof useAiStore.getState>> = {}) =>
  useAiStore.setState({
    isOpen: true,
    sessionId: null,
    sessionOrgId: null,
    hydratedSessionId: null,
    messages: [],
    isStreaming: false,
    isLoading: false,
    error: null,
    pageContext: null,
    pendingApproval: null,
    showHistory: false,
    sessions: [],
    ...over,
  });

describe('AiChatSidebar first message of a new session (#6933)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });
  afterEach(() => resetStore({ isOpen: false }));

  it('keeps the optimistic user message while the assistant streams', async () => {
    resetStore();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/ai/sessions' && init?.method === 'POST') return json({ id: 's-new', orgId: 'org-1' });
      // The server has not persisted the user row yet when the restore fetch lands.
      if (url === '/ai/sessions/s-new') return json({ session: { status: 'active', orgId: 'org-1' }, messages: [] });
      if (url === '/ai/sessions/s-new/messages') return openStream();
      return json({ data: [] });
    });

    render(<AiChatSidebar />);

    await act(async () => {
      void useAiStore.getState().sendMessage('why is the disk full?');
    });
    // Let every pending fetch (including any restore) settle.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    const state = useAiStore.getState();
    expect(state.sessionId).toBe('s-new');
    expect(state.isStreaming).toBe(true);
    expect(state.messages.map((m) => [m.role, m.content])).toEqual([['user', 'why is the disk full?']]);
    // The session was created in memory; there is nothing on the server to restore.
    expect(fetchMock.mock.calls.some(([u]) => u === '/ai/sessions/s-new')).toBe(false);
  });

  it('still restores history for a persisted session on page load', async () => {
    resetStore({ sessionId: 's-old' });
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/ai/sessions/s-old') {
        return json({
          session: { status: 'active', orgId: 'org-1' },
          messages: [
            { id: 'm1', role: 'user', content: 'hello', createdAt: '2026-09-01T00:00:00.000Z' },
            { id: 'm2', role: 'assistant', content: 'hi there', createdAt: '2026-09-01T00:00:01.000Z' },
          ],
        });
      }
      return json({ data: [] });
    });

    render(<AiChatSidebar />);

    await waitFor(() => expect(useAiStore.getState().messages).toHaveLength(2));
    expect(fetchMock).toHaveBeenCalledWith('/ai/sessions/s-old');
    expect(useAiStore.getState().messages.map((m) => m.content)).toEqual(['hello', 'hi there']);
  });
});
