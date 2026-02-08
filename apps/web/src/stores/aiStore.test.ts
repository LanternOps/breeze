import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({
  fetchWithAuth: vi.fn()
}));

import { fetchWithAuth } from './auth';
import { useAiStore } from './aiStore';

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    json: vi.fn().mockResolvedValue(payload)
  }) as Response;

describe('ai store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAiStore.setState({
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
      isSearching: false
    });
  });

  it('searchConversations short query clears results without request', async () => {
    useAiStore.setState({ searchResults: [{ id: 's1', title: 'old', matchedContent: 'old', createdAt: 'x' }] });

    await useAiStore.getState().searchConversations('a');

    expect(fetchWithAuthMock).not.toHaveBeenCalled();
    expect(useAiStore.getState().searchResults).toEqual([]);
    expect(useAiStore.getState().isSearching).toBe(false);
  });

  it('searchConversations populates results on success', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeResponse({
        data: [
          {
            id: 'session-1',
            title: 'Patch rollout',
            matchedContent: 'check deployment errors',
            createdAt: '2026-02-07T12:00:00.000Z'
          }
        ]
      })
    );

    await useAiStore.getState().searchConversations('patch');

    expect(fetchWithAuthMock).toHaveBeenCalledWith('/ai/sessions/search?q=patch&limit=20');
    expect(useAiStore.getState().searchResults).toHaveLength(1);
    expect(useAiStore.getState().isSearching).toBe(false);
  });

  it('switchSession loads messages and clears history panel', async () => {
    useAiStore.setState({ showHistory: true });

    fetchWithAuthMock.mockResolvedValueOnce(
      makeResponse({
        messages: [
          {
            id: 'm-1',
            role: 'assistant',
            content: 'Done',
            createdAt: '2026-02-07T12:30:00.000Z'
          }
        ]
      })
    );

    await useAiStore.getState().switchSession('session-1');

    expect(fetchWithAuthMock).toHaveBeenCalledWith('/ai/sessions/session-1');
    expect(useAiStore.getState().sessionId).toBe('session-1');
    expect(useAiStore.getState().showHistory).toBe(false);
    expect(useAiStore.getState().messages).toHaveLength(1);
    expect(useAiStore.getState().messages[0]?.createdAt).toBeInstanceOf(Date);
  });
});
