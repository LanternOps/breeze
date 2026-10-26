/**
 * #9840 W4 (Task 15): the one conversation list both surfaces read.
 *
 * Lists the caller's active chat sessions (GET /ai/sessions?status=active),
 * searches with a 300 ms debounce from two characters, keeps only chat types,
 * and on the workspace surface also drops topology rows and non-active search
 * hits (D4). `openIn` says which surface of this document holds a row, and
 * follows the workspace tabs while the list is showing.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('@/stores/orgStore', () => ({ useOrgStore: { getState: () => ({ currentOrgId: null }) } }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));

import { fetchWithAuth } from '@/stores/auth';
import { useAiStore } from '@/stores/aiStore';
import { useWorkspaceStore, type TabState } from '@/stores/workspaceStore';
import { SEARCH_DEBOUNCE_MS, useAiConversationSource } from './useAiConversationSource';

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const T = '33333333-3333-4333-8333-333333333333';
const C = '44444444-4444-4444-8444-444444444444';

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: `Chat ${id.slice(0, 4)}`, status: 'active', model: 'm', turnCount: 1, totalCostCents: 0,
  lastActivityAt: '2026-10-20T10:00:00.000Z', createdAt: '2026-10-20T09:00:00.000Z',
  orgId: 'org-1', type: 'general', deviceId: null, ...over,
});
const hit = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: `Hit ${id.slice(0, 4)}`, matchedContent: 'patch rollout', createdAt: '2026-10-19T09:00:00.000Z',
  status: 'active', type: 'general', orgId: 'org-1', deviceId: null, ...over,
});

let listRows: unknown[];
let searchRows: unknown[];
const searchCalls = () => fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith('/ai/sessions/search'));
const listCalls = () => fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u === '/ai/sessions?status=active');

function tab(over: Partial<TabState>): TabState {
  return {
    id: 'tab-x', sessionId: null, title: 'Chat', isTitleCustom: false, contextLabel: null, pageContext: null,
    messages: [], chatRuns: {}, isStreaming: false, isLoading: false, error: null, pendingApproval: null,
    pendingPlan: null, activePlan: null, approvalMode: 'per_step', isPaused: false, isInterrupting: false,
    isFlagged: false, unreadCount: 0, hasApprovalPending: false, orgId: null, deviceId: null, deviceLabel: null,
    m365ConnectionId: null, composerDraft: '', joinedMidResponse: false, errorAction: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listRows = [row(A), row(B, { deviceId: 'dev-1' }), row(T, { type: 'topology' })];
  searchRows = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string | URL | Request) => {
    const u = String(url);
    if (u === '/ai/sessions?status=active') return json({ data: listRows });
    if (u.startsWith('/ai/sessions/search')) return json({ data: searchRows });
    return json({}, 404);
  });
  useWorkspaceStore.setState({ tabs: [], activeTabId: null });
  useAiStore.setState({ sessionId: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('list', () => {
  it('sends one GET /ai/sessions?status=active on mount and maps the rows', async () => {
    const { result } = renderHook(() => useAiConversationSource({ surface: 'panel' }));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(listCalls()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.items.map((r) => r.id)).toEqual([A, B, T]);
    expect(result.current.items[1]).toMatchObject({
      id: B, title: `Chat ${B.slice(0, 4)}`, orgId: 'org-1', type: 'general', deviceId: 'dev-1',
      status: 'active', createdAt: '2026-10-20T09:00:00.000Z', lastActivityAt: '2026-10-20T10:00:00.000Z', openIn: null,
    });
    expect(result.current.error).toBeNull();
  });

  it('panel surface keeps topology rows; workspace surface drops them (D4)', async () => {
    const panel = renderHook(() => useAiConversationSource({ surface: 'panel' }));
    const workspace = renderHook(() => useAiConversationSource({ surface: 'workspace' }));
    await waitFor(() => expect(panel.result.current.isLoading).toBe(false));
    await waitFor(() => expect(workspace.result.current.isLoading).toBe(false));
    expect(panel.result.current.items.map((r) => r.id)).toContain(T);
    expect(workspace.result.current.items.map((r) => r.id)).toEqual([A, B]);
  });

  it.each(['panel', 'workspace'] as const)('%s surface never lists a non-chat type, even if an older API returns one', async (surface) => {
    listRows = [row(A), row(B, { type: 'script_builder' }), row(C, { type: 'mcp' }), row(T, { type: undefined })];
    const { result } = renderHook(() => useAiConversationSource({ surface }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items.map((r) => r.id)).toEqual([A]);
  });

  it('a list failure sets error, logs, and does not throw', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock.mockImplementation(async () => json({ error: 'nope' }, 500));
    const { result } = renderHook(() => useAiConversationSource({ surface: 'panel' }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).not.toBeNull();
    expect(result.current.items).toEqual([]);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('a 200 without a data array is a failure, not an empty history', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock.mockImplementation(async () => json({ sessions: [] }));
    const { result } = renderHook(() => useAiConversationSource({ surface: 'panel' }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).not.toBeNull();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('rows dropped as malformed or non-chat are reported once per response', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    listRows = [row(A), row(B, { type: 'mcp' }), { id: C }];
    const { result } = renderHook(() => useAiConversationSource({ surface: 'panel' }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items.map((r) => r.id)).toEqual([A]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]![0])).toMatch(/2 of 3/);
    warnSpy.mockRestore();
  });

  it('a list response that lands after unmount writes nothing', async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((r) => { resolve = r; }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { result, unmount } = renderHook(() => useAiConversationSource({ surface: 'panel' }));
    const before = result.current;
    unmount();
    await act(async () => { resolve(json({ data: listRows })); });
    expect(result.current).toBe(before);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('search', () => {
  it('debounces 300 ms and only searches from two characters', async () => {
    vi.useFakeTimers();
    searchRows = [hit(C)];
    const { result } = renderHook(() => useAiConversationSource({ surface: 'panel' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    act(() => result.current.setQuery('p'));
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2); });
    expect(searchCalls()).toHaveLength(0);
    // Under two characters the list shows, not a search.
    expect(result.current.items.map((r) => r.id)).toEqual([A, B, T]);

    act(() => result.current.setQuery('pa'));
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1); });
    expect(searchCalls()).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(searchCalls()).toEqual(['/ai/sessions/search?q=pa&limit=20']);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.isSearching).toBe(false);
    expect(result.current.items.map((r) => r.id)).toEqual([C]);
    expect(result.current.items[0]).toMatchObject({ matchedContent: 'patch rollout' });
  });

  it('typing quickly sends one request for the final query, URL-encoded', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useAiConversationSource({ surface: 'panel' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    for (const q of ['pa', 'pat', 'pat&', 'pat& x']) {
      act(() => result.current.setQuery(q));
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS); });
    expect(searchCalls()).toEqual([`/ai/sessions/search?q=${encodeURIComponent('pat& x')}&limit=20`]);
  });

  it('shortening the query below two characters clears the results without a request (was aiStore.searchConversations)', async () => {
    vi.useFakeTimers();
    searchRows = [hit(C)];
    const { result } = renderHook(() => useAiConversationSource({ surface: 'panel' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    act(() => result.current.setQuery('patch'));
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS); });
    expect(result.current.items.map((r) => r.id)).toEqual([C]);
    fetchMock.mockClear();

    act(() => result.current.setQuery('p'));
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.isSearching).toBe(false);
    expect(result.current.items.map((r) => r.id)).toEqual([A, B, T]);
  });

  it('results of a stale query are never applied', async () => {
    vi.useFakeTimers();
    const pending = new Map<string, (r: Response) => void>();
    fetchMock.mockImplementation((url: string | URL | Request) => {
      const u = String(url);
      if (u === '/ai/sessions?status=active') return Promise.resolve(json({ data: listRows }));
      return new Promise<Response>((r) => pending.set(u, r));
    });
    const { result } = renderHook(() => useAiConversationSource({ surface: 'panel' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    act(() => result.current.setQuery('ab'));
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS); });
    act(() => result.current.setQuery('abc'));
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS); });
    expect([...pending.keys()]).toEqual(['/ai/sessions/search?q=ab&limit=20', '/ai/sessions/search?q=abc&limit=20']);

    await act(async () => { pending.get('/ai/sessions/search?q=abc&limit=20')!(json({ data: [hit(C)] })); });
    await act(async () => { pending.get('/ai/sessions/search?q=ab&limit=20')!(json({ data: [hit(A)] })); });
    expect(result.current.items.map((r) => r.id)).toEqual([C]);
    expect(result.current.isSearching).toBe(false);
  });

  it('panel surface keeps closed search hits; workspace surface drops every non-active hit and topology hit (D4)', async () => {
    vi.useFakeTimers();
    searchRows = [hit(A), hit(B, { status: 'closed' }), hit(C, { status: 'expired' }), hit(T, { type: 'topology' })];
    const panel = renderHook(() => useAiConversationSource({ surface: 'panel' }));
    const workspace = renderHook(() => useAiConversationSource({ surface: 'workspace' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    act(() => { panel.result.current.setQuery('patch'); workspace.result.current.setQuery('patch'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS); });
    expect(panel.result.current.items.map((r) => [r.id, r.status])).toEqual([
      [A, 'active'], [B, 'closed'], [C, 'expired'], [T, 'active'],
    ]);
    expect(workspace.result.current.items.map((r) => r.id)).toEqual([A]);
  });

  it('a search failure sets error and shows no hits', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock.mockImplementation(async (url: string | URL | Request) =>
      String(url) === '/ai/sessions?status=active' ? json({ data: listRows }) : json({ error: 'x' }, 500));
    const { result } = renderHook(() => useAiConversationSource({ surface: 'panel' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    act(() => result.current.setQuery('patch'));
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS); });
    expect(result.current.error).not.toBeNull();
    expect(result.current.items).toEqual([]);
    expect(result.current.isSearching).toBe(false);
    errSpy.mockRestore();
  });
});

describe('openIn', () => {
  it("is 'panel' for the side panel's session and 'workspace' for a tab's", async () => {
    useAiStore.setState({ sessionId: A });
    useWorkspaceStore.setState({ tabs: [tab({ id: 'tab-b', sessionId: B })], activeTabId: 'tab-b' });
    const { result } = renderHook(() => useAiConversationSource({ surface: 'panel' }));
    await waitFor(() => expect(result.current.items.find((r) => r.id === B)?.openIn).toBe('workspace'));
    expect(result.current.items.find((r) => r.id === A)?.openIn).toBe('panel');
    expect(result.current.items.find((r) => r.id === T)?.openIn).toBeNull();
  });

  it('follows tabs opening and closing while the list is showing', async () => {
    const { result } = renderHook(() => useAiConversationSource({ surface: 'panel' }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items.find((r) => r.id === A)?.openIn).toBeNull();

    act(() => useWorkspaceStore.setState({ tabs: [tab({ id: 'tab-a', sessionId: A })], activeTabId: 'tab-a' }));
    await waitFor(() => expect(result.current.items.find((r) => r.id === A)?.openIn).toBe('workspace'));

    act(() => useWorkspaceStore.setState({ tabs: [], activeTabId: null }));
    await waitFor(() => expect(result.current.items.find((r) => r.id === A)?.openIn).toBeNull());
  });

  it('follows the side panel binding and releasing a session', async () => {
    const { result } = renderHook(() => useAiConversationSource({ surface: 'workspace' }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => useAiStore.setState({ sessionId: B }));
    expect(result.current.items.find((r) => r.id === B)?.openIn).toBe('panel');
    act(() => useAiStore.setState({ sessionId: null }));
    expect(result.current.items.find((r) => r.id === B)?.openIn).toBeNull();
  });

  it('unsubscribes from the workspace tabs on unmount', async () => {
    const original = useWorkspaceStore.subscribe;
    const unsub = vi.fn();
    const spy = vi.spyOn(useWorkspaceStore, 'subscribe').mockImplementation((listener) => {
      const off = original(listener);
      return () => { unsub(); off(); };
    });
    const { result, unmount } = renderHook(() => useAiConversationSource({ surface: 'panel' }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    unmount();
    expect(unsub).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('does not re-render on workspace changes that leave the tab sessions alone', async () => {
    useWorkspaceStore.setState({ tabs: [tab({ id: 'tab-a', sessionId: A })], activeTabId: 'tab-a' });
    let renders = 0;
    const { result } = renderHook(() => { renders += 1; return useAiConversationSource({ surface: 'panel' }); });
    await waitFor(() => expect(result.current.items.find((r) => r.id === A)?.openIn).toBe('workspace'));
    const settled = renders;
    act(() => useWorkspaceStore.setState({ tabs: [tab({ id: 'tab-a', sessionId: A, isStreaming: true, unreadCount: 3 })] }));
    expect(renders).toBe(settled);
  });
});
