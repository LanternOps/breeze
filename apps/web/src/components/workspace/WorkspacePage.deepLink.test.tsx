/**
 * #9840 W3 (Task 12): /ai/chat#session=<id> deep link and hash-follows-tab
 * (spec §3.6, D6; Advisor finding 8). Real workspaceStore, fetch mocked.
 *
 * - a link is acted on only with ai_sessions:use (no fetch, no hash read otherwise);
 * - the link opens or focuses its tab; the result maps to a toast; every result
 *   other than opened/focused aborts a pending hand-off at once (the origin must
 *   not wait out the 15 s timeout), opened/focused completes it;
 * - once handled the link is cleared (setLinked(null)) so a later hashchange back
 *   to the same id re-triggers; the hash then follows the active tab via
 *   history.replaceState(history.state, …), which fires no hashchange.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ allow: true }));
vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({
    permissions: perms.allow ? [{ resource: 'ai_sessions', action: 'use' }] : [],
    can: (resource: string, action: string) => perms.allow && resource === 'ai_sessions' && action === 'use',
  }),
}));
vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const ai = vi.hoisted(() => ({
  adoptSession: vi.fn(async (..._args: unknown[]) => 'ok'), releaseSession: vi.fn(),
  sessionId: null as string | null, composerDraft: '', isStreaming: false, isOpen: false,
}));
const panelHarness = vi.hoisted(() => ({ props: null as Record<string, any> | null }));
// #9840 W5: WorkspacePage also reads `useAiStore((s) => s.isOpen)` (the
// panel-open padding), so the mock is callable as a selector hook too.
vi.mock('@/stores/aiStore', () => ({
  useAiStore: Object.assign((sel: (s: typeof ai) => unknown) => sel(ai), { getState: () => ai }),
}));
vi.mock('./WorkspaceTabBar', () => ({ default: () => <div data-testid="workspace-tab-bar" /> }));
vi.mock('./WorkspaceChatPanel', () => ({
  default: (props: Record<string, any>) => {
    panelHarness.props = props;
    return <div data-testid="workspace-chat-panel" />;
  },
}));
vi.mock('./WorkspaceEmptyState', () => ({ default: () => <div data-testid="workspace-empty-state" /> }));

import { fetchWithAuth } from '@/stores/auth';
import { showToast } from '../shared/Toast';
import { useWorkspaceStore, type TabState } from '@/stores/workspaceStore';
import { abortAllAttaches } from '@/stores/aiSessionAttach';
import { abortHandoff, beginHandoff } from '@/stores/aiConversationHandoff';
import WorkspacePage from './WorkspacePage';

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);
const enc = new TextEncoder();

const A = '0f8fad5b-d9cb-469f-a165-70867728950e';
const B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const C = 'a3bb189e-8bf9-4888-9912-ace4e6543002';

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
  json({ session: { id, status: 'active', orgId: 'org-1', type: 'general', title: `Chat ${id.slice(0, 4)}`, ...over }, messages: [] });

type Handler = () => Response | Promise<Response>;
let routes: Map<string, Handler>;
const callsTo = (url: string) => fetchMock.mock.calls.filter(([u]) => String(u) === url);
const sessionCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/ai/sessions'));

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
const state = () => useWorkspaceStore.getState();
const activeSession = () => state().tabs.find((t) => t.id === state().activeTabId)?.sessionId ?? null;
const setUrl = (hash: string) => window.history.replaceState(null, '', `/workspace${hash}`);
/** What a link click / `location.hash =` does: one real hashchange (jsdom fires it asynchronously). */
const fireHash = async (hash: string) => {
  await act(async () => {
    const fired = new Promise<void>((resolve) => window.addEventListener('hashchange', () => resolve(), { once: true }));
    window.location.hash = hash;
    await fired;
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  perms.allow = true;
  Object.assign(ai, { sessionId: null, composerDraft: '', isStreaming: false });
  panelHarness.props = null;
  routes = new Map();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string | URL | Request) => {
    const h = routes.get(String(url));
    return h ? h() : json({}, 404);
  });
  for (const id of [A, B, C]) {
    routes.set(`/ai/sessions/${id}`, () => session(id));
    routes.set(`/ai/sessions/${id}/stream`, idleStream);
  }
  state().cleanupAllStreams();
  // Restore is the mount effect's job and is covered in workspaceStore.attach.test.ts.
  useWorkspaceStore.setState({ tabs: [], activeTabId: null, restoreWorkspace: vi.fn(async () => undefined) });
  setUrl('');
});

afterEach(() => {
  state().cleanupAllStreams();
  abortAllAttaches();
  abortHandoff(A);
  abortHandoff(B);
  vi.restoreAllMocks();
});

describe('deep link opens or focuses', () => {
  it('a link to an id already in a tab focuses it with no fetch', async () => {
    useWorkspaceStore.setState({ tabs: [tab({ id: 'ta', sessionId: A }), tab({ id: 'tb', sessionId: B })], activeTabId: 'tb' });
    setUrl(`#session=${A}`);
    render(<WorkspacePage />);
    await waitFor(() => expect(state().activeTabId).toBe('ta'));
    expect(sessionCalls()).toEqual([]);
    await waitFor(() => expect(window.location.hash).toBe(`#session=${A}`));
  });

  it('a link to a new id opens it exactly once', async () => {
    setUrl(`#session=${A.toUpperCase()}`);
    render(<WorkspacePage />);
    await waitFor(() => expect(activeSession()).toBe(A));
    expect(callsTo(`/ai/sessions/${A}`)).toHaveLength(1);
    expect(state().tabs).toHaveLength(1);
    await waitFor(() => expect(window.location.hash).toBe(`#session=${A}`));
  });

  it('a persisted active tab does not overwrite an unhandled link; the linked tab wins', async () => {
    let release!: () => void;
    routes.set(`/ai/sessions/${A}`, () => new Promise<Response>((r) => { release = () => r(session(A)); }));
    useWorkspaceStore.setState({ tabs: [tab({ id: 'tb', sessionId: B })], activeTabId: 'tb' });
    setUrl(`#session=${A}`);
    render(<WorkspacePage />);
    await waitFor(() => expect(callsTo(`/ai/sessions/${A}`)).toHaveLength(1));
    expect(window.location.hash).toBe(`#session=${A}`);
    await act(async () => { release(); });
    await waitFor(() => expect(activeSession()).toBe(A));
    expect(window.location.hash).toBe(`#session=${A}`);
  });

  it('a hashchange to another id opens it', async () => {
    render(<WorkspacePage />);
    await fireHash(`session=${B}`);
    await waitFor(() => expect(activeSession()).toBe(B));
    expect(callsTo(`/ai/sessions/${B}`)).toHaveLength(1);
  });

  it.each([['session=../x'], [`session=${A}&x=1`], [`session=${A}&session=${B}`], [A]])(
    'a malformed hash %j makes no request, on mount or on hashchange',
    async (hash) => {
      setUrl(`#${hash}`);
      const { unmount } = render(<WorkspacePage />);
      await act(async () => { await Promise.resolve(); });
      unmount();
      setUrl('');
      render(<WorkspacePage />);
      await fireHash(hash);
      await act(async () => { await Promise.resolve(); });
      expect(sessionCalls()).toEqual([]);
      expect(state().tabs).toEqual([]);
    },
  );

  it('a hashchange that lands right after a link is handled does not re-arm it', async () => {
    routes.set(`/ai/sessions/${C}`, () => json({}, 404));
    // A hashchange queued while the result is being handled lands after the
    // link is cleared but before the next render (an in-flight navigation).
    toastMock.mockImplementationOnce(() => {
      queueMicrotask(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
    });
    setUrl(`#session=${C}`);
    render(<WorkspacePage />);
    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(window.location.hash).toBe(''));
    expect(callsTo(`/ai/sessions/${C}`)).toHaveLength(1);
  });
});

describe('result → toast, hash, hand-off', () => {
  it('404 → "This conversation isn\'t available", hash cleared, a pending panel hand-off aborted at once', async () => {
    routes.set(`/ai/sessions/${C}`, () => json({}, 404));
    const onRelease = vi.fn();
    const handoff = beginHandoff({ sessionId: C, origin: 'panel' }, onRelease);
    setUrl(`#session=${C}`);
    render(<WorkspacePage />);
    await expect(handoff).resolves.toBe('aborted');
    expect(onRelease).not.toHaveBeenCalled();
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: "This conversation isn't available",
    })));
    await waitFor(() => expect(window.location.hash).toBe(''));
    expect(state().tabs).toEqual([]);
  });

  it('five tabs → "Close a tab to open this conversation", five tabs remain, no request for the link', async () => {
    useWorkspaceStore.setState({ tabs: [1, 2, 3, 4, 5].map((i) => tab({ id: `t${i}` })), activeTabId: 't1' });
    const onRelease = vi.fn();
    const handoff = beginHandoff({ sessionId: A, origin: 'panel' }, onRelease);
    setUrl(`#session=${A}`);
    render(<WorkspacePage />);
    await expect(handoff).resolves.toBe('aborted');
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ message: 'Close a tab to open this conversation' }));
    expect(state().tabs).toHaveLength(5);
    expect(sessionCalls()).toEqual([]);
    expect(onRelease).not.toHaveBeenCalled();
  });

  it('openSession throwing → the hand-off is aborted at once, a toast, and the link can re-arm', async () => {
    const original = state().openSession;
    const boom = vi.fn(async () => { throw new Error('unexpected'); });
    useWorkspaceStore.setState({ openSession: boom as never });
    const onRelease = vi.fn();
    const handoff = beginHandoff({ sessionId: A, origin: 'panel' }, onRelease);
    setUrl(`#session=${A}`);
    render(<WorkspacePage />);
    await expect(handoff).resolves.toBe('aborted');
    expect(onRelease).not.toHaveBeenCalled();
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ message: "This conversation isn't available" })));
    useWorkspaceStore.setState({ openSession: original });
    await fireHash(`session=${B}`);
    await fireHash(`session=${A}`);
    await waitFor(() => expect(activeSession()).toBe(A));
  });

  it('a closed session → "This conversation was closed"', async () => {
    routes.set(`/ai/sessions/${A}`, () => session(A, { status: 'closed' }));
    setUrl(`#session=${A}`);
    render(<WorkspacePage />);
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ message: 'This conversation was closed' })));
  });

  it('a topology session → no tab; the toast action opens it in the side panel', async () => {
    routes.set(`/ai/sessions/${A}`, () => session(A, { type: 'topology', topologySiteId: 'site-1' }));
    setUrl(`#session=${A}`);
    render(<WorkspacePage />);
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    const toast = toastMock.mock.calls[0]![0];
    expect(toast.message).toBe('Investigations open from the topology map');
    expect(toast.action?.label).toBe('Open in side panel');
    expect(state().tabs).toEqual([]);
    expect(callsTo(`/ai/sessions/${A}/stream`)).toHaveLength(0);
    toast.action?.onClick();
    expect(ai.adoptSession).toHaveBeenCalledWith(A);
  });

  it('a pending hand-off for the linked id completes once the tab opened, and its draft lands in the composer', async () => {
    const onRelease = vi.fn();
    const handoff = beginHandoff({ sessionId: A, origin: 'panel', draft: 'carried over' }, onRelease);
    setUrl(`#session=${A}`);
    render(<WorkspacePage />);
    await expect(handoff).resolves.toBe('completed');
    expect(onRelease).toHaveBeenCalledTimes(1);
    const opened = state().tabs.find((t) => t.sessionId === A);
    expect(opened?.composerDraft).toBe('carried over');
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('a hand-off aborted while the open is in flight → no tab, origin not released', async () => {
    let release!: () => void;
    routes.set(`/ai/sessions/${A}`, () => new Promise<Response>((r) => { release = () => r(session(A)); }));
    const onRelease = vi.fn();
    const handoff = beginHandoff({ sessionId: A, origin: 'panel' }, onRelease);
    setUrl(`#session=${A}`);
    render(<WorkspacePage />);
    await waitFor(() => expect(callsTo(`/ai/sessions/${A}`)).toHaveLength(1));
    abortHandoff(A); // what the 15 s timeout does
    await act(async () => { release(); });
    await expect(handoff).resolves.toBe('aborted');
    await act(async () => { await Promise.resolve(); });
    expect(state().tabs).toEqual([]);
    expect(onRelease).not.toHaveBeenCalled();
    expect(callsTo(`/ai/sessions/${A}/stream`)).toHaveLength(0);
  });
});

describe('hash follows the active tab', () => {
  it('switching tabs rewrites the hash with replaceState(history.state, …) and re-enters nothing', async () => {
    window.history.replaceState({ astro: 'router' }, '', '/ai/chat');
    useWorkspaceStore.setState({ tabs: [tab({ id: 'ta', sessionId: A }), tab({ id: 'tb', sessionId: B })], activeTabId: 'ta' });
    render(<WorkspacePage />);
    await waitFor(() => expect(window.location.hash).toBe(`#session=${A}`));
    const replace = vi.spyOn(window.history, 'replaceState');
    const onHash = vi.fn();
    window.addEventListener('hashchange', onHash);
    await act(async () => { state().switchTab('tb'); });
    expect(replace).toHaveBeenCalledWith({ astro: 'router' }, '', `/ai/chat#session=${B}`);
    expect(window.history.state).toEqual({ astro: 'router' });
    window.removeEventListener('hashchange', onHash);
    expect(onHash).not.toHaveBeenCalled();
    expect(sessionCalls()).toEqual([]);
  });

  it('link to A, switch to B (hash → B), then a hashchange back to A focuses A again', async () => {
    setUrl(`#session=${A}`);
    render(<WorkspacePage />);
    await waitFor(() => expect(activeSession()).toBe(A));
    await fireHash(`session=${B}`);
    await waitFor(() => expect(activeSession()).toBe(B));
    expect(window.location.hash).toBe(`#session=${B}`);
    await fireHash(`session=${A}`);
    await waitFor(() => expect(activeSession()).toBe(A));
    expect(callsTo(`/ai/sessions/${A}`)).toHaveLength(1); // focused, not reopened
  });

  it('a new link whose hashchange is still in flight when the previous one finishes is not overwritten', async () => {
    let release!: () => void;
    routes.set(`/ai/sessions/${A}`, () => new Promise<Response>((r) => { release = () => r(session(A)); }));
    setUrl(`#session=${A}`);
    render(<WorkspacePage />);
    await waitFor(() => expect(callsTo(`/ai/sessions/${A}`)).toHaveLength(1));
    // The user follows a link to B: the URL changes now, its hashchange is delivered later.
    window.history.replaceState(null, '', `/ai/chat#session=${B}`);
    await act(async () => { release(); });
    await waitFor(() => expect(activeSession()).toBe(A));
    await act(async () => { await Promise.resolve(); });
    expect(window.location.hash).toBe(`#session=${B}`);
    await act(async () => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    await waitFor(() => expect(activeSession()).toBe(B));
    expect(callsTo(`/ai/sessions/${B}`)).toHaveLength(1);
  });

  it('an active tab with no session clears the fragment', async () => {
    setUrl(`#session=${A}`);
    useWorkspaceStore.setState({ tabs: [tab({ id: 'empty' })], activeTabId: 'empty' });
    routes.set(`/ai/sessions/${A}`, () => json({}, 404));
    render(<WorkspacePage />);
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    await waitFor(() => expect(window.location.hash).toBe(''));
  });
});

describe('permission gate (#6498)', () => {
  it('without ai_sessions:use → AccessDenied, no request, the hash is left alone', async () => {
    perms.allow = false;
    setUrl(`#session=${A}`);
    const replace = vi.spyOn(window.history, 'replaceState');
    render(<WorkspacePage />);
    expect(screen.getByTestId('workspace-access-denied')).toBeInTheDocument();
    await act(async () => { await Promise.resolve(); });
    expect(sessionCalls()).toEqual([]);
    expect(replace).not.toHaveBeenCalled();
    expect(window.location.hash).toBe(`#session=${A}`);
  });
});

describe('Continue in side panel wiring (#9840 W3)', () => {
  it('the chat panel’s control adopts the tab’s session with its draft, then the tab closes', async () => {
    useWorkspaceStore.setState({ tabs: [tab({ id: 'ta', sessionId: A, composerDraft: 'mine' }), tab({ id: 'tb', sessionId: B })], activeTabId: 'ta' });
    render(<WorkspacePage />);
    await act(async () => { panelHarness.props!.onContinueInPanel(); });
    await waitFor(() => expect(state().tabs.map((t) => t.id)).toEqual(['tb']));
    expect(ai.adoptSession).toHaveBeenCalledWith(A, { draft: 'mine' });
    await waitFor(() => expect(window.location.hash).toBe(`#session=${B}`)); // hash follows the new active tab
  });

  it('a busy side panel asks first; confirming moves', async () => {
    Object.assign(ai, { sessionId: B, isStreaming: true });
    useWorkspaceStore.setState({ tabs: [tab({ id: 'ta', sessionId: A })], activeTabId: 'ta' });
    render(<WorkspacePage />);
    await act(async () => { panelHarness.props!.onContinueInPanel(); });
    const confirmButton = await screen.findByTestId('workspace-replace-panel-confirm');
    expect(screen.getByText('Replace the conversation in the side panel? It stays in your history.')).toBeInTheDocument();
    expect(ai.adoptSession).not.toHaveBeenCalled();
    await act(async () => { confirmButton.click(); });
    await waitFor(() => expect(ai.adoptSession).toHaveBeenCalledWith(A, { draft: '' }));
    await waitFor(() => expect(state().tabs).toEqual([]));
  });

  it('a failed adopt keeps the tab', async () => {
    ai.adoptSession.mockResolvedValueOnce('not_found');
    useWorkspaceStore.setState({ tabs: [tab({ id: 'ta', sessionId: A })], activeTabId: 'ta' });
    render(<WorkspacePage />);
    await act(async () => { panelHarness.props!.onContinueInPanel(); });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ message: "This conversation isn't available" })));
    expect(state().tabs.map((t) => t.id)).toEqual(['ta']);
  });
});
