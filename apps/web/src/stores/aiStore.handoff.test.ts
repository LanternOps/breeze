/**
 * #9840 W2 (Task 10): the side panel's hand-off primitives.
 *
 * - releaseSession: let go of a session that moved elsewhere. Local only — no
 *   request at all, never a DELETE (D3) — and it cancels the held send reader
 *   and the attach synchronously (the stream token alone is noticed only after
 *   the next read() returns).
 * - adoptSession: bind a session as an explicit pick, open the panel and
 *   attach; resolves on the attach's `ready`, never after the turn.
 * - composerDraft: store-held composer text (not persisted).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('./orgStore', () => ({ useOrgStore: { getState: () => ({ currentOrgId: null }) } }));

import { fetchWithAuth } from './auth';
import { useAiStore } from './aiStore';
import { abortAllAttaches } from './aiSessionAttach';

const fetchMock = vi.mocked(fetchWithAuth);
const enc = new TextEncoder();
const ORG_A = 'aaaaaaaa-1111-4222-8333-444455556666';

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload), body: null }) as unknown as Response;
const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const snap = (over: Record<string, unknown> = {}) => ({
  type: 'attach_state', turn: 'running', turnId: 't1', lastSeq: 0, turnUserMessageId: null,
  partial: false, replay: [], pendingCards: [], activePlan: null, turnModel: null, ...over,
});

function liveSse() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(c) { ctl = c; }, cancel });
  return { res: { ok: true, status: 200, body } as unknown as Response, push: (s: string) => ctl.enqueue(enc.encode(s)), end: () => ctl.close(), cancel };
}

/** A send body whose reader parks on read() until cancel() — cancel() is a spy. */
function parkedSendStream(first: unknown) {
  let parked: ((r: ReadableStreamReadResult<Uint8Array>) => void) | null = null;
  let sentFirst = false;
  const cancel = vi.fn(async () => { parked?.({ done: true, value: undefined }); parked = null; });
  const reader = {
    read: () => {
      if (!sentFirst) { sentFirst = true; return Promise.resolve({ done: false, value: enc.encode(frame(first)) }); }
      return new Promise<ReadableStreamReadResult<Uint8Array>>((r) => { parked = r; });
    },
    cancel,
  };
  return { res: { ok: true, status: 200, body: { getReader: () => reader } } as unknown as Response, cancel };
}

type Handler = () => Response | Promise<Response>;
let routes: Map<string, Handler[]>;
const on = (url: string, ...hs: Handler[]) => routes.set(url, [...(routes.get(url) ?? []), ...hs]);
const callsTo = (url: string) => fetchMock.mock.calls.filter(([u]) => String(u) === url);
const session = (over: Record<string, unknown> = {}, messages: unknown[] = []) => json({
  session: { id: 's1', status: 'active', orgId: ORG_A, type: 'general', topologySiteId: null, ...over },
  messages,
});
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const persisted = () => JSON.parse(localStorage.getItem('breeze-ai-chat') ?? '{}').state ?? {};

const bindS0 = () => useAiStore.setState({
  isOpen: true, sessionId: 's0', sessionOrgId: ORG_A, hydratedSessionId: 's0',
  messages: [{ id: 'k', role: 'user', content: 'keep', createdAt: new Date() }],
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  abortAllAttaches();
  routes = new Map();
  fetchMock.mockImplementation(async (url: string | URL | Request) => {
    const q = routes.get(String(url));
    if (!q || q.length === 0) return json({}, 404);
    const h = q.length > 1 ? q.shift()! : q[0]!;
    return h();
  });
  useAiStore.setState({
    isOpen: false, sessionId: null, sessionOrgId: null, hydratedSessionId: null, messages: [],
    isStreaming: false, isLoading: false, error: null, errorCode: null, pageContext: null,
    pendingApproval: null, pendingPlan: null, activePlan: null, joinedMidResponse: false,
    topologySiteId: null, topologySelection: null, topologyPhase: null, topologyRunId: null,
    composerDraft: '',
  });
});

afterEach(() => { abortAllAttaches(); });

describe('composerDraft', () => {
  it('setComposerDraft holds the text in the store and it is not persisted', () => {
    useAiStore.getState().setComposerDraft('half a question');
    expect(useAiStore.getState().composerDraft).toBe('half a question');
    expect(persisted()).not.toHaveProperty('composerDraft');
  });
});

describe('releaseSession', () => {
  it('unbinds and closes the panel with no request at all', () => {
    useAiStore.setState({ isOpen: true, sessionId: 's1', sessionOrgId: ORG_A, hydratedSessionId: 's1', composerDraft: 'x', messages: [{ id: 'm', role: 'user', content: 'q', createdAt: new Date() }] });

    useAiStore.getState().releaseSession('s1');

    const s = useAiStore.getState();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.sessionId).toBeNull();
    expect(s.sessionOrgId).toBeNull();
    expect(s.messages).toEqual([]);
    expect(s.isOpen).toBe(false);
    expect(s.composerDraft).toBe('');
    expect(persisted().sessionId).toBeNull();
  });

  it('cancels the held send reader synchronously and the stream writes nothing more', async () => {
    useAiStore.setState({ isOpen: true, sessionId: 's1', sessionOrgId: ORG_A, hydratedSessionId: 's1' });
    const send = parkedSendStream({ type: 'message_start', messageId: 'a1' });
    on('/ai/sessions/s1/messages', () => send.res);

    const sending = useAiStore.getState().sendMessage('hi');
    await vi.waitFor(() => expect(useAiStore.getState().messages.some((m) => m.id === 'a1')).toBe(true));
    const callsBefore = fetchMock.mock.calls.length;

    useAiStore.getState().releaseSession('s1');
    expect(send.cancel).toHaveBeenCalledTimes(1); // synchronously, before any await

    await sending;
    await flush();
    const s = useAiStore.getState();
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    expect(s.sessionId).toBeNull();
    expect(s.messages).toEqual([]);
    expect(s.isStreaming).toBe(false);
  });

  it('aborts a running attach synchronously; no request, no later write', async () => {
    useAiStore.setState({ isOpen: true, sessionId: 's1', sessionOrgId: ORG_A, hydratedSessionId: 's1' });
    const live = liveSse();
    on('/ai/sessions/s1/stream', () => live.res);
    const run = useAiStore.getState().attachCurrent();
    live.push(frame(snap({ lastSeq: 1, replay: [{ type: 'message_start', messageId: 'a1' }] })));
    await vi.waitFor(() => expect(useAiStore.getState().isStreaming).toBe(true));
    const signal = (callsTo('/ai/sessions/s1/stream')[0]![1] as { signal: AbortSignal }).signal;
    const callsBefore = fetchMock.mock.calls.length;

    useAiStore.getState().releaseSession('s1');
    expect(signal.aborted).toBe(true);

    await run;
    await flush();
    expect(live.cancel).toHaveBeenCalled();
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    expect(useAiStore.getState().messages).toEqual([]);
    expect(useAiStore.getState().isStreaming).toBe(false);
  });

  it('a loadSession in flight when releaseSession runs does not rebind when it resolves', async () => {
    useAiStore.setState({ isOpen: true, sessionId: 's1', sessionOrgId: ORG_A });
    let release!: (r: Response) => void;
    on('/ai/sessions/s1', () => new Promise<Response>((r) => { release = r; }));

    const loading = useAiStore.getState().loadSession('s1');
    useAiStore.getState().releaseSession('s1');
    release(session({}, [{ id: 'late', role: 'user', content: 'x', createdAt: '2026-10-23T10:00:00Z' }]));
    await loading;
    await flush();

    const s = useAiStore.getState();
    expect(s.sessionId).toBeNull();
    expect(s.messages).toEqual([]);
    expect(s.isLoading).toBe(false);
    expect(callsTo('/ai/sessions/s1/stream')).toHaveLength(0);
  });

  it('releaseSession for another id changes nothing', () => {
    bindS0();
    useAiStore.setState({ composerDraft: 'typing' });
    const before = useAiStore.getState();

    useAiStore.getState().releaseSession('other');

    const s = useAiStore.getState();
    expect(s.sessionId).toBe('s0');
    expect(s.messages).toBe(before.messages);
    expect(s.isOpen).toBe(true);
    expect(s.composerDraft).toBe('typing');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('adoptSession', () => {
  it('an already-aborted signal → aborted, nothing bound, no request', async () => {
    bindS0();
    const c = new AbortController();
    c.abort();

    await expect(useAiStore.getState().adoptSession('s1', { signal: c.signal })).resolves.toBe('aborted');
    expect(useAiStore.getState().sessionId).toBe('s0');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a signal that aborts while the session loads → aborted, previous session untouched', async () => {
    bindS0();
    const c = new AbortController();
    let release!: (r: Response) => void;
    on('/ai/sessions/s1', () => new Promise<Response>((r) => { release = r; }));

    const adopting = useAiStore.getState().adoptSession('s1', { signal: c.signal, draft: 'd' });
    c.abort();
    release(session());

    await expect(adopting).resolves.toBe('aborted');
    const s = useAiStore.getState();
    expect(s.sessionId).toBe('s0');
    expect(s.messages.map((m) => m.id)).toEqual(['k']);
    expect(s.composerDraft).toBe('');
    expect(callsTo('/ai/sessions/s1/stream')).toHaveLength(0);
  });

  it('404 → not_found and the previous session stays bound', async () => {
    bindS0();
    on('/ai/sessions/s1', () => json({ error: 'Not found' }, 404));

    await expect(useAiStore.getState().adoptSession('s1')).resolves.toBe('not_found');
    const s = useAiStore.getState();
    expect(s.sessionId).toBe('s0');
    expect(s.messages.map((m) => m.id)).toEqual(['k']);
    expect(s.error).toBeNull();
  });

  it('a non-chat type → not_found; a closed session → closed; neither binds', async () => {
    bindS0();
    on('/ai/sessions/s1', () => session({ type: 'script_builder' }), () => session({ status: 'closed' }));
    await expect(useAiStore.getState().adoptSession('s1')).resolves.toBe('not_found');
    await expect(useAiStore.getState().adoptSession('s1')).resolves.toBe('closed');
    expect(useAiStore.getState().sessionId).toBe('s0');
    expect(callsTo('/ai/sessions/s1/stream')).toHaveLength(0);
  });

  it('ok → binds, opens the panel, sets the draft, and resolves on the attach\'s ready (not after the turn)', async () => {
    useAiStore.setState({ isOpen: false });
    const live = liveSse();
    on('/ai/sessions/s1', () => session({}, [{ id: 'u1', role: 'user', content: 'q', createdAt: '2026-10-23T10:00:00Z' }]));
    on('/ai/sessions/s1/stream', () => live.res);

    let settled = false;
    const adopting = useAiStore.getState().adoptSession('s1', { draft: 'carry me' }).then((r) => { settled = true; return r; });
    await vi.waitFor(() => expect(callsTo('/ai/sessions/s1/stream')).toHaveLength(1));
    await flush();
    expect(settled).toBe(false); // waiting on the attach's ready

    live.push(frame(snap({ lastSeq: 1, turnUserMessageId: 'u1', replay: [{ type: 'message_start', messageId: 'a1' }, { type: 'content_delta', delta: 'running' }] })));
    await expect(adopting).resolves.toBe('ok');

    const s = useAiStore.getState();
    expect(s.sessionId).toBe('s1');
    expect(s.isOpen).toBe(true);
    expect(s.composerDraft).toBe('carry me');
    expect(s.isStreaming).toBe(true); // the turn is still running: resolved on ready, not finished
    expect(s.messages.find((m) => m.id === 'a1')?.content).toBe('running');
  });

  it('ok without a draft clears the composer', async () => {
    useAiStore.setState({ composerDraft: 'old text' });
    on('/ai/sessions/s1', () => session());
    on('/ai/sessions/s1/stream', () => {
      const l = liveSse();
      l.push(frame(snap({ turn: 'idle', turnId: null })));
      l.end();
      return l.res;
    });

    await expect(useAiStore.getState().adoptSession('s1')).resolves.toBe('ok');
    expect(useAiStore.getState().composerDraft).toBe('');
    expect(useAiStore.getState().isOpen).toBe(true);
  });
});
