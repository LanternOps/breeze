/**
 * #9840 W4 (Task 16): "Open a past conversation" on /workspace. Real
 * workspaceStore + aiStore, fetch mocked.
 *
 * - the "+" menu and the empty state both open the picker; without
 *   ai_sessions:use neither the picker nor its list fetch exists;
 * - a plain pick is openSession(id); every result is toasted through
 *   toastForOpenResult;
 * - a pick of the row the side panel holds is a MOVE (D3): openSession(id,
 *   { draft }) first, releaseSession(id) only after 'opened'/'focused'; any
 *   other result leaves the panel as it was; never a DELETE;
 * - the picker closes on pick, and a second pick while one is in flight is
 *   ignored (openSession on an existing tab would append the draft again).
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ allow: true }));
vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({
    permissions: perms.allow ? [{ resource: 'ai_sessions', action: 'use' }] : [],
    can: (resource: string, action: string) => perms.allow && resource === 'ai_sessions' && action === 'use',
  }),
}));
vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('@/stores/orgStore', async () => {
  const { create: mk } = await import('zustand');
  const useOrgStore = mk<{ organizations: Array<{ id: string; name: string }>; currentOrgId: string | null }>(() => ({
    organizations: [{ id: 'org-1', name: 'Acme' }], currentOrgId: 'org-1',
  }));
  return { useOrgStore };
});
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('./WorkspaceChatPanel', () => ({ default: () => <div data-testid="workspace-chat-panel" /> }));

import { fetchWithAuth } from '@/stores/auth';
import { showToast } from '../shared/Toast';
import { useAiStore } from '@/stores/aiStore';
import { useWorkspaceStore, MAX_TABS, type TabState } from '@/stores/workspaceStore';
import { abortAllAttaches } from '@/stores/aiSessionAttach';
import WorkspacePage from './WorkspacePage';

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);
const enc = new TextEncoder();

const S = '0f8fad5b-d9cb-469f-a165-70867728950e';
const P = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

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
const listRow = (id: string) => ({
  id, title: `Chat ${id.slice(0, 4)}`, status: 'active', createdAt: '2026-10-20T09:00:00.000Z',
  orgId: 'org-1', type: 'general', deviceId: null,
});

type Handler = () => Response | Promise<Response>;
let routes: Map<string, Handler>;
const urls = () => fetchMock.mock.calls.map(([u]) => String(u));
const methods = () => fetchMock.mock.calls.map(([, init]) => (init as RequestInit | undefined)?.method ?? 'GET');

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
const tabFor = (id: string) => useWorkspaceStore.getState().tabs.find((t) => t.sessionId === id);
const rowEl = (id: string) => screen.queryAllByTestId('ai-conversation-row').find((el) => el.dataset.sessionId === id);

async function openPickerFromMenu() {
  fireEvent.click(screen.getByTestId('workspace-new-tab-menu'));
  fireEvent.click(screen.getByTestId('workspace-open-past'));
  await waitFor(() => expect(rowEl(S)).toBeDefined());
}
async function pick(id: string) {
  await waitFor(() => expect(rowEl(id)).toBeDefined());
  fireEvent.click(rowEl(id)!);
}

/** The panel holds S with an unsent draft. */
const bindPanel = () => useAiStore.setState({
  isOpen: true, sessionId: S, sessionOrgId: 'org-1', hydratedSessionId: S, messages: [],
  isStreaming: false, isLoading: false, error: null, composerDraft: 'half a thought',
});

beforeEach(() => {
  vi.clearAllMocks();
  perms.allow = true;
  routes = new Map();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string | URL | Request) => {
    const h = routes.get(String(url));
    return h ? h() : json({}, 404);
  });
  routes.set('/ai/sessions?status=active', () => json({ data: [listRow(S), listRow(P)] }));
  for (const id of [S, P]) {
    routes.set(`/ai/sessions/${id}`, () => session(id));
    routes.set(`/ai/sessions/${id}/stream`, idleStream);
  }
  localStorage.clear();
  useWorkspaceStore.getState().cleanupAllStreams();
  useWorkspaceStore.setState({ tabs: [tab({ id: 'tab-1' })], activeTabId: 'tab-1' });
  useAiStore.setState({ isOpen: false, sessionId: null, composerDraft: '', isStreaming: false });
  window.history.replaceState(null, '', '/workspace');
});

afterEach(() => {
  useWorkspaceStore.getState().cleanupAllStreams();
  abortAllAttaches();
});

describe('entry points', () => {
  it('the "+" menu opens the picker', async () => {
    render(<WorkspacePage />);
    expect(screen.queryByTestId('workspace-conversation-picker')).toBeNull();
    await openPickerFromMenu();
    expect(screen.getByTestId('workspace-conversation-picker')).toBeInTheDocument();
  });

  it('the empty state opens the same picker', async () => {
    useWorkspaceStore.setState({ tabs: [], activeTabId: null });
    render(<WorkspacePage />);
    fireEvent.click(screen.getByTestId('workspace-empty-open-past'));
    expect(screen.getByTestId('workspace-conversation-picker')).toBeInTheDocument();
    await waitFor(() => expect(rowEl(S)).toBeDefined());
  });

  it('without ai_sessions:use there is no picker and no list fetch', () => {
    perms.allow = false;
    render(<WorkspacePage />);
    expect(screen.getByTestId('workspace-access-denied')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-new-tab-menu')).toBeNull();
    expect(screen.queryByTestId('workspace-conversation-picker')).toBeNull();
    expect(urls().filter((u) => u.startsWith('/ai/sessions'))).toEqual([]);
  });
});

describe('a plain pick', () => {
  it('opens a tab for the session, closes the picker, and toasts nothing', async () => {
    render(<WorkspacePage />);
    await openPickerFromMenu();
    await pick(P);
    expect(screen.queryByTestId('workspace-conversation-picker')).toBeNull();
    await waitFor(() => expect(tabFor(P)).toBeDefined());
    expect(useWorkspaceStore.getState().activeTabId).toBe(tabFor(P)!.id);
    await waitFor(() => expect(urls()).toContain(`/ai/sessions/${P}/stream`));
    expect(toastMock).not.toHaveBeenCalled();
    expect(methods()).not.toContain('DELETE');
  });

  it('a session that went away is toasted through toastForOpenResult', async () => {
    routes.set(`/ai/sessions/${P}`, () => json({ error: 'gone' }, 404));
    render(<WorkspacePage />);
    await openPickerFromMenu();
    await pick(P);
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith({ type: 'error', message: "This conversation isn't available" }));
    expect(tabFor(P)).toBeUndefined();
  });
});

describe('a pick of the row the side panel holds — a move (D3)', () => {
  it('opens the tab with the panel draft first, then releases the panel; no DELETE', async () => {
    bindPanel();
    const release = useAiStore.getState().releaseSession;
    const tabAtRelease: Array<TabState | undefined> = [];
    const releaseSpy = vi.fn((id: string) => { tabAtRelease.push(tabFor(id)); release(id); });
    useAiStore.setState({ releaseSession: releaseSpy });
    render(<WorkspacePage />);
    await openPickerFromMenu();
    expect(rowEl(S)!.querySelector('[data-testid="ai-conversation-open-elsewhere"]')).toHaveTextContent('Open in side panel');
    await pick(S);
    expect(screen.queryByTestId('workspace-conversation-picker')).toBeNull();
    await waitFor(() => expect(releaseSpy).toHaveBeenCalledWith(S));
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    // At the moment of release the destination tab already existed.
    expect(tabAtRelease[0]).toMatchObject({ sessionId: S, composerDraft: 'half a thought' });
    expect(tabFor(S)).toMatchObject({ composerDraft: 'half a thought' });
    expect(useAiStore.getState()).toMatchObject({ sessionId: null, isOpen: false, composerDraft: '' });
    expect(JSON.parse(localStorage.getItem('breeze-ai-chat') ?? '{}').state?.sessionId ?? null).toBeNull();
    expect(methods()).not.toContain('DELETE');
    expect(toastMock).not.toHaveBeenCalled();
    useAiStore.setState({ releaseSession: release });
  });

  it("'focused' (a tab already holds it) also releases the panel, and the draft lands on that tab", async () => {
    bindPanel();
    useWorkspaceStore.setState({ tabs: [tab({ id: 'tab-1' }), tab({ id: 'tab-s', sessionId: S, composerDraft: 'tab text' })], activeTabId: 'tab-1' });
    render(<WorkspacePage />);
    await openPickerFromMenu();
    await pick(S);
    await waitFor(() => expect(useAiStore.getState().sessionId).toBeNull());
    expect(useWorkspaceStore.getState().activeTabId).toBe('tab-s');
    expect(tabFor(S)!.composerDraft).toBe('tab text\nhalf a thought');
  });

  const keepsPanel = async () => {
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    expect(useAiStore.getState()).toMatchObject({ sessionId: S, isOpen: true, composerDraft: 'half a thought' });
    expect(methods()).not.toContain('DELETE');
  };

  it("'not_found' leaves the panel as it was", async () => {
    bindPanel();
    routes.set(`/ai/sessions/${S}`, () => json({ error: 'gone' }, 404));
    render(<WorkspacePage />);
    await openPickerFromMenu();
    await pick(S);
    await keepsPanel();
    expect(toastMock).toHaveBeenCalledWith({ type: 'error', message: "This conversation isn't available" });
    expect(tabFor(S)).toBeUndefined();
  });

  it("'closed' leaves the panel as it was", async () => {
    bindPanel();
    routes.set(`/ai/sessions/${S}`, () => session(S, { status: 'closed' }));
    render(<WorkspacePage />);
    await openPickerFromMenu();
    await pick(S);
    await keepsPanel();
    expect(toastMock).toHaveBeenCalledWith({ type: 'warning', message: 'This conversation was closed' });
  });

  it("'error' leaves the panel as it was", async () => {
    bindPanel();
    routes.set(`/ai/sessions/${S}`, () => json({ error: 'boom' }, 500));
    render(<WorkspacePage />);
    await openPickerFromMenu();
    await pick(S);
    await keepsPanel();
    expect(toastMock).toHaveBeenCalledWith({ type: 'error', message: "This conversation isn't available" });
  });

  it("'tab_cap' (the bar filled while the picker was open) leaves the panel as it was", async () => {
    bindPanel();
    render(<WorkspacePage />);
    await openPickerFromMenu();
    act(() => useWorkspaceStore.setState({
      tabs: Array.from({ length: MAX_TABS }, (_, i) => tab({ id: `t${i}`, sessionId: `00000000-0000-4000-8000-00000000000${i}` })),
      activeTabId: 't0',
    }));
    await pick(S);
    await keepsPanel();
    expect(toastMock).toHaveBeenCalledWith({ type: 'warning', message: 'Close a tab to open this conversation' });
  });

  it("'aborted' (logout while opening) leaves the panel to the logout, not to the move", async () => {
    bindPanel();
    let resolveGet!: (r: Response) => void;
    routes.set(`/ai/sessions/${S}`, () => new Promise<Response>((r) => { resolveGet = r; }));
    const release = useAiStore.getState().releaseSession;
    const releaseSpy = vi.fn(release);
    useAiStore.setState({ releaseSession: releaseSpy });
    render(<WorkspacePage />);
    await openPickerFromMenu();
    await pick(S);
    await waitFor(() => expect(urls()).toContain(`/ai/sessions/${S}`));
    act(() => useWorkspaceStore.getState().resetForLogout());
    await act(async () => { resolveGet(session(S)); });
    // The handler finished: the latch is open again, so a new pick goes through.
    routes.set(`/ai/sessions/${P}`, () => session(P));
    // resetForLogout emptied the tab bar, so the empty state's entry point is the one showing.
    fireEvent.click(await screen.findByTestId('workspace-empty-open-past'));
    await pick(P);
    await waitFor(() => expect(tabFor(P)).toBeDefined());
    expect(releaseSpy).not.toHaveBeenCalled();
    expect(useAiStore.getState().sessionId).toBe(S);
    expect(toastMock).not.toHaveBeenCalled();
    useAiStore.setState({ releaseSession: release });
  });

  it('a failure after the open (here: the release throws) is logged and toasted, and the latch reopens', async () => {
    bindPanel();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const release = useAiStore.getState().releaseSession;
    useAiStore.setState({ releaseSession: () => { throw new Error('boom'); } });
    render(<WorkspacePage />);
    await openPickerFromMenu();
    await pick(S);
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith({ type: 'error', message: "This conversation isn't available" }));
    expect(errSpy).toHaveBeenCalled();
    useAiStore.setState({ releaseSession: release });
    await openPickerFromMenu();
    await pick(P);
    await waitFor(() => expect(tabFor(P)).toBeDefined());
    errSpy.mockRestore();
  });

  it('a thrown openSession is an error: logged, toasted, panel kept', async () => {
    bindPanel();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const original = useWorkspaceStore.getState().openSession;
    useWorkspaceStore.setState({ openSession: vi.fn(async () => { throw new Error('chunk'); }) });
    render(<WorkspacePage />);
    await openPickerFromMenu();
    await pick(S);
    await keepsPanel();
    expect(toastMock).toHaveBeenCalledWith({ type: 'error', message: "This conversation isn't available" });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
    useWorkspaceStore.setState({ openSession: original });
  });

  it('a second pick while the first is in flight is ignored (the draft is carried once)', async () => {
    bindPanel();
    let resolveGet!: (r: Response) => void;
    routes.set(`/ai/sessions/${S}`, () => new Promise<Response>((r) => { resolveGet = r; }));
    render(<WorkspacePage />);
    await openPickerFromMenu();
    await pick(S);
    await waitFor(() => expect(urls()).toContain(`/ai/sessions/${S}`));
    await openPickerFromMenu();
    await pick(S);
    expect(screen.queryByTestId('workspace-conversation-picker')).toBeNull();
    await act(async () => { resolveGet(session(S)); });
    await waitFor(() => expect(useAiStore.getState().sessionId).toBeNull());
    expect(urls().filter((u) => u === `/ai/sessions/${S}`)).toHaveLength(1);
    expect(useWorkspaceStore.getState().tabs.filter((t) => t.sessionId === S)).toHaveLength(1);
    expect(tabFor(S)!.composerDraft).toBe('half a thought');
  });
});
