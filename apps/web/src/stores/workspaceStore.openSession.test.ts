/**
 * #9840 W3 (Task 11): workspaceStore.openSession — the workspace opens an
 * existing conversation in a tab.
 *
 * Order (spec §3.6): an existing tab is focused (no fetch); a full tab bar is a
 * `tab_cap` (no fetch, never an eviction, D5); one GET via openAiSession;
 * topology never opens here (D4); an aborted hand-off signal commits no tab;
 * otherwise a tab is appended, activated, attached, and `'opened'` resolves on
 * the attach's ready (attach_state), not when the turn ends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('../components/shared/Toast', () => ({ showToast: vi.fn() }));

import { fetchWithAuth } from './auth';
import { useWorkspaceStore, type TabState } from './workspaceStore';
import { useOrgStore } from './orgStore';
import { abortAllAttaches } from './aiSessionAttach';

const fetchMock = vi.mocked(fetchWithAuth);
const enc = new TextEncoder();

const ORG_A = 'aaaaaaaa-1111-4222-8333-444455556666';
const ORG_B = 'bbbbbbbb-1111-4222-8333-444455556666';

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload), body: null }) as unknown as Response;
const frame = (data: unknown, event?: string) =>
  `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
const snap = (over: Record<string, unknown> = {}) => ({
  type: 'attach_state', turn: 'idle', turnId: null, lastSeq: 0, turnUserMessageId: null,
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
const idleSse = () => sse(frame(snap({ turn: 'unavailable' })));

type Handler = () => Response | Promise<Response>;
let routes: Map<string, Handler[]>;
function on(url: string, ...handlers: Handler[]) {
  routes.set(url, [...(routes.get(url) ?? []), ...handlers]);
}
const callsTo = (url: string) => fetchMock.mock.calls.filter(([u]) => String(u) === url);
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

const session = (over: Record<string, unknown> = {}, messages: unknown[] = []) => json({
  session: {
    id: 's1', status: 'active', orgId: ORG_A, type: 'general', title: 'Disk cleanup',
    deviceId: 'dev-1', delegantM365ConnectionId: 'm365-1',
    contextSnapshot: { type: 'device', id: 'dev-1', hostname: 'host-01', orgAnchor: 'page_context' },
    ...over,
  },
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
  useOrgStore.setState({ currentOrgId: ORG_A });
});

afterEach(() => {
  useWorkspaceStore.getState().cleanupAllStreams();
  abortAllAttaches();
  vi.restoreAllMocks();
});

describe('openSession — new conversation', () => {
  it('one GET, a tab appended and activated with chip fields, attach started, resolves only after attach_state', async () => {
    const live = liveSse();
    on('/ai/sessions/s1', () => session({}, [{ id: 'm1', role: 'user', content: 'hi', createdAt: '2026-10-24T00:00:00Z' }]));
    on('/ai/sessions/s1/stream', () => live.res);
    useWorkspaceStore.setState({ tabs: [tab({ id: 'other' })], activeTabId: 'other' });

    let settled: string | null = null;
    const p = useWorkspaceStore.getState().openSession('s1', { draft: 'half typed' })
      .then((r) => { settled = r; return r; });

    await vi.waitFor(() => expect(callsTo('/ai/sessions/s1/stream')).toHaveLength(1));
    await flush();
    expect(settled).toBeNull(); // not before attach_state

    live.push(frame({}, 'ping'));
    live.push(frame(snap()));
    await expect(p).resolves.toBe('opened');

    expect(callsTo('/ai/sessions/s1')).toHaveLength(1);
    const s = useWorkspaceStore.getState();
    expect(s.tabs).toHaveLength(2);
    const opened = s.tabs[1]!;
    expect(s.activeTabId).toBe(opened.id);
    expect(opened).toMatchObject({
      sessionId: 's1', title: 'Disk cleanup', orgId: ORG_A, deviceId: 'dev-1', deviceLabel: 'host-01',
      m365ConnectionId: 'm365-1', composerDraft: 'half typed', errorAction: null,
    });
    expect(opened.pageContext).toEqual({ type: 'device', id: 'dev-1', hostname: 'host-01' });
    expect(opened.messages.map((m) => m.id)).toEqual(['m1']);
  });

  it('a running snapshot marks the tab streaming and a partial join sets joinedMidResponse', async () => {
    const live = liveSse();
    on('/ai/sessions/s1', () => session());
    on('/ai/sessions/s1/stream', () => live.res);
    const p = useWorkspaceStore.getState().openSession('s1');
    await vi.waitFor(() => expect(callsTo('/ai/sessions/s1/stream')).toHaveLength(1));
    live.push(frame(snap({ turn: 'running', turnId: 't1', partial: true })));
    await expect(p).resolves.toBe('opened');
    const t = useWorkspaceStore.getState().tabs[0]!;
    expect(t.isStreaming).toBe(true);
    expect(t.joinedMidResponse).toBe(true);
  });
});

describe('openSession — short-circuits', () => {
  it('an id already held by a tab is focused with no fetch', async () => {
    useWorkspaceStore.setState({ tabs: [tab({ id: 'a', sessionId: 's1' }), tab({ id: 'b' })], activeTabId: 'b' });
    await expect(useWorkspaceStore.getState().openSession('s1')).resolves.toBe('focused');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().activeTabId).toBe('a');
  });

  it('five tabs → tab_cap with no fetch, and no tab is closed (never eviction)', async () => {
    useWorkspaceStore.setState({ tabs: [1, 2, 3, 4, 5].map((i) => tab({ id: `t${i}` })), activeTabId: 't1' });
    await expect(useWorkspaceStore.getState().openSession('s1')).resolves.toBe('tab_cap');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().tabs.map((t) => t.id)).toEqual(['t1', 't2', 't3', 't4', 't5']);
  });

  it('an already-aborted hand-off signal → aborted, no fetch, no tab', async () => {
    const c = new AbortController();
    c.abort();
    await expect(useWorkspaceStore.getState().openSession('s1', { signal: c.signal })).resolves.toBe('aborted');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().tabs).toHaveLength(0);
  });

  it('a signal aborted while the GET is in flight → aborted, no tab committed, no attach', async () => {
    const c = new AbortController();
    let release!: () => void;
    on('/ai/sessions/s1', () => new Promise<Response>((r) => { release = () => r(session()); }));
    const p = useWorkspaceStore.getState().openSession('s1', { signal: c.signal });
    await vi.waitFor(() => expect(callsTo('/ai/sessions/s1')).toHaveLength(1));
    c.abort();
    release();
    await expect(p).resolves.toBe('aborted');
    expect(useWorkspaceStore.getState().tabs).toHaveLength(0);
    expect(callsTo('/ai/sessions/s1/stream')).toHaveLength(0);
  });

  it('a signal aborted before the attach is ready → the new tab is withdrawn (no mirror)', async () => {
    const c = new AbortController();
    const live = liveSse();
    on('/ai/sessions/s1', () => session());
    on('/ai/sessions/s1/stream', () => live.res);
    const p = useWorkspaceStore.getState().openSession('s1', { signal: c.signal });
    await vi.waitFor(() => expect(callsTo('/ai/sessions/s1/stream')).toHaveLength(1));
    c.abort();
    live.push(frame(snap()));
    await expect(p).resolves.toBe('aborted');
    expect(useWorkspaceStore.getState().tabs).toHaveLength(0);
  });

  it('a topology session never opens in the workspace (D4): no tab, no attach', async () => {
    on('/ai/sessions/s1', () => session({ type: 'topology', topologySiteId: 'site-1' }));
    await expect(useWorkspaceStore.getState().openSession('s1')).resolves.toBe('topology');
    expect(useWorkspaceStore.getState().tabs).toHaveLength(0);
    expect(callsTo('/ai/sessions/s1/stream')).toHaveLength(0);
  });

  it.each([
    ['404', () => json({ error: 'Not found' }, 404), 'not_found'],
    ['a non-chat type', () => session({ type: 'script_builder' }), 'not_found'],
    ['a closed session', () => session({ status: 'closed' }), 'closed'],
    ['a 500', () => json({}, 500), 'error'],
  ] as const)('%s → %s, no tab, no attach', async (_label, handler, expected) => {
    on('/ai/sessions/s1', handler);
    await expect(useWorkspaceStore.getState().openSession('s1')).resolves.toBe(expected);
    expect(useWorkspaceStore.getState().tabs).toHaveLength(0);
    expect(callsTo('/ai/sessions/s1/stream')).toHaveLength(0);
  });

  it('an attach 404 right after the hydrate → not_found and the tab is withdrawn', async () => {
    on('/ai/sessions/s1', () => session());
    on('/ai/sessions/s1/stream', () => json({}, 404));
    await expect(useWorkspaceStore.getState().openSession('s1')).resolves.toBe('not_found');
    expect(useWorkspaceStore.getState().tabs).toHaveLength(0);
  });

  it('a logout while the GET is in flight → aborted and nothing is written', async () => {
    let release!: () => void;
    on('/ai/sessions/s1', () => new Promise<Response>((r) => { release = () => r(session()); }));
    const p = useWorkspaceStore.getState().openSession('s1');
    await vi.waitFor(() => expect(callsTo('/ai/sessions/s1')).toHaveLength(1));
    useWorkspaceStore.getState().resetForLogout();
    release();
    await expect(p).resolves.toBe('aborted');
    expect(useWorkspaceStore.getState().tabs).toHaveLength(0);
  });
});

describe('other-org tab survives the org switcher (Review Focus 3)', () => {
  it('currentOrgId change → the tab keeps its session and its next send POSTs to the same id', async () => {
    on('/ai/sessions/s1', () => session({ orgId: ORG_B }));
    on('/ai/sessions/s1/stream', idleSse);
    await expect(useWorkspaceStore.getState().openSession('s1')).resolves.toBe('opened');
    const tabId = useWorkspaceStore.getState().tabs[0]!.id;

    useOrgStore.setState({ currentOrgId: ORG_B });
    useOrgStore.setState({ currentOrgId: ORG_A });
    await flush();

    const t = useWorkspaceStore.getState().tabs[0]!;
    expect(t.sessionId).toBe('s1');
    expect(t.orgId).toBe(ORG_B);

    on('/ai/sessions/s1/messages', () => sse(frame({ type: 'done' })));
    await useWorkspaceStore.getState().sendMessage(tabId, 'next question');
    const posts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(posts.map(([u]) => String(u))).toEqual(['/ai/sessions/s1/messages']);
  });
});

describe('setComposerDraft', () => {
  it('writes only the named tab', () => {
    useWorkspaceStore.setState({ tabs: [tab({ id: 'a' }), tab({ id: 'b' })], activeTabId: 'a' });
    useWorkspaceStore.getState().setComposerDraft('a', 'typing');
    const [a, b] = useWorkspaceStore.getState().tabs;
    expect(a!.composerDraft).toBe('typing');
    expect(b!.composerDraft).toBe('');
  });
});
