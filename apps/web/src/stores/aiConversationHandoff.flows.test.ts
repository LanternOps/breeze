/**
 * #9840 W3 (Task 13): the two move flows (D3, Review Focus 2).
 *
 * panel → workspace (moveToAssistant): the tab cap is checked before anything
 * else; the hand-off starts without being awaited; the panel is released only
 * inside completeHandoff (the workspace calls it once its tab is ready). No
 * completion within HANDOFF_TIMEOUT_MS → the panel keeps the session.
 *
 * workspace → panel (continueInSidePanel): closeTab runs only after
 * adoptSession resolved 'ok'; anything else keeps the tab.
 *
 * Neither direction ever DELETEs the session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('./orgStore', () => ({ useOrgStore: { getState: () => ({ currentOrgId: null }) } }));
vi.mock('../components/shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('astro:transitions/client', () => ({ navigate: vi.fn() }));

import { navigate } from 'astro:transitions/client';
import { fetchWithAuth } from './auth';
import { showToast } from '../components/shared/Toast';
import { useAiStore } from './aiStore';
import { useWorkspaceStore, type TabState } from './workspaceStore';
import { abortAllAttaches } from './aiSessionAttach';
import {
  HANDOFF_TIMEOUT_MS,
  abortHandoff,
  completeHandoff,
  continueInSidePanel,
  moveToAssistant,
  useHandoffStore,
} from './aiConversationHandoff';

const fetchMock = vi.mocked(fetchWithAuth);
const navigateMock = vi.mocked(navigate);
const toastMock = vi.mocked(showToast);
const enc = new TextEncoder();

const S = '0f8fad5b-d9cb-469f-a165-70867728950e';
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload), body: null }) as unknown as Response;
const idleStream = (): Response => {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(`data: ${JSON.stringify({
        type: 'attach_state', turn: 'idle', turnId: null, lastSeq: 0, turnUserMessageId: null,
        partial: false, replay: [], pendingCards: [], activePlan: null, turnModel: null,
      })}\n\n`));
      c.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
};
const session = (id: string, over: Record<string, unknown> = {}) =>
  json({ session: { id, status: 'active', orgId: 'org-1', type: 'general', title: 'T', ...over }, messages: [] });

type Handler = () => Response | Promise<Response>;
let routes: Map<string, Handler>;
const methodsCalled = () => fetchMock.mock.calls.map(([, init]) => (init as RequestInit | undefined)?.method ?? 'GET');

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
const persistedPanel = () => JSON.parse(localStorage.getItem('breeze-ai-chat') ?? '{}').state ?? {};

beforeEach(() => {
  vi.clearAllMocks();
  routes = new Map();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string | URL | Request) => {
    const h = routes.get(String(url));
    return h ? h() : json({}, 404);
  });
  routes.set(`/ai/sessions/${S}`, () => session(S));
  routes.set(`/ai/sessions/${S}/stream`, idleStream);
  useWorkspaceStore.getState().cleanupAllStreams();
  useWorkspaceStore.setState({ tabs: [], activeTabId: null });
  useAiStore.setState({
    isOpen: true, sessionId: S, sessionOrgId: 'org-1', hydratedSessionId: S, messages: [],
    isStreaming: false, isLoading: false, error: null, errorCode: null, composerDraft: 'half a thought',
    topologySiteId: null, joinedMidResponse: false,
  });
  window.history.replaceState(null, '', '/devices');
});

afterEach(() => {
  abortHandoff(S);
  abortHandoff(OTHER);
  useWorkspaceStore.getState().cleanupAllStreams();
  abortAllAttaches();
  vi.useRealTimers();
});

describe('moveToAssistant (panel → workspace)', () => {
  it('five other tabs → tab_cap toast, panel untouched, no navigation, no hand-off', async () => {
    useWorkspaceStore.setState({ tabs: [1, 2, 3, 4, 5].map((i) => tab({ id: `t${i}`, sessionId: `s${i}` })), activeTabId: 't1' });
    await expect(moveToAssistant(S, { draft: 'half a thought' })).resolves.toBe('tab_cap');
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Close a tab in Breeze AI to open this conversation',
    }));
    expect(navigateMock).not.toHaveBeenCalled();
    expect(useHandoffStore.getState().pending).toBeNull();
    expect(useAiStore.getState()).toMatchObject({ sessionId: S, isOpen: true, composerDraft: 'half a thought' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('five tabs where one already holds the session → no cap (it will be focused)', async () => {
    useWorkspaceStore.setState({ tabs: [tab({ id: 't1', sessionId: S }), ...[2, 3, 4, 5].map((i) => tab({ id: `t${i}` }))], activeTabId: 't2' });
    const result = moveToAssistant(S, {});
    await vi.waitFor(() => expect(navigateMock).toHaveBeenCalled());
    completeHandoff(S);
    await expect(result).resolves.toBe('moved');
  });

  it('from another page → navigate(/ai/chat#session=<id>) with the draft on the pending hand-off; nothing released yet', async () => {
    const result = moveToAssistant(S, { draft: 'half a thought' });
    await vi.waitFor(() => expect(navigateMock).toHaveBeenCalledWith(`/ai/chat#session=${S}`));
    expect(useHandoffStore.getState().pending).toMatchObject({ sessionId: S, origin: 'panel', draft: 'half a thought' });
    expect(useAiStore.getState().sessionId).toBe(S);
    expect(useAiStore.getState().isOpen).toBe(true);
    completeHandoff(S);
    await result;
  });

  it('on /ai/chat → a real hash change, no navigate', async () => {
    window.history.replaceState(null, '', '/ai/chat');
    const onHash = vi.fn();
    window.addEventListener('hashchange', onHash);
    const result = moveToAssistant(S, {});
    await vi.waitFor(() => expect(window.location.hash).toBe(`#session=${S}`));
    await vi.waitFor(() => expect(onHash).toHaveBeenCalled());
    window.removeEventListener('hashchange', onHash);
    expect(navigateMock).not.toHaveBeenCalled();
    completeHandoff(S);
    await result;
  });

  it('completeHandoff → the panel is released (unbound, closed, persisted null), resolves moved, and nothing was DELETEd', async () => {
    const result = moveToAssistant(S, { draft: 'half a thought' });
    await vi.waitFor(() => expect(navigateMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(useAiStore.getState()).toMatchObject({ sessionId: S, isOpen: true }); // not before completion
    completeHandoff(S);
    await expect(result).resolves.toBe('moved');
    const s = useAiStore.getState();
    expect(s.sessionId).toBeNull();
    expect(s.isOpen).toBe(false);
    expect(s.composerDraft).toBe('');
    expect(persistedPanel().sessionId ?? null).toBeNull();
    expect(methodsCalled()).not.toContain('DELETE');
    expect(fetchMock).not.toHaveBeenCalled(); // release is local
  });

  it('no completion within HANDOFF_TIMEOUT_MS (the workspace never mounts) → aborted; panel still bound, open, draft intact', async () => {
    vi.useFakeTimers();
    const result = moveToAssistant(S, { draft: 'half a thought' });
    await vi.waitFor(() => expect(navigateMock).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(HANDOFF_TIMEOUT_MS + 1);
    await expect(result).resolves.toBe('aborted');
    expect(useAiStore.getState()).toMatchObject({ sessionId: S, isOpen: true, composerDraft: 'half a thought' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a second click while that move is pending is ignored (no restart, the first still completes)', async () => {
    const first = moveToAssistant(S, { draft: 'half a thought' });
    await vi.waitFor(() => expect(navigateMock).toHaveBeenCalledTimes(1));
    await expect(moveToAssistant(S, { draft: 'half a thought' })).resolves.toBe('aborted');
    expect(navigateMock).toHaveBeenCalledTimes(1);
    completeHandoff(S);
    await expect(first).resolves.toBe('moved');
  });

  it('navigation throwing → aborted, toast, no pending hand-off, panel untouched', async () => {
    navigateMock.mockImplementationOnce(() => { throw new Error('router gone'); });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(moveToAssistant(S, { draft: 'half a thought' })).resolves.toBe('aborted');
    expect(useHandoffStore.getState().pending).toBeNull();
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: "This conversation isn't available" }));
    expect(useAiStore.getState()).toMatchObject({ sessionId: S, isOpen: true, composerDraft: 'half a thought' });
  });

  it('an aborted destination (abortHandoff) keeps the panel at once', async () => {
    const result = moveToAssistant(S, {});
    await vi.waitFor(() => expect(navigateMock).toHaveBeenCalled());
    abortHandoff(S);
    await expect(result).resolves.toBe('aborted');
    expect(useAiStore.getState().sessionId).toBe(S);
  });
});

describe('continueInSidePanel (workspace → panel)', () => {
  beforeEach(() => {
    useAiStore.setState({ sessionId: null, hydratedSessionId: null, isOpen: false, composerDraft: '', isStreaming: false });
    useWorkspaceStore.setState({
      tabs: [tab({ id: 'ta', sessionId: S, composerDraft: 'tab draft' }), tab({ id: 'tb', sessionId: OTHER })],
      activeTabId: 'ta',
    });
  });

  it('an idle, empty panel → no confirm; the tab closes only after adopt resolved ok; draft carried; no DELETE', async () => {
    let release!: () => void;
    routes.set(`/ai/sessions/${S}`, () => new Promise<Response>((r) => { release = () => r(session(S)); }));
    const confirm = vi.fn(async () => true);
    const result = continueInSidePanel('ta', { confirm });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(useWorkspaceStore.getState().tabs.map((t) => t.id)).toEqual(['ta', 'tb']); // not yet
    release();
    await expect(result).resolves.toBe('moved');
    expect(confirm).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().tabs.map((t) => t.id)).toEqual(['tb']);
    expect(useAiStore.getState()).toMatchObject({ sessionId: S, isOpen: true, composerDraft: 'tab draft' });
    expect(methodsCalled()).not.toContain('DELETE');
  });

  it('the panel streaming a different session → confirm; cancel changes nothing and fetches nothing', async () => {
    useAiStore.setState({ sessionId: OTHER, isOpen: true, isStreaming: true });
    const confirm = vi.fn(async () => false);
    await expect(continueInSidePanel('ta', { confirm })).resolves.toBe('cancelled');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useAiStore.getState().sessionId).toBe(OTHER);
    expect(useWorkspaceStore.getState().tabs).toHaveLength(2);
  });

  it('the panel holding a draft for a different session → confirm; accept moves', async () => {
    useAiStore.setState({ sessionId: OTHER, isOpen: true, composerDraft: 'unsent' });
    const confirm = vi.fn(async () => true);
    await expect(continueInSidePanel('ta', { confirm })).resolves.toBe('moved');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(useAiStore.getState().sessionId).toBe(S);
  });

  it('the panel idle on a different session with no draft → no confirm', async () => {
    useAiStore.setState({ sessionId: OTHER, isOpen: true, composerDraft: '   ' });
    const confirm = vi.fn(async () => true);
    await expect(continueInSidePanel('ta', { confirm })).resolves.toBe('moved');
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each([
    ['404', () => json({}, 404), "This conversation isn't available"],
    ['closed', () => session(S, { status: 'closed' }), 'This conversation was closed'],
    ['a 500', () => json({}, 500), "This conversation isn't available"],
  ] as const)('adopt %s → failed, the tab is kept, toast', async (_l, handler, message) => {
    routes.set(`/ai/sessions/${S}`, handler);
    await expect(continueInSidePanel('ta', { confirm: async () => true })).resolves.toBe('failed');
    expect(useWorkspaceStore.getState().tabs.map((t) => t.id)).toEqual(['ta', 'tb']);
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message }));
    expect(methodsCalled()).not.toContain('DELETE');
  });

  it('a tab closed while adopt is in flight → moved, and no other tab is closed', async () => {
    let release!: () => void;
    routes.set(`/ai/sessions/${S}`, () => new Promise<Response>((r) => { release = () => r(session(S)); }));
    const result = continueInSidePanel('ta', { confirm: async () => true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    useWorkspaceStore.getState().closeTab('ta');
    release();
    await expect(result).resolves.toBe('moved');
    expect(useWorkspaceStore.getState().tabs.map((t) => t.id)).toEqual(['tb']);
  });

  it('text typed in the tab while adopt is in flight still reaches the panel', async () => {
    let release!: () => void;
    routes.set(`/ai/sessions/${S}`, () => new Promise<Response>((r) => { release = () => r(session(S)); }));
    const result = continueInSidePanel('ta', { confirm: async () => true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    useWorkspaceStore.getState().setComposerDraft('ta', 'tab draft and more');
    release();
    await expect(result).resolves.toBe('moved');
    expect(useAiStore.getState().composerDraft).toBe('tab draft and more');
  });

  it('a superseded adopt (aborted) keeps the tab without a false "not available" toast', async () => {
    const adopt = vi.spyOn(useAiStore.getState(), 'adoptSession').mockResolvedValueOnce('aborted');
    useAiStore.setState({ adoptSession: adopt as never });
    await expect(continueInSidePanel('ta', { confirm: async () => true })).resolves.toBe('failed');
    expect(toastMock).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().tabs.map((t) => t.id)).toEqual(['ta', 'tb']);
  });

  it('a tab that is gone by the time the move runs → failed with a toast', async () => {
    await expect(continueInSidePanel('nope', { confirm: async () => true })).resolves.toBe('failed');
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ message: "This conversation isn't available" }));
  });

  it('a tab without a session → failed, nothing fetched', async () => {
    useWorkspaceStore.setState({ tabs: [tab({ id: 'empty' })], activeTabId: 'empty' });
    await expect(continueInSidePanel('empty', { confirm: async () => true })).resolves.toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
