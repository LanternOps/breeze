/**
 * #9840 W4 (Task 15): the side panel's History is the shared conversation
 * list. Real aiStore + workspaceStore (the aiConversationHandoff.flows
 * harness): a pick of a row a workspace tab holds is a MOVE through W3's
 * continueInSidePanel (adopt first, close the tab only after 'ok', never a
 * DELETE, a busy panel asks first); any other pick is switchSession, as before.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('@/stores/orgStore', async () => {
  const { create: mk } = await import('zustand');
  const useOrgStore = mk<{ organizations: Array<{ id: string; name: string }>; currentOrgId: string | null }>(() => ({
    organizations: [{ id: 'org-1', name: 'Acme' }], currentOrgId: 'org-1',
  }));
  return { useOrgStore };
});
vi.mock('@/lib/permissions', () => ({ usePermissions: () => ({ permissions: [], can: () => true }) }));
// The panel's Wisp grant lookup (W05 #10136) is AiChatSidebar.wispHome.test.tsx's;
// an unresolved token keeps it out of this harness.
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => ({ status: 'unresolved' }) }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('astro:transitions/client', () => ({ navigate: vi.fn() }));
vi.mock('./AiChatMessages', () => ({ default: () => null }));
vi.mock('./AiChatInput', () => ({ default: () => null }));
vi.mock('./AiContextBadge', () => ({ default: () => null }));
vi.mock('./AiCostIndicator', () => ({ default: () => null }));
vi.mock('./AiModelPicker', () => ({ default: () => null }));
vi.mock('./AiContinuationPrompt', () => ({ default: () => null }));
vi.mock('./WispThreadHeader', () => ({ default: () => null }));
vi.mock('./WispThreadAttachments', () => ({ default: () => null }));
vi.mock('./WispConcernsPanel', () => ({ WispConcernsPanel: () => null }));

import AiChatSidebar from './AiChatSidebar';
import { fetchWithAuth } from '@/stores/auth';
import { showToast } from '@/components/shared/Toast';
import { useAiStore, type WispState } from '@/stores/aiStore';
import { useWorkspaceStore, type TabState } from '@/stores/workspaceStore';
import { abortAllAttaches } from '@/stores/aiSessionAttach';
import sidebarSrc from './AiChatSidebar.tsx?raw';
import listSrc from './AiConversationList.tsx?raw';
import sourceSrc from './useAiConversationSource.ts?raw';
import continueSrc from '../workspace/useContinueInPanel.tsx?raw';
import chipsSrc from '../workspace/WorkspaceSessionChips.tsx?raw';

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);
const enc = new TextEncoder();

const S = '0f8fad5b-d9cb-469f-a165-70867728950e';
const PANEL = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const PLAIN = '16fd2706-8baf-433b-82eb-8c7fada847da';
const CLOSED = '886313e1-3b8a-4372-9b90-0c9aee199e5d';
const TOPO = 'a8098c1a-f86e-41da-a0c4-5c4bd4e4d5f1';

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
const listRow = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: `Chat ${id.slice(0, 4)}`, status: 'active', lastActivityAt: '2026-10-20T10:00:00.000Z',
  createdAt: '2026-10-20T09:00:00.000Z', orgId: 'org-1', type: 'general', deviceId: null, ...over,
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
const wisp = (): NonNullable<WispState> => ({
  grantId: 'grant-1', threadId: 'thread-1', scopeOrgId: null, focusOrgId: null, focusOrgName: null,
  status: 'active', expiresAt: '2027-01-01T00:00:00.000Z', summary: '', budgetCentsPerDay: 200,
  floorTickMinutes: 30, wideningAvailable: false,
});

const rowEl = (id: string) => screen.getAllByTestId('ai-conversation-row').find((el) => el.dataset.sessionId === id);
async function openHistory() {
  render(<AiChatSidebar />);
  await waitFor(() => expect(rowEl(S)).toBeDefined());
}

beforeEach(() => {
  vi.clearAllMocks();
  routes = new Map();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string | URL | Request) => {
    const h = routes.get(String(url));
    return h ? h() : json({}, 404);
  });
  routes.set('/ai/sessions?status=active', () => json({
    data: [listRow(S), listRow(PANEL), listRow(PLAIN), listRow(TOPO, { type: 'topology' })],
  }));
  for (const id of [S, PANEL, PLAIN]) {
    routes.set(`/ai/sessions/${id}`, () => session(id));
    routes.set(`/ai/sessions/${id}/stream`, idleStream);
  }
  routes.set(`/ai/sessions/${TOPO}`, () => session(TOPO, { type: 'topology', topologySiteId: 'site-1' }));
  routes.set(`/ai/sessions/${TOPO}/stream`, idleStream);
  routes.set(`/ai/sessions/${CLOSED}`, () => session(CLOSED, { status: 'closed' }));
  routes.set(`/ai/sessions/${CLOSED}/stream`, idleStream);
  useWorkspaceStore.getState().cleanupAllStreams();
  useWorkspaceStore.setState({
    tabs: [tab({ id: 'tab-s', sessionId: S, composerDraft: 'from the tab' })],
    activeTabId: 'tab-s',
  });
  useAiStore.setState({
    isOpen: true, showHistory: true, sessionId: PANEL, sessionOrgId: 'org-1', hydratedSessionId: PANEL,
    messages: [], isStreaming: false, isLoading: false, error: null, errorCode: null, composerDraft: '',
    topologySiteId: null, joinedMidResponse: false, wisp: null,
  });
});

afterEach(() => {
  useWorkspaceStore.getState().cleanupAllStreams();
  abortAllAttaches();
});

describe('History list', () => {
  it('opening History sends exactly one GET /ai/sessions?status=active and lists the topology row too', async () => {
    await openHistory();
    expect(urls().filter((u) => u === '/ai/sessions?status=active')).toHaveLength(1);
    expect(urls().some((u) => u.startsWith('/ai/sessions/search'))).toBe(false);
    expect(rowEl(TOPO)).toBeDefined();
  });

  it('a row a workspace tab holds says "Open in Breeze AI"; the label follows tabs opening and closing', async () => {
    await openHistory();
    const label = (id: string) => within(rowEl(id)!).queryByTestId('ai-conversation-open-elsewhere');
    expect(label(S)).toHaveTextContent('Open in Breeze AI');
    expect(label(PLAIN)).toBeNull();
    act(() => useWorkspaceStore.setState((s) => ({ tabs: [...s.tabs, tab({ id: 'tab-p', sessionId: PLAIN })] })));
    await waitFor(() => expect(label(PLAIN)).toHaveTextContent('Open in Breeze AI'));
    act(() => useWorkspaceStore.setState((s) => ({ tabs: s.tabs.filter((t) => t.id !== 'tab-p') })));
    await waitFor(() => expect(label(PLAIN)).toBeNull());
  });

  it('closing History resets the search query (was toggleHistory clearing searchResults)', async () => {
    await openHistory();
    fireEvent.change(screen.getByTestId('ai-conversation-search'), { target: { value: 'pa' } });
    act(() => useAiStore.getState().toggleHistory());
    expect(screen.queryByTestId('ai-conversation-search')).toBeNull();
    act(() => useAiStore.getState().toggleHistory());
    await waitFor(() => expect(screen.getByTestId('ai-conversation-search')).toHaveValue(''));
  });
});

describe('picking a row a workspace tab holds — a move (D3)', () => {
  it('adopts first, closes the tab only after ok, binds the panel with the tab draft, and never DELETEs', async () => {
    let tabsWhenAdopted: string[] | null = null;
    routes.set(`/ai/sessions/${S}`, () => {
      tabsWhenAdopted = useWorkspaceStore.getState().tabs.map((t) => t.id);
      return session(S);
    });
    await openHistory();
    fireEvent.click(rowEl(S)!);
    await waitFor(() => expect(useWorkspaceStore.getState().tabs).toHaveLength(0));
    expect(tabsWhenAdopted).toEqual(['tab-s']);
    expect(useAiStore.getState()).toMatchObject({ sessionId: S, isOpen: true, composerDraft: 'from the tab', showHistory: false });
    expect(urls()).toContain(`/ai/sessions/${S}/stream`);
    expect(methods()).not.toContain('DELETE');
  });

  it('a 404 on adopt keeps the tab and the panel as they were, and says so', async () => {
    routes.set(`/ai/sessions/${S}`, () => json({ error: 'not found' }, 404));
    await openHistory();
    fireEvent.click(rowEl(S)!);
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: "This conversation isn't available",
    })));
    expect(useWorkspaceStore.getState().tabs.map((t) => t.id)).toEqual(['tab-s']);
    expect(useAiStore.getState().sessionId).toBe(PANEL);
    expect(methods()).not.toContain('DELETE');
  });

  it('a busy panel (another session, unsent text) asks first; cancel changes nothing', async () => {
    useAiStore.setState({ composerDraft: 'unsent words' });
    await openHistory();
    fireEvent.click(rowEl(S)!);
    const confirm = await screen.findByTestId('workspace-replace-panel-confirm');
    expect(screen.getByText('Replace the conversation in the side panel? It stays in your history.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByTestId('workspace-replace-panel-confirm')).toBeNull());
    expect(confirm).toBeDefined();
    expect(urls()).not.toContain(`/ai/sessions/${S}`);
    expect(useWorkspaceStore.getState().tabs.map((t) => t.id)).toEqual(['tab-s']);
    expect(useAiStore.getState()).toMatchObject({ sessionId: PANEL, composerDraft: 'unsent words' });
  });

  it('a busy panel: confirming completes the move', async () => {
    useAiStore.setState({ composerDraft: 'unsent words' });
    await openHistory();
    fireEvent.click(rowEl(S)!);
    fireEvent.click(await screen.findByTestId('workspace-replace-panel-confirm'));
    await waitFor(() => expect(useWorkspaceStore.getState().tabs).toHaveLength(0));
    expect(useAiStore.getState()).toMatchObject({ sessionId: S, composerDraft: 'from the tab' });
    expect(methods()).not.toContain('DELETE');
  });

  it('a panel in Wisp mode that takes a plain workspace conversation leaves Wisp mode (#10032)', async () => {
    useAiStore.setState({ wisp: wisp() });
    await openHistory();
    fireEvent.click(rowEl(S)!);
    await waitFor(() => expect(useAiStore.getState().sessionId).toBe(S));
    expect(useAiStore.getState().wisp).toBeNull();
  });
});

describe('any other pick — switchSession, as before', () => {
  it('a plain row binds the panel (GET then one attach) and leaves the tabs alone', async () => {
    await openHistory();
    fireEvent.click(rowEl(PLAIN)!);
    await waitFor(() => expect(useAiStore.getState().sessionId).toBe(PLAIN));
    await waitFor(() => expect(urls().filter((u) => u === `/ai/sessions/${PLAIN}/stream`)).toHaveLength(1));
    expect(urls().filter((u) => u === `/ai/sessions/${PLAIN}`)).toHaveLength(1);
    expect(useWorkspaceStore.getState().tabs.map((t) => t.id)).toEqual(['tab-s']);
    expect(useAiStore.getState().showHistory).toBe(false);
  });

  it('a topology row opens in the panel', async () => {
    await openHistory();
    fireEvent.click(rowEl(TOPO)!);
    await waitFor(() => expect(useAiStore.getState().sessionId).toBe(TOPO));
    expect(useAiStore.getState().topologySiteId).toBe('site-1');
  });

  it('a closed search hit still opens in the panel', async () => {
    routes.set('/ai/sessions/search?q=old&limit=20', () => json({
      data: [{ id: CLOSED, title: 'Old', matchedContent: 'old words', createdAt: '2026-01-01T00:00:00.000Z', status: 'closed', type: 'general', orgId: 'org-1', deviceId: null }],
    }));
    await openHistory();
    fireEvent.change(screen.getByTestId('ai-conversation-search'), { target: { value: 'old' } });
    await waitFor(() => expect(rowEl(CLOSED)).toBeDefined(), { timeout: 2000 });
    fireEvent.click(rowEl(CLOSED)!);
    await waitFor(() => expect(useAiStore.getState().sessionId).toBe(CLOSED));
  });
});

describe('bundle boundary', () => {
  // The side panel's bundle must not carry workspaceStore statically; the list
  // reads the tabs through a dynamic import.
  const staticImport = /^\s*import\s+(?!type\b)[^;]*?from\s+['"][^'"]*workspaceStore['"]/m;
  it.each([
    ['AiChatSidebar.tsx', sidebarSrc],
    ['AiConversationList.tsx', listSrc],
    ['useAiConversationSource.ts', sourceSrc],
    ['useContinueInPanel.tsx', continueSrc],
    ['WorkspaceSessionChips.tsx', chipsSrc],
  ])('%s has no static workspaceStore import', (_name, src) => {
    expect(src).not.toMatch(staticImport);
  });
});
