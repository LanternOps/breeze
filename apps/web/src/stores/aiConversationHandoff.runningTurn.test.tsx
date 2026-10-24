/**
 * #9840 W5 (Task 17): moving a conversation WHILE ITS TURN RUNS, proven
 * through the real aiStore + workspaceStore + hand-off module against a mocked
 * attach stream (GET /ai/sessions/:id/stream). No lab stack here can run a
 * turn (the AI keys are blanked), so this is where the running-turn semantics
 * of spec §3.5/§8 and plan T17 Step 3 (a) and (c) are pinned; the live legs are
 * on the real-key checklist
 * (docs/superpowers/plans/ai-mcp/2026-10-25-ai-chat-move-conversations-lab-checklist.md).
 *
 * Every assertion reads store state (or the rendered DOM) produced by the
 * snapshot/live frames flowing attachAiSession → processStreamEvent → store —
 * never the fixture object itself. The destination side of a panel → workspace
 * move is driven exactly as WorkspaceSessionLink drives it (takeHandoff →
 * openSession(id, { draft, signal }) → completeHandoff on 'opened').
 *
 * RT1 panel → workspace mid-turn, approval pending, approve from the tab (leg a)
 * RT2 workspace → panel mid-turn (the reverse of leg a)
 * RT3 leave /workspace mid-turn and return (leg c; component variant in
 *     components/workspace/WorkspacePage.reattach.test.tsx)
 * RT4 a partial join (replay over the byte cap) on both surfaces
 * RT5 a send from the destination while a turn runs elsewhere → 409 cycle
 * RT6 a hand-off that never completes mid-turn (Review Focus 2)
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('./orgStore', async () => {
  const { create: mk } = await import('zustand');
  const useOrgStore = mk<{ organizations: Array<{ id: string; name: string }>; currentOrgId: string | null }>(() => ({
    organizations: [{ id: 'org-1', name: 'Acme' }], currentOrgId: 'org-1',
  }));
  return { useOrgStore };
});
vi.mock('../components/shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('astro:transitions/client', () => ({ navigate: vi.fn() }));
vi.mock('@/lib/permissions', () => ({ usePermissions: () => ({ permissions: [], can: () => true }) }));
// Surface children that are irrelevant to the joined-mid-response line (RT4).
vi.mock('../components/ai/AiChatMessages', () => ({ default: () => null }));
vi.mock('../components/ai/AiChatInput', () => ({ default: () => null }));
vi.mock('../components/ai/AiContextBadge', () => ({ default: () => null }));
vi.mock('../components/ai/AiCostIndicator', () => ({ default: () => null }));
vi.mock('../components/ai/AiModelPicker', () => ({ default: () => null }));
vi.mock('../components/ai/AiContinuationPrompt', () => ({ default: () => null }));
vi.mock('../components/ai/WispToggle', () => ({ default: () => null }));
vi.mock('../components/ai/WispThreadHeader', () => ({ default: () => null }));
vi.mock('../components/ai/WispThreadAttachments', () => ({ default: () => null }));
vi.mock('../components/ai/WispConcernsPanel', () => ({ WispConcernsPanel: () => null }));
vi.mock('../components/workspace/WorkspaceSessionChips', () => ({ default: () => null }));

import { navigate } from 'astro:transitions/client';
import { fetchWithAuth } from './auth';
import { useAiStore } from './aiStore';
import { useWorkspaceStore, type TabState } from './workspaceStore';
import { abortAllAttaches } from './aiSessionAttach';
import type { AiMessage } from './processStreamEvent';
import {
  HANDOFF_TIMEOUT_MS,
  abortHandoff,
  completeHandoff,
  continueInSidePanel,
  moveToAssistant,
  takeHandoff,
} from './aiConversationHandoff';
import AiChatSidebar from '../components/ai/AiChatSidebar';
import WorkspaceChatPanel from '../components/workspace/WorkspaceChatPanel';

const fetchMock = vi.mocked(fetchWithAuth);
const navigateMock = vi.mocked(navigate);
const enc = new TextEncoder();

const S = '0f8fad5b-d9cb-469f-a165-70867728950e';
const S2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
/** The approval's deadline as the server set it before the move. */
const DEADLINE = '2026-10-25T10:00:00.000Z';

// ── HTTP + SSE doubles (shapes from workspaceStore.attach.test.ts) ──────────

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload), body: null }) as unknown as Response;
const frame = (data: unknown, event?: string) =>
  `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
/** A held SSE body: frames are pushed by the test; `cancel` records a reader cancel. */
function liveSse() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(c) { ctl = c; }, cancel });
  return {
    res: { ok: true, status: 200, body } as unknown as Response,
    push: (s: string) => ctl.enqueue(enc.encode(s)),
    end: () => ctl.close(),
    cancel,
  };
}
type Live = ReturnType<typeof liveSse>;
/** A frame on a stream whose reader may already be cancelled (then it is simply dropped). */
const tryPush = (live: Live, s: string) => { try { live.push(s); } catch { /* reader cancelled */ } };
const sse = (...frames: string[]) => {
  const s = liveSse();
  for (const f of frames) s.push(f);
  s.end();
  return s.res;
};

// ── The running turn ────────────────────────────────────────────────────────

/** The approval card the turn is waiting on (tier 2, device-bound). */
const CARD = {
  type: 'approval_required', executionId: 'ex1', toolName: 'restart_service',
  input: { serviceName: 'Spooler' }, description: 'Restart the Print Spooler service',
  approvalExpiresAt: DEADLINE, intentBacked: false,
} as const;
/**
 * attach_state of turn t1: the reply so far is "Hel", the model called
 * restart_service and the turn is parked on its tier-2 approval.
 */
const RUNNING = (over: Record<string, unknown> = {}) => ({
  type: 'attach_state', turn: 'running', turnId: 't1', lastSeq: 3, turnUserMessageId: 'u1', partial: false,
  replay: [
    { type: 'message_start', messageId: 'am1', seq: 1 },
    { type: 'content_delta', delta: 'Hel', seq: 2 },
    { type: 'tool_use_start', toolUseId: 'tu1', toolName: 'restart_service', input: {}, seq: 3 },
  ],
  pendingCards: [CARD], activePlan: null, turnModel: null, ...over,
});
/** Over the replay byte cap: no replay, the reply so far is not sent. */
const PARTIAL = () => RUNNING({ partial: true, replay: [], lastSeq: 5 });
const IDLE = () => ({
  type: 'attach_state', turn: 'idle', turnId: null, lastSeq: 0, turnUserMessageId: null,
  partial: false, replay: [], pendingCards: [], activePlan: null, turnModel: null,
});
const HYDRATED = [{ id: 'u1', role: 'user', content: 'hello', createdAt: '2026-10-24T09:00:00.000Z' }];
/** A device-bound general session, as GET /ai/sessions/:id serves it. */
const session = (id: string, over: Record<string, unknown> = {}) => json({
  session: { id, status: 'active', orgId: 'org-1', type: 'general', title: 'Restart the spooler', deviceId: 'dev-1', ...over },
  messages: HYDRATED,
});

// ── Routing + call bookkeeping ──────────────────────────────────────────────

type Handler = () => Response | Promise<Response>;
let routes: Map<string, Handler[]>;
/** Handlers answer in order; the last one keeps answering. */
function on(url: string, ...handlers: Handler[]) {
  routes.set(url, [...(routes.get(url) ?? []), ...handlers]);
}
const init = (call: unknown[]) => call[1] as RequestInit | undefined;
const methodsCalled = () => fetchMock.mock.calls.map((c) => init(c)?.method ?? 'GET');
const callsTo = (url: string) => fetchMock.mock.calls.filter(([u]) => String(u) === url);
const streamCalls = (id: string) => callsTo(`/ai/sessions/${id}/stream`);
const sessionGets = (id: string) => callsTo(`/ai/sessions/${id}`).filter((c) => !init(c)?.method);
const posts = () => fetchMock.mock.calls
  .filter((c) => init(c)?.method === 'POST')
  .map((c) => ({ url: String(c[0]), body: init(c)?.body }));
/** Lets every queued read/microtask run (for "nothing happened" assertions). */
const settle = () => new Promise((r) => setTimeout(r, 30));

const assistantText = (messages: AiMessage[]) =>
  messages.filter((m) => m.role === 'assistant').map((m) => m.content).join('');
const tabOf = (id: string) => useWorkspaceStore.getState().tabs.find((t) => t.id === id);
const tabFor = (sessionId: string) => useWorkspaceStore.getState().tabs.find((t) => t.sessionId === sessionId);
const persistedPanel = () => JSON.parse(localStorage.getItem('breeze-ai-chat') ?? '{}').state ?? {};

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

/** The side panel binds S (History pick) and joins its running turn. */
async function panelJoinsRunningTurn(live: Live) {
  await useAiStore.getState().switchSession(S);
  await vi.waitFor(() => expect(streamCalls(S)).toHaveLength(1));
  live.push(frame(RUNNING()));
  await vi.waitFor(() => expect(useAiStore.getState().pendingApproval?.executionId).toBe('ex1'));
}

/** A workspace tab opens S and joins its running turn; returns the tab id. */
async function tabJoinsRunningTurn(live: Live, draft?: string) {
  const before = streamCalls(S).length;
  const opening = useWorkspaceStore.getState().openSession(S, draft === undefined ? {} : { draft });
  await vi.waitFor(() => expect(streamCalls(S)).toHaveLength(before + 1));
  live.push(frame(RUNNING()));
  await expect(opening).resolves.toBe('opened');
  return tabFor(S)!.id;
}

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
  useWorkspaceStore.setState({ tabs: [], activeTabId: null });
  useAiStore.setState({
    isOpen: true, sessionId: null, sessionOrgId: null, hydratedSessionId: null, messages: [],
    isStreaming: false, isLoading: false, error: null, errorCode: null, composerDraft: '',
    pendingApproval: null, pendingPlan: null, activePlan: null, showHistory: false,
    topologySiteId: null, joinedMidResponse: false, wisp: null,
  });
  window.history.replaceState(null, '', '/devices');
});

afterEach(() => {
  abortHandoff(S);
  abortHandoff(S2);
  useWorkspaceStore.getState().cleanupAllStreams();
  abortAllAttaches();
  vi.useRealTimers();
});

describe('RT1 panel → workspace mid-turn, approval pending, approved from the destination (plan T17 Step 3 (a))', () => {
  it('the tab holds the card with its original deadline before the panel lets go; one attach each, never a re-send; the approval and the rest of the reply land in the tab', async () => {
    const panelLive = liveSse();
    const tabLive = liveSse();
    on(`/ai/sessions/${S}`, () => session(S));
    on(`/ai/sessions/${S}/stream`, () => panelLive.res, () => tabLive.res);
    on(`/ai/sessions/${S}/approve/ex1`, () => json({ success: true }));

    await panelJoinsRunningTurn(panelLive);
    expect(useAiStore.getState()).toMatchObject({ sessionId: S, isStreaming: true });
    expect(useAiStore.getState().pendingApproval?.approvalExpiresAt).toBe(DEADLINE);
    expect(assistantText(useAiStore.getState().messages)).toBe('Hel');
    useAiStore.getState().setComposerDraft('d');

    // What the workspace looked like at the instant the panel let go.
    let atRelease: { tab: TabState | null; panelReaderCancelled: boolean } | null = null;
    const unsubscribe = useAiStore.subscribe((state, prev) => {
      if (atRelease === null && prev.sessionId === S && state.sessionId === null) {
        atRelease = { tab: tabFor(S) ?? null, panelReaderCancelled: panelLive.cancel.mock.calls.length > 0 };
      }
    });

    const moved = moveToAssistant(S, { draft: useAiStore.getState().composerDraft });
    await vi.waitFor(() => expect(navigateMock).toHaveBeenCalledWith(`/workspace#session=${S}`));

    // The destination, exactly as WorkspaceSessionLink drives it.
    const handed = takeHandoff(S);
    expect(handed?.draft).toBe('d');
    const opening = useWorkspaceStore.getState().openSession(S, { draft: handed!.draft, signal: handed!.signal });
    await vi.waitFor(() => expect(streamCalls(S)).toHaveLength(2));
    // The tab's attach is not ready yet: the origin still holds the running turn.
    expect(useAiStore.getState()).toMatchObject({ sessionId: S, isOpen: true, isStreaming: true });
    tabLive.push(frame(RUNNING()));
    await expect(opening).resolves.toBe('opened');
    expect(useAiStore.getState().sessionId).toBe(S); // only completeHandoff releases
    completeHandoff(S);
    await expect(moved).resolves.toBe('moved');
    unsubscribe();

    // Destination ready first (D3): at release the tab already held the
    // running turn, the card with the ORIGINAL deadline, and the draft.
    expect(atRelease).not.toBeNull();
    const t = atRelease!.tab;
    expect(t).not.toBeNull();
    expect(t!.pendingApproval).toMatchObject({ executionId: 'ex1', toolName: 'restart_service', approvalExpiresAt: DEADLINE });
    expect(t!.isStreaming).toBe(true);
    expect(t!.composerDraft).toBe('d');
    expect(assistantText(t!.messages)).toBe('Hel'); // the replay was folded, not re-sent
    expect(t!.deviceId).toBe('dev-1'); // the device binding came along

    // The panel's reader was cancelled as part of the release, not later.
    expect(panelLive.cancel).toHaveBeenCalled();
    expect(useAiStore.getState()).toMatchObject({ sessionId: null, isOpen: false, isStreaming: false, pendingApproval: null, composerDraft: '' });
    expect(persistedPanel().sessionId ?? null).toBeNull();

    // Attached, never re-sent, never deleted: two hydrates, two attaches, no POST.
    expect(methodsCalled()).not.toContain('DELETE');
    expect(posts()).toEqual([]);
    expect(streamCalls(S)).toHaveLength(2);
    expect(sessionGets(S)).toHaveLength(2);

    // A frame still in flight on the panel's old stream writes nowhere.
    const tabBefore = tabFor(S)!;
    tryPush(panelLive, frame({ type: 'content_delta', delta: 'STALE', seq: 4 }));
    await settle();
    expect(useAiStore.getState().messages).toEqual([]);
    expect(tabFor(S)).toBe(tabBefore);

    // The tab composer does not send into a running turn.
    await useWorkspaceStore.getState().sendMessage(tabBefore.id, 'too early');
    expect(posts()).toEqual([]);

    // Approve from the destination: to the executionId the snapshot carried.
    await useWorkspaceStore.getState().approveExecution(tabBefore.id, 'ex1', true);
    expect(posts()).toEqual([{ url: `/ai/sessions/${S}/approve/ex1`, body: JSON.stringify({ approved: true }) }]);
    expect(tabFor(S)!.pendingApproval).toBeNull();

    // The tool runs and the reply finishes in the tab, on the same attach.
    tabLive.push(frame({ type: 'tool_result', toolUseId: 'tu1', output: { restarted: true }, isError: false, seq: 4 }));
    tabLive.push(frame({ type: 'content_delta', delta: 'lo', seq: 5 }));
    tabLive.push(frame({ type: 'done', seq: 6 }));
    await vi.waitFor(() => expect(tabFor(S)!.isStreaming).toBe(false));
    expect(assistantText(tabFor(S)!.messages)).toBe('Hello');
    expect(tabFor(S)!.messages.some((m) => m.role === 'tool_result' && m.toolUseId === 'tu1')).toBe(true);
    expect(tabFor(S)!.pendingApproval).toBeNull();
    expect(streamCalls(S)).toHaveLength(2);
    expect(sessionGets(S)).toHaveLength(2); // a full replay needs no re-read on done
    expect(useAiStore.getState().messages).toEqual([]);
    expect(methodsCalled()).not.toContain('DELETE');
  });
});

describe('RT2 workspace → panel mid-turn (the reverse of leg (a))', () => {
  it('the tab closes only once the panel holds the running turn and its card; the tab’s old stream writes nothing; the reply finishes in the panel', async () => {
    const tabLive = liveSse();
    const panelLive = liveSse();
    on(`/ai/sessions/${S}`, () => session(S));
    on(`/ai/sessions/${S}/stream`, () => tabLive.res, () => panelLive.res);
    const tabId = await tabJoinsRunningTurn(tabLive, 'tab draft');
    expect(tabOf(tabId)).toMatchObject({ isStreaming: true, composerDraft: 'tab draft' });
    expect(tabOf(tabId)!.pendingApproval?.executionId).toBe('ex1');
    useAiStore.setState({ isOpen: false });

    let atClose: ReturnType<typeof useAiStore.getState> | null = null;
    const unsubscribe = useWorkspaceStore.subscribe((state, prev) => {
      if (atClose === null && prev.tabs.some((t) => t.id === tabId) && !state.tabs.some((t) => t.id === tabId)) {
        atClose = useAiStore.getState();
      }
    });

    const confirm = vi.fn(async () => true);
    const moving = continueInSidePanel(tabId, { confirm });
    await vi.waitFor(() => expect(streamCalls(S)).toHaveLength(2));
    // The panel's attach is not ready yet: the tab still holds the turn.
    expect(tabOf(tabId)).toMatchObject({ sessionId: S, isStreaming: true });
    panelLive.push(frame(RUNNING()));
    await expect(moving).resolves.toBe('moved');
    unsubscribe();

    expect(confirm).not.toHaveBeenCalled(); // the panel was empty
    expect(atClose).not.toBeNull();
    const p = atClose!;
    expect(p.sessionId).toBe(S);
    expect(p.isOpen).toBe(true);
    expect(p.isStreaming).toBe(true);
    expect(p.pendingApproval).toMatchObject({ executionId: 'ex1', approvalExpiresAt: DEADLINE });
    expect(p.composerDraft).toBe('tab draft');
    expect(assistantText(p.messages)).toBe('Hel');
    expect(useWorkspaceStore.getState().tabs).toEqual([]);
    expect(tabLive.cancel).toHaveBeenCalled();

    // A frame still in flight on the tab's old stream writes nowhere.
    const panelMessages = useAiStore.getState().messages;
    tryPush(tabLive, frame({ type: 'content_delta', delta: 'STALE', seq: 4 }));
    await settle();
    expect(useAiStore.getState().messages).toBe(panelMessages);
    expect(useWorkspaceStore.getState().tabs).toEqual([]);

    // Decided elsewhere (e.g. the Approvals queue): the tool's result lands on
    // the panel's attach and withdraws the card; then the reply finishes.
    panelLive.push(frame({ type: 'tool_result', toolUseId: 'tu1', output: { restarted: true }, isError: false, seq: 4 }));
    panelLive.push(frame({ type: 'content_delta', delta: 'lo', seq: 5 }));
    panelLive.push(frame({ type: 'done', seq: 6 }));
    await vi.waitFor(() => expect(useAiStore.getState().isStreaming).toBe(false));
    expect(assistantText(useAiStore.getState().messages)).toBe('Hello');
    expect(useAiStore.getState().pendingApproval).toBeNull();
    expect(methodsCalled()).not.toContain('DELETE');
    expect(posts()).toEqual([]);
    expect(streamCalls(S)).toHaveLength(2);
  });
});

describe('RT3 leave /workspace mid-turn and return (plan T17 Step 3 (c))', () => {
  it('cleanup stops both attaches (old frames write nothing); the return re-hydrates and re-attaches each tab to the still-running turn', async () => {
    const first = { [S]: liveSse(), [S2]: liveSse() };
    const second = { [S]: liveSse(), [S2]: liveSse() };
    for (const id of [S, S2]) {
      on(`/ai/sessions/${id}`, () => session(id));
      on(`/ai/sessions/${id}/stream`, () => first[id]!.res, () => second[id]!.res);
    }
    useWorkspaceStore.setState({
      tabs: [tab({ id: 'a', sessionId: S }), tab({ id: 'b', sessionId: S2 })],
      activeTabId: 'a',
    });

    const restored = useWorkspaceStore.getState().restoreWorkspace();
    await vi.waitFor(() => expect(streamCalls(S)).toHaveLength(1));
    await vi.waitFor(() => expect(streamCalls(S2)).toHaveLength(1));
    first[S]!.push(frame(RUNNING()));
    first[S2]!.push(frame(RUNNING()));
    await restored;
    for (const id of ['a', 'b']) {
      expect(tabOf(id)).toMatchObject({ isStreaming: true });
      expect(tabOf(id)!.pendingApproval?.executionId).toBe('ex1');
    }

    // Leaving /workspace: WorkspacePage's unmount calls cleanupAllStreams.
    useWorkspaceStore.getState().cleanupAllStreams();
    expect(first[S]!.cancel).toHaveBeenCalled();
    expect(first[S2]!.cancel).toHaveBeenCalled();
    const before = useWorkspaceStore.getState().tabs;
    tryPush(first[S]!, frame({ type: 'content_delta', delta: 'STALE', seq: 4 }));
    tryPush(first[S2]!, frame({ type: 'content_delta', delta: 'STALE', seq: 4 }));
    await settle();
    expect(useWorkspaceStore.getState().tabs).toBe(before);

    // Returning: the turn ran on while we were away (lastSeq advanced).
    const advanced = () => RUNNING({
      lastSeq: 4,
      replay: [...(RUNNING().replay as unknown[]), { type: 'content_delta', delta: 'lo', seq: 4 }],
    });
    const restoredAgain = useWorkspaceStore.getState().restoreWorkspace();
    await vi.waitFor(() => expect(streamCalls(S)).toHaveLength(2));
    await vi.waitFor(() => expect(streamCalls(S2)).toHaveLength(2));
    second[S]!.push(frame(advanced()));
    second[S2]!.push(frame(advanced()));
    await restoredAgain;
    for (const id of ['a', 'b']) {
      const t = tabOf(id)!;
      expect(t.isStreaming).toBe(true);
      expect(t.pendingApproval).toMatchObject({ executionId: 'ex1', approvalExpiresAt: DEADLINE });
      expect(t.messages.filter((m) => m.role === 'assistant')).toHaveLength(1); // re-hydrated, not doubled
      expect(assistantText(t.messages)).toBe('Hello');
    }

    second[S]!.push(frame({ type: 'done', seq: 5 }));
    second[S2]!.push(frame({ type: 'done', seq: 5 }));
    await vi.waitFor(() => expect(tabOf('a')!.isStreaming).toBe(false));
    await vi.waitFor(() => expect(tabOf('b')!.isStreaming).toBe(false));
    for (const id of [S, S2]) {
      expect(streamCalls(id)).toHaveLength(2); // one before leaving, one after returning
      expect(sessionGets(id)).toHaveLength(2);
    }
    expect(useWorkspaceStore.getState().tabs.map((t) => [t.id, t.sessionId])).toEqual([['a', S], ['b', S2]]);
    expect(posts()).toEqual([]);
    expect(methodsCalled()).not.toContain('DELETE');
  });
});

describe('RT4 a partial join (replay over the byte cap), both surfaces', () => {
  function TabView() {
    const t = useWorkspaceStore((s) => s.tabs[0]);
    return t ? <WorkspaceChatPanel tab={t} /> : null;
  }

  it('workspace tab: placeholder + "Joined mid-response" line, live deltas fill it, done clears the line and re-reads the messages once', async () => {
    const live = liveSse();
    on(`/ai/sessions/${S}`, () => session(S));
    on(`/ai/sessions/${S}/stream`, () => live.res);
    const opening = useWorkspaceStore.getState().openSession(S);
    await vi.waitFor(() => expect(streamCalls(S)).toHaveLength(1));
    live.push(frame(PARTIAL()));
    await expect(opening).resolves.toBe('opened');
    render(<TabView />);

    const t = tabFor(S)!;
    expect(t.joinedMidResponse).toBe(true);
    expect(t.isStreaming).toBe(true);
    const placeholder = t.messages[t.messages.length - 1]!;
    expect(placeholder).toMatchObject({ role: 'assistant', content: '', isStreaming: true });
    expect(screen.getByTestId('workspace-joined-mid-response')).toHaveTextContent(
      'Joined mid-response. The full reply appears when it finishes.',
    );

    live.push(frame({ type: 'content_delta', delta: 'tail', seq: 6 }));
    await vi.waitFor(() => expect(tabFor(S)!.messages.find((m) => m.id === placeholder.id)?.content).toBe('tail'));
    expect(sessionGets(S)).toHaveLength(1);

    live.push(frame({ type: 'done', seq: 7 }));
    await vi.waitFor(() => expect(sessionGets(S)).toHaveLength(2));
    await vi.waitFor(() => expect(screen.queryByTestId('workspace-joined-mid-response')).toBeNull());
    expect(tabFor(S)).toMatchObject({ joinedMidResponse: false, isStreaming: false });
    expect(streamCalls(S)).toHaveLength(1);
  });

  it('side panel: the same, through adoptSession (a move into the panel)', async () => {
    const live = liveSse();
    on(`/ai/sessions/${S}`, () => session(S));
    on(`/ai/sessions/${S}/stream`, () => live.res);
    const adopting = useAiStore.getState().adoptSession(S, { draft: '' });
    await vi.waitFor(() => expect(streamCalls(S)).toHaveLength(1));
    live.push(frame(PARTIAL()));
    await expect(adopting).resolves.toBe('ok');
    render(<AiChatSidebar />);

    const panel = useAiStore.getState();
    expect(panel.joinedMidResponse).toBe(true);
    expect(panel.isStreaming).toBe(true);
    const placeholder = panel.messages[panel.messages.length - 1]!;
    expect(placeholder).toMatchObject({ role: 'assistant', content: '', isStreaming: true });
    expect(screen.getByTestId('ai-joined-mid-response')).toHaveTextContent(
      'Joined mid-response. The full reply appears when it finishes.',
    );

    live.push(frame({ type: 'content_delta', delta: 'tail', seq: 6 }));
    await vi.waitFor(() =>
      expect(useAiStore.getState().messages.find((m) => m.id === placeholder.id)?.content).toBe('tail'));
    expect(sessionGets(S)).toHaveLength(1);

    live.push(frame({ type: 'done', seq: 7 }));
    await vi.waitFor(() => expect(sessionGets(S)).toHaveLength(2));
    await waitFor(() => expect(screen.queryByTestId('ai-joined-mid-response')).toBeNull());
    expect(useAiStore.getState()).toMatchObject({ joinedMidResponse: false, isStreaming: false });
    expect(streamCalls(S)).toHaveLength(1);
  });
});

describe('RT5 a send from the destination while a turn runs elsewhere (Gate B #7 across surfaces)', () => {
  it('409 turn_in_progress → no error, bubble dropped, text back in the tab composer, one more attach that joins the running turn', async () => {
    // The tab joined while the session was idle (its composer is enabled);
    // the turn was then started from the other surface (another browser tab).
    const joined = liveSse();
    on(`/ai/sessions/${S}`, () => session(S));
    on(`/ai/sessions/${S}/stream`, () => sse(frame(IDLE())), () => joined.res);
    on(`/ai/sessions/${S}/messages`, () => json({ code: 'turn_in_progress', error: 'busy' }, 409));
    await expect(useWorkspaceStore.getState().openSession(S)).resolves.toBe('opened');
    const tabId = tabFor(S)!.id;
    expect(tabOf(tabId)!.isStreaming).toBe(false);
    expect(streamCalls(S)).toHaveLength(1);

    await useWorkspaceStore.getState().sendMessage(tabId, 'the text');
    const t = tabOf(tabId)!;
    expect(t.error).toBeNull();
    expect(t.errorAction).toBeNull();
    expect(t.composerDraft).toBe('the text');
    expect(t.messages.map((m) => m.id)).toEqual(['u1']); // the refused bubble is gone
    expect(posts().map((p) => p.url)).toEqual([`/ai/sessions/${S}/messages`]);

    await vi.waitFor(() => expect(streamCalls(S)).toHaveLength(2));
    joined.push(frame(RUNNING()));
    await vi.waitFor(() => expect(tabOf(tabId)!.pendingApproval?.executionId).toBe('ex1'));
    expect(tabOf(tabId)).toMatchObject({ isStreaming: true, error: null, composerDraft: 'the text' });
    expect(assistantText(tabOf(tabId)!.messages)).toBe('Hel');
    joined.push(frame({ type: 'done', seq: 4 }));
    await vi.waitFor(() => expect(tabOf(tabId)!.isStreaming).toBe(false));
    expect(streamCalls(S)).toHaveLength(2);
    expect(posts()).toHaveLength(1); // the refused text was not re-sent
  });
});

describe('RT6 the hand-off never completes mid-turn (Review Focus 2)', () => {
  it('after HANDOFF_TIMEOUT_MS the panel still holds the running turn and its attach keeps applying frames', async () => {
    const panelLive = liveSse();
    on(`/ai/sessions/${S}`, () => session(S));
    on(`/ai/sessions/${S}/stream`, () => panelLive.res);
    await panelJoinsRunningTurn(panelLive);
    useAiStore.getState().setComposerDraft('d');

    vi.useFakeTimers();
    const moved = moveToAssistant(S, { draft: 'd' });
    await vi.waitFor(() => expect(navigateMock).toHaveBeenCalled());
    // The workspace never mounts: no openSession, no completeHandoff.
    await vi.advanceTimersByTimeAsync(HANDOFF_TIMEOUT_MS + 1);
    await expect(moved).resolves.toBe('aborted');
    vi.useRealTimers();

    expect(useAiStore.getState()).toMatchObject({ sessionId: S, isOpen: true, isStreaming: true, composerDraft: 'd' });
    expect(useAiStore.getState().pendingApproval).toMatchObject({ executionId: 'ex1', approvalExpiresAt: DEADLINE });
    expect(panelLive.cancel).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().tabs).toEqual([]);

    // The origin's attach was never cancelled: live frames still apply.
    panelLive.push(frame({ type: 'content_delta', delta: 'lo', seq: 4 }));
    await vi.waitFor(() => expect(assistantText(useAiStore.getState().messages)).toBe('Hello'));
    panelLive.push(frame({ type: 'done', seq: 5 }));
    await vi.waitFor(() => expect(useAiStore.getState().isStreaming).toBe(false));
    expect(streamCalls(S)).toHaveLength(1);
    expect(posts()).toEqual([]);
    expect(methodsCalled()).not.toContain('DELETE');
  });
});
