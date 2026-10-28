/**
 * #9840 W3 (Task 11): per-tab attach ownership in workspaceStore (the #5684
 * class, now per tab — Review Focus 4) and send-refusal parity with the panel
 * (Gate B #7).
 *
 * Every attach write is guarded by the captured workspaceGeneration, by "the
 * tab still exists with the same sessionId" and by "this controller is still
 * the tab's". closeTab, cleanupAllStreams, resetForLogout and a newer attach
 * for the same tab abort the previous controller synchronously.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('../components/shared/Toast', () => ({ showToast: vi.fn() }));

import { fetchWithAuth } from './auth';
import { useWorkspaceStore, type TabState } from './workspaceStore';
import { abortAllAttaches } from './aiSessionAttach';

const fetchMock = vi.mocked(fetchWithAuth);
const enc = new TextEncoder();
const ORG_A = 'aaaaaaaa-1111-4222-8333-444455556666';

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload), body: null }) as unknown as Response;
const frame = (data: unknown, event?: string) =>
  `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
const snap = (over: Record<string, unknown> = {}) => ({
  type: 'attach_state', turn: 'running', turnId: 't1', lastSeq: 0, turnUserMessageId: null,
  partial: false, replay: [], pendingCards: [], activePlan: null, turnModel: null, ...over,
});
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
const sse = (...frames: string[]) => {
  const s = liveSse();
  s.push(frame({}, 'ping'));
  for (const f of frames) s.push(f);
  s.end();
  return s.res;
};

type Handler = () => Response | Promise<Response>;
let routes: Map<string, Handler[]>;
function on(url: string, ...handlers: Handler[]) {
  routes.set(url, [...(routes.get(url) ?? []), ...handlers]);
}
const callsTo = (url: string) => fetchMock.mock.calls.filter(([u]) => String(u) === url);
const sessionGets = (id: string) => callsTo(`/ai/sessions/${id}`).filter(([, init]) => !init || !(init as RequestInit).method);
const signalOf = (call: unknown[] | undefined) => (call?.[1] as { signal?: AbortSignal } | undefined)?.signal;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

const session = (id: string, over: Record<string, unknown> = {}, messages: unknown[] = []) => json({
  session: { id, status: 'active', orgId: ORG_A, type: 'general', title: `T ${id}`, ...over },
  messages,
});

function tab(over: Partial<TabState> = {}): TabState {
  return {
    id: 'tab-x', sessionId: null, title: 'Chat', isTitleCustom: false, contextLabel: null, pageContext: null,
    messages: [], chatRuns: {}, isStreaming: false, isLoading: false, error: null, pendingApproval: null,
    pendingPlan: null, activePlan: null, approvalMode: 'per_step', isPaused: false, isInterrupting: false,
    isFlagged: false, unreadCount: 0, hasApprovalPending: false, orgId: null, deviceId: null, deviceLabel: null,
    m365ConnectionId: null, composerDraft: '', joinedMidResponse: false, errorAction: null,
    ...over,
  };
}
const tabOf = (id: string) => useWorkspaceStore.getState().tabs.find((t) => t.id === id);

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  routes = new Map();
  fetchMock.mockImplementation(async (url: string | URL | Request) => {
    const q = routes.get(String(url));
    if (!q || q.length === 0) return json({}, 404);
    const h = q.length > 1 ? q.shift()! : q[0]!;
    return h();
  });
  useWorkspaceStore.getState().cleanupAllStreams();
  useWorkspaceStore.setState({ tabs: [], activeTabId: null });
});

afterEach(() => {
  useWorkspaceStore.getState().cleanupAllStreams();
  abortAllAttaches();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('restoreWorkspace hydrates and attaches each session tab', () => {
  it('two session tabs → two hydrates + two attaches; chip fields filled', async () => {
    useWorkspaceStore.setState({
      tabs: [tab({ id: 'a', sessionId: 'sa' }), tab({ id: 'b', sessionId: 'sb' }), tab({ id: 'c' })],
      activeTabId: 'a',
    });
    on('/ai/sessions/sa', () => session('sa', { deviceId: 'd1', contextSnapshot: { type: 'device', id: 'dddddddd-1111-4222-8333-444455556666', hostname: 'h1' } }));
    on('/ai/sessions/sb', () => session('sb'));
    on('/ai/sessions/sa/stream', () => sse(frame(snap({ turn: 'idle', turnId: null }))));
    on('/ai/sessions/sb/stream', () => sse(frame(snap({ turn: 'idle', turnId: null }))));

    await useWorkspaceStore.getState().restoreWorkspace();
    await flush();

    expect(sessionGets('sa')).toHaveLength(1);
    expect(sessionGets('sb')).toHaveLength(1);
    expect(callsTo('/ai/sessions/sa/stream')).toHaveLength(1);
    expect(callsTo('/ai/sessions/sb/stream')).toHaveLength(1);
    expect(tabOf('a')).toMatchObject({ sessionId: 'sa', orgId: ORG_A, deviceId: 'd1', deviceLabel: 'h1' });
    expect(useWorkspaceStore.getState().activeTabId).toBe('a'); // restore never moves the active tab
  });

  it('a non-chat type on restore clears that tab’s session like a 404, with no attach', async () => {
    useWorkspaceStore.setState({ tabs: [tab({ id: 'a', sessionId: 'sa', messages: [{ id: 'x', role: 'user', content: 'q', createdAt: new Date() }] })], activeTabId: 'a' });
    on('/ai/sessions/sa', () => session('sa', { type: 'script_builder' }));
    await useWorkspaceStore.getState().restoreWorkspace();
    await flush();
    expect(tabOf('a')).toMatchObject({ sessionId: null, messages: [] });
    expect(callsTo('/ai/sessions/sa/stream')).toHaveLength(0);
  });

  it('idle snapshot with a turnId → one extra GET; idle with turnId null → none (Gate B #15)', async () => {
    useWorkspaceStore.setState({ tabs: [tab({ id: 'a', sessionId: 'sa' }), tab({ id: 'b', sessionId: 'sb' })], activeTabId: 'a' });
    on('/ai/sessions/sa', () => session('sa'));
    on('/ai/sessions/sb', () => session('sb'));
    on('/ai/sessions/sa/stream', () => sse(frame(snap({ turn: 'idle', turnId: 't9' }))));
    on('/ai/sessions/sb/stream', () => sse(frame(snap({ turn: 'idle', turnId: null }))));
    await useWorkspaceStore.getState().restoreWorkspace();
    await vi.waitFor(() => expect(sessionGets('sa')).toHaveLength(2));
    await flush();
    expect(sessionGets('sb')).toHaveLength(1);
  });
});

describe('per-tab ownership (#5684 class)', () => {
  async function twoRunningTabs() {
    const liveA = liveSse();
    const liveB = liveSse();
    useWorkspaceStore.setState({ tabs: [tab({ id: 'a', sessionId: 'sa' }), tab({ id: 'b', sessionId: 'sb' })], activeTabId: 'a' });
    on('/ai/sessions/sa', () => session('sa'));
    on('/ai/sessions/sb', () => session('sb'));
    on('/ai/sessions/sa/stream', () => liveA.res);
    on('/ai/sessions/sb/stream', () => liveB.res);
    const restored = useWorkspaceStore.getState().restoreWorkspace();
    await vi.waitFor(() => expect(callsTo('/ai/sessions/sb/stream')).toHaveLength(1));
    await vi.waitFor(() => expect(callsTo('/ai/sessions/sa/stream')).toHaveLength(1));
    liveA.push(frame(snap({ lastSeq: 0 })));
    liveB.push(frame(snap({ lastSeq: 0 })));
    await restored;
    return { liveA, liveB };
  }

  it('events for tab A never land in tab B', async () => {
    const { liveA } = await twoRunningTabs();
    liveA.push(frame({ type: 'message_start', messageId: 'am1', seq: 1 }));
    liveA.push(frame({ type: 'content_delta', delta: 'for A', seq: 2 }));
    await vi.waitFor(() => expect(tabOf('a')!.messages.some((m) => m.content === 'for A')).toBe(true));
    expect(tabOf('b')!.messages).toEqual([]);
    expect(tabOf('a')!.isStreaming).toBe(true);
    expect(tabOf('b')!.isStreaming).toBe(true);
  });

  it('with B active, A’s events (seq colliding with B’s) touch only A', async () => {
    const { liveA, liveB } = await twoRunningTabs();
    useWorkspaceStore.getState().switchTab('b');
    const bBefore = tabOf('b')!;
    liveA.push(frame({ type: 'message_start', messageId: 'am1', seq: 1 }));
    liveA.push(frame({ type: 'content_delta', delta: 'only A', seq: 2 }));
    liveB.push(frame({ type: 'message_start', messageId: 'bm1', seq: 1 }));
    liveB.push(frame({ type: 'content_delta', delta: 'only B', seq: 2 }));
    await vi.waitFor(() => expect(tabOf('a')!.messages.map((m) => m.content)).toEqual(['only A']));
    await vi.waitFor(() => expect(tabOf('b')!.messages.map((m) => m.content)).toEqual(['only B']));
    expect(tabOf('a')!.unreadCount).toBe(1); // A is the background tab now
    expect(tabOf('b')!.unreadCount).toBe(bBefore.unreadCount);
    expect(tabOf('b')!.hasApprovalPending).toBe(false);
  });

  it('a tab whose session was unbound stops taking its old attach’s frames', async () => {
    const { liveA } = await twoRunningTabs();
    const signal = signalOf(callsTo('/ai/sessions/sa/stream')[0]);
    useWorkspaceStore.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === 'a' ? { ...t, sessionId: 'other', messages: [] } : t)) }));
    liveA.push(frame({ type: 'message_start', messageId: 'late', seq: 1 }));
    liveA.push(frame({ type: 'content_delta', delta: 'stale', seq: 2 }));
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    await flush();
    expect(tabOf('a')!.messages).toEqual([]);
  });

  it('logout while two tabs are attached: both streams aborted, later frames write nothing, nothing re-persisted', async () => {
    const { liveA, liveB } = await twoRunningTabs();
    useWorkspaceStore.getState().resetForLogout();
    localStorage.removeItem('breeze-workspace');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    expect(signalOf(callsTo('/ai/sessions/sa/stream')[0])?.aborted).toBe(true);
    expect(signalOf(callsTo('/ai/sessions/sb/stream')[0])?.aborted).toBe(true);
    for (const live of [liveA, liveB]) {
      try { live.push(frame({ type: 'message_start', messageId: 'x', seq: 1 })); } catch { /* cancelled */ }
    }
    await flush();
    expect(useWorkspaceStore.getState().tabs).toEqual([]);
    expect(setItem.mock.calls.filter(([k]) => k === 'breeze-workspace')).toEqual([]);
  });

  it('logout while the restore hydrate is in flight → the late hydrate writes nothing and attaches nothing', async () => {
    let release!: () => void;
    useWorkspaceStore.setState({ tabs: [tab({ id: 'a', sessionId: 'sa' })], activeTabId: 'a' });
    on('/ai/sessions/sa', () => new Promise<Response>((r) => { release = () => r(session('sa')); }));
    const restored = useWorkspaceStore.getState().restoreWorkspace();
    await vi.waitFor(() => expect(sessionGets('sa')).toHaveLength(1));
    useWorkspaceStore.getState().resetForLogout();
    release();
    await restored;
    await flush();
    expect(useWorkspaceStore.getState().tabs).toEqual([]);
    expect(callsTo('/ai/sessions/sa/stream')).toHaveLength(0);
  });

  it('a background tab’s attach counts unread and flags a pending approval', async () => {
    const { liveB } = await twoRunningTabs();
    liveB.push(frame({ type: 'message_start', messageId: 'bm1', seq: 1 }));
    liveB.push(frame({ type: 'approval_required', executionId: 'ex1', toolName: 't', input: {}, description: 'd', seq: 2 }));
    await vi.waitFor(() => expect(tabOf('b')!.hasApprovalPending).toBe(true));
    expect(tabOf('b')!.unreadCount).toBe(1);
  });

  it('closeTab(A) makes no fetch, aborts A’s attach synchronously, and A’s later events write nothing', async () => {
    const { liveA } = await twoRunningTabs();
    const attachSignal = signalOf(callsTo('/ai/sessions/sa/stream')[0]);
    const before = fetchMock.mock.calls.length;

    useWorkspaceStore.getState().closeTab('a');

    expect(attachSignal?.aborted).toBe(true);
    expect(fetchMock.mock.calls.length).toBe(before);
    const tabsAfter = useWorkspaceStore.getState().tabs;
    try { liveA.push(frame({ type: 'message_start', messageId: 'late', seq: 1 })); } catch { /* reader cancelled */ }
    await flush();
    expect(useWorkspaceStore.getState().tabs).toBe(tabsAfter);
    expect(useWorkspaceStore.getState().tabs.map((t) => t.id)).toEqual(['b']);
  });

  it('cleanupAllStreams aborts every attach controller', async () => {
    await twoRunningTabs();
    useWorkspaceStore.getState().cleanupAllStreams();
    expect(signalOf(callsTo('/ai/sessions/sa/stream')[0])?.aborted).toBe(true);
    expect(signalOf(callsTo('/ai/sessions/sb/stream')[0])?.aborted).toBe(true);
  });

  it('a newer attach for the same tab aborts the previous one (restore twice)', async () => {
    await twoRunningTabs();
    const first = signalOf(callsTo('/ai/sessions/sa/stream')[0]);
    on('/ai/sessions/sa/stream', () => sse(frame(snap({ turn: 'idle', turnId: null }))));
    on('/ai/sessions/sb/stream', () => sse(frame(snap({ turn: 'idle', turnId: null }))));
    await useWorkspaceStore.getState().restoreWorkspace();
    expect(first?.aborted).toBe(true);
  });

  it('done after a partial join clears joinedMidResponse and re-reads messages', async () => {
    const live = liveSse();
    useWorkspaceStore.setState({ tabs: [tab({ id: 'a', sessionId: 'sa' })], activeTabId: 'a' });
    on('/ai/sessions/sa', () => session('sa'));
    on('/ai/sessions/sa/stream', () => live.res);
    const restored = useWorkspaceStore.getState().restoreWorkspace();
    await vi.waitFor(() => expect(callsTo('/ai/sessions/sa/stream')).toHaveLength(1));
    live.push(frame(snap({ partial: true, lastSeq: 4 })));
    await restored;
    expect(tabOf('a')!.joinedMidResponse).toBe(true);
    live.push(frame({ type: 'done', seq: 5 }));
    await vi.waitFor(() => expect(sessionGets('sa')).toHaveLength(2));
    await flush();
    expect(tabOf('a')!.joinedMidResponse).toBe(false);
    expect(tabOf('a')!.isStreaming).toBe(false);
  });

  it('an attach 404 unbinds the tab like a restore 404', async () => {
    useWorkspaceStore.setState({ tabs: [tab({ id: 'a', sessionId: 'sa' })], activeTabId: 'a' });
    on('/ai/sessions/sa', () => session('sa'));
    on('/ai/sessions/sa/stream', () => json({}, 404));
    await useWorkspaceStore.getState().restoreWorkspace();
    await flush();
    expect(tabOf('a')).toMatchObject({ sessionId: null, messages: [], isStreaming: false });
  });
});

describe('sendMessage refusals (Gate B #7, classifySendRefusal)', () => {
  const setup = () => {
    useWorkspaceStore.setState({ tabs: [tab({ id: 'a', sessionId: 'sa' })], activeTabId: 'a' });
    on('/ai/sessions/sa', () => session('sa'));
  };

  it.each([
    ['409 turn_in_progress', { code: 'turn_in_progress', error: 'busy' }],
    ['an uncoded 409', { error: 'Another response is still in progress.' }],
  ])('%s → bubble dropped, draft restored, no error, attach started in a 409 cycle', async (_l, body) => {
    setup();
    vi.spyOn(Math, 'random').mockReturnValue(0); // backoff 0 ms
    on('/ai/sessions/sa/messages', () => json(body, 409));
    on(
      '/ai/sessions/sa/stream',
      () => sse(frame(snap({ turn: 'unavailable', turnId: null }))),
      () => sse(frame(snap({ turn: 'idle', turnId: null }))),
    );

    await useWorkspaceStore.getState().sendMessage('a', 'the text');
    const t = tabOf('a')!;
    expect(t.messages).toEqual([]);
    expect(t.composerDraft).toBe('the text');
    expect(t.error).toBeNull();
    expect(t.errorAction).toBeNull();
    // unavailable inside a 409 cycle re-attaches once more (shouldReattach)
    await vi.waitFor(() => expect(callsTo('/ai/sessions/sa/stream')).toHaveLength(2));
  });

  it.each([
    ['continuation_required', 'continuation_required'],
    ['a recoverable model code', 'model_unavailable'],
    ['topology_model_changed', 'topology_model_changed'],
  ])('409 %s → "Continue in side panel to choose a model" + errorAction', async (_l, code) => {
    setup();
    on('/ai/sessions/sa/messages', () => json({ code, error: 'nope' }, 409));
    await useWorkspaceStore.getState().sendMessage('a', 'pick a model');
    const t = tabOf('a')!;
    expect(t.messages).toEqual([]);
    expect(t.error).toBe('Continue in side panel to choose a model');
    expect(t.errorAction).toBe('continue_in_panel');
    expect(t.isStreaming).toBe(false);
    expect(callsTo('/ai/sessions/sa/stream')).toHaveLength(0);
  });

  it('a 409 with another code keeps today’s banner', async () => {
    setup();
    on('/ai/sessions/sa/messages', () => json({ code: 'something_else', error: 'Server said no' }, 409));
    await useWorkspaceStore.getState().sendMessage('a', 'x');
    expect(tabOf('a')).toMatchObject({ messages: [], error: 'Server said no', errorAction: null });
  });

  it('a new send clears a stale errorAction', async () => {
    useWorkspaceStore.setState({ tabs: [tab({ id: 'a', sessionId: 'sa', error: 'old', errorAction: 'continue_in_panel' })], activeTabId: 'a' });
    on('/ai/sessions/sa/messages', () => sse(frame({ type: 'done' })));
    await useWorkspaceStore.getState().sendMessage('a', 'x');
    expect(tabOf('a')).toMatchObject({ error: null, errorAction: null });
  });

  it('a send superseded by closeTab writes nothing when its response lands', async () => {
    setup();
    let release!: () => void;
    on('/ai/sessions/sa/messages', () => new Promise<Response>((r) => { release = () => r(json({ code: 'turn_in_progress' }, 409)); }));
    const p = useWorkspaceStore.getState().sendMessage('a', 'late');
    await vi.waitFor(() => expect(callsTo('/ai/sessions/sa/messages')).toHaveLength(1));
    useWorkspaceStore.getState().closeTab('a');
    const tabsAfter = useWorkspaceStore.getState().tabs;
    release();
    await p;
    await flush();
    expect(useWorkspaceStore.getState().tabs).toBe(tabsAfter);
    expect(callsTo('/ai/sessions/sa/stream')).toHaveLength(0);
  });

  it('a stale send (logout since it started) writes nothing even to a tab that exists again under the same id', async () => {
    setup();
    let release!: () => void;
    on('/ai/sessions/sa/messages', () => new Promise<Response>((r) => { release = () => r(sse(frame({ type: 'done' }))); }));
    const p = useWorkspaceStore.getState().sendMessage('a', 'late');
    await vi.waitFor(() => expect(callsTo('/ai/sessions/sa/messages')).toHaveLength(1));
    useWorkspaceStore.getState().resetForLogout();
    const reborn = tab({ id: 'a', sessionId: 'sa', isStreaming: true, messages: [] });
    useWorkspaceStore.setState({ tabs: [reborn], activeTabId: 'a' });
    release();
    await p;
    await flush();
    expect(tabOf('a')).toBe(reborn);
  });

  it('a send whose fetch resolves after resetForLogout writes nothing (no re-persist, Codex finding 1)', async () => {
    setup();
    let release!: () => void;
    on('/ai/sessions/sa/messages', () => new Promise<Response>((r) => { release = () => r(sse(frame({ type: 'message_start', messageId: 'm' }), frame({ type: 'done' }))); }));
    const p = useWorkspaceStore.getState().sendMessage('a', 'late');
    await vi.waitFor(() => expect(callsTo('/ai/sessions/sa/messages')).toHaveLength(1));
    useWorkspaceStore.getState().resetForLogout();
    localStorage.removeItem('breeze-workspace');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    release();
    await p;
    await flush();
    expect(setItem.mock.calls.filter(([k]) => k === 'breeze-workspace')).toEqual([]);
    expect(localStorage.getItem('breeze-workspace')).toBeNull();
    expect(useWorkspaceStore.getState().tabs).toEqual([]);
  });
});
