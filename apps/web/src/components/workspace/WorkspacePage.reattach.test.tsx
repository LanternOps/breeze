/**
 * #9840 W5 (Task 17, RT3 component variant; plan T17 Step 3 (c)): leaving
 * /workspace mid-turn and coming back. WorkspacePage's unmount stops every
 * tab's attach; the next mount restores each session tab by hydrating and
 * attaching again, so a turn that is still running is re-joined (one /stream
 * per tab per mount). Real workspaceStore + aiStore, fetch mocked; the store
 * semantics are in stores/aiConversationHandoff.runningTurn.test.tsx.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({
    permissions: [{ resource: 'ai_sessions', action: 'use' }],
    can: (resource: string, action: string) => resource === 'ai_sessions' && action === 'use',
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
vi.mock('../ai/AiChatMessages', () => ({ default: () => null }));
vi.mock('../ai/AiChatInput', () => ({ default: () => null }));
vi.mock('../ai/AiContextBadge', () => ({ default: () => null }));
vi.mock('../ai/AiCostIndicator', () => ({ default: () => null }));

import { fetchWithAuth } from '@/stores/auth';
import { useWorkspaceStore, type TabState } from '@/stores/workspaceStore';
import { useAiStore } from '@/stores/aiStore';
import { abortAllAttaches } from '@/stores/aiSessionAttach';
import WorkspacePage from './WorkspacePage';

const fetchMock = vi.mocked(fetchWithAuth);
const enc = new TextEncoder();

const A = '0f8fad5b-d9cb-469f-a165-70867728950e';
const B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload), body: null }) as unknown as Response;
const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
function liveSse() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(c) { ctl = c; }, cancel });
  return {
    res: { ok: true, status: 200, body } as unknown as Response,
    push: (s: string) => ctl.enqueue(enc.encode(s)),
    cancel,
  };
}
type Live = ReturnType<typeof liveSse>;
const tryPush = (live: Live, s: string) => { try { live.push(s); } catch { /* reader cancelled */ } };
const RUNNING = {
  type: 'attach_state', turn: 'running', turnId: 't1', lastSeq: 2, turnUserMessageId: 'u1', partial: false,
  replay: [{ type: 'message_start', messageId: 'am1', seq: 1 }, { type: 'content_delta', delta: 'Hel', seq: 2 }],
  pendingCards: [], activePlan: null, turnModel: null,
};
const session = (id: string) => json({
  session: { id, status: 'active', orgId: 'org-1', type: 'general', title: `Chat ${id.slice(0, 4)}` },
  messages: [{ id: 'u1', role: 'user', content: 'hello', createdAt: '2026-10-24T09:00:00.000Z' }],
});

type Handler = () => Response | Promise<Response>;
let routes: Map<string, Handler[]>;
function on(url: string, ...handlers: Handler[]) {
  routes.set(url, [...(routes.get(url) ?? []), ...handlers]);
}
const callsTo = (url: string) => fetchMock.mock.calls.filter(([u]) => String(u) === url);
const methods = () => fetchMock.mock.calls.map(([, init]) => (init as RequestInit | undefined)?.method ?? 'GET');
const settle = () => new Promise((r) => setTimeout(r, 30));

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
const tabOf = (id: string) => useWorkspaceStore.getState().tabs.find((t) => t.id === id)!;
const text = (id: string) => tabOf(id).messages.filter((m) => m.role === 'assistant').map((m) => m.content).join('');

beforeEach(() => {
  vi.clearAllMocks();
  routes = new Map();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string | URL | Request) => {
    const q = routes.get(String(url));
    if (!q || q.length === 0) return json({}, 404);
    const h = q.length > 1 ? q.shift()! : q[0]!;
    return h();
  });
  localStorage.clear();
  useWorkspaceStore.getState().cleanupAllStreams();
  useWorkspaceStore.setState({
    tabs: [tab({ id: 'ta', sessionId: A }), tab({ id: 'tb', sessionId: B })],
    activeTabId: 'ta',
  });
  useAiStore.setState({ isOpen: false, sessionId: null, composerDraft: '', isStreaming: false });
  window.history.replaceState(null, '', '/workspace');
});

afterEach(() => {
  useWorkspaceStore.getState().cleanupAllStreams();
  abortAllAttaches();
});

describe('leaving /workspace mid-turn and returning', () => {
  it('unmount stops both attaches; the next mount re-joins each running turn with one /stream per tab', async () => {
    const first = { [A]: liveSse(), [B]: liveSse() };
    const second = { [A]: liveSse(), [B]: liveSse() };
    for (const id of [A, B]) {
      on(`/ai/sessions/${id}`, () => session(id));
      on(`/ai/sessions/${id}/stream`, () => first[id]!.res, () => second[id]!.res);
    }

    const view = render(<WorkspacePage />);
    await waitFor(() => expect(callsTo(`/ai/sessions/${A}/stream`)).toHaveLength(1));
    await waitFor(() => expect(callsTo(`/ai/sessions/${B}/stream`)).toHaveLength(1));
    act(() => { first[A]!.push(frame(RUNNING)); first[B]!.push(frame(RUNNING)); });
    await waitFor(() => expect(tabOf('ta').isStreaming && tabOf('tb').isStreaming).toBe(true));
    expect(screen.getByTestId('workspace-page')).toBeInTheDocument();

    // Navigate away.
    view.unmount();
    expect(first[A]!.cancel).toHaveBeenCalled();
    expect(first[B]!.cancel).toHaveBeenCalled();
    const tabsWhileAway = useWorkspaceStore.getState().tabs;
    tryPush(first[A]!, frame({ type: 'content_delta', delta: 'STALE', seq: 3 }));
    tryPush(first[B]!, frame({ type: 'content_delta', delta: 'STALE', seq: 3 }));
    await settle();
    expect(useWorkspaceStore.getState().tabs).toBe(tabsWhileAway);

    // Come back.
    render(<WorkspacePage />);
    await waitFor(() => expect(callsTo(`/ai/sessions/${A}/stream`)).toHaveLength(2));
    await waitFor(() => expect(callsTo(`/ai/sessions/${B}/stream`)).toHaveLength(2));
    act(() => { second[A]!.push(frame(RUNNING)); second[B]!.push(frame(RUNNING)); });
    await waitFor(() => expect(text('ta')).toBe('Hel'));
    await waitFor(() => expect(text('tb')).toBe('Hel'));
    expect(tabOf('ta').isStreaming).toBe(true);
    expect(tabOf('tb').isStreaming).toBe(true);
    // A full replay is on screen: no "Joined mid-response" line.
    expect(screen.queryByTestId('workspace-joined-mid-response')).toBeNull();
    expect(useWorkspaceStore.getState().tabs.map((t) => [t.id, t.sessionId])).toEqual([['ta', A], ['tb', B]]);
    expect(useWorkspaceStore.getState().activeTabId).toBe('ta');

    act(() => {
      second[A]!.push(frame({ type: 'content_delta', delta: 'lo', seq: 3 }));
      second[A]!.push(frame({ type: 'done', seq: 4 }));
      second[B]!.push(frame({ type: 'done', seq: 3 }));
    });
    await waitFor(() => expect(tabOf('ta').isStreaming).toBe(false));
    await waitFor(() => expect(tabOf('tb').isStreaming).toBe(false));
    expect(text('ta')).toBe('Hello');
    for (const id of [A, B]) {
      expect(callsTo(`/ai/sessions/${id}/stream`)).toHaveLength(2);
      expect(callsTo(`/ai/sessions/${id}`)).toHaveLength(2);
    }
    expect(methods().filter((m) => m !== 'GET')).toEqual([]);
  });
});
