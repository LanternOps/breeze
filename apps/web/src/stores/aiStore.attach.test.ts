/**
 * #9840 W2 (Task 9): the side panel attaches to a session's current turn.
 *
 * - restore (loadSession) and History pick (switchSession) attach after a
 *   successful, still-owned hydrate; never after the #5684 org-mismatch drop;
 *   never for a non-chat session type;
 * - a send refused with turn_in_progress (or an uncoded 409) attaches and puts
 *   the refused text back in the composer, with no error banner (Gate B #7);
 * - the re-attach cycle uses W1's shouldReattach / attachBackoffMs (Gate B #6);
 * - every attach write is guarded by the attach token AND the session owner,
 *   so a newer send or rebind supersedes an attach exactly like a send (#5684);
 * - reconciliation GETs: idle with a turnId (Gate B #15), done after a partial
 *   join, a missing anchor (re-hydrate, then re-attach once).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ fetchWithAuth: vi.fn() }));
// resetModelPicker reads the header's selected org (#9529); none selected here.
vi.mock('./orgStore', () => ({ useOrgStore: { getState: () => ({ currentOrgId: null }) } }));

import { fetchWithAuth } from './auth';
import { useAiStore } from './aiStore';
import { abortAllAttaches } from './aiSessionAttach';

const fetchMock = vi.mocked(fetchWithAuth);
const enc = new TextEncoder();

const ORG_A = 'aaaaaaaa-1111-4222-8333-444455556666';
const ORG_B = 'bbbbbbbb-1111-4222-8333-444455556666';
const SITE = '20000000-0000-4000-8000-000000000001';

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload), body: null }) as unknown as Response;

const frame = (data: unknown, event?: string) =>
  `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;

const snap = (over: Record<string, unknown> = {}) => ({
  type: 'attach_state', turn: 'running', turnId: 't1', lastSeq: 0, turnUserMessageId: null,
  partial: false, replay: [], pendingCards: [], activePlan: null, turnModel: null, ...over,
});

/** A live SSE body the test pushes frames into. cancel() is recorded. */
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
/** A finished SSE body: ping, then the given frames, then close. */
const sse = (...frames: string[]) => {
  const s = liveSse();
  s.push(frame({}, 'ping'));
  for (const f of frames) s.push(f);
  s.end();
  return s.res;
};

type Handler = () => Response | Promise<Response>;
let routes: Map<string, Handler[]>;
/** Queue handlers per exact URL; the last one repeats. Unknown URL → 404. */
function on(url: string, ...handlers: Handler[]) {
  routes.set(url, [...(routes.get(url) ?? []), ...handlers]);
}
const callsTo = (url: string) => fetchMock.mock.calls.filter(([u]) => String(u) === url);
const streamCalls = (id = 's1') => callsTo(`/ai/sessions/${id}/stream`);
const sessionGets = (id = 's1') => callsTo(`/ai/sessions/${id}`).filter(([, init]) => !init || !(init as RequestInit).method);
const signalOf = (call: unknown[]) => (call[1] as { signal?: AbortSignal } | undefined)?.signal;

const session = (over: Record<string, unknown> = {}, messages: unknown[] = []) => json({
  session: { id: 's1', status: 'active', orgId: ORG_A, type: 'general', topologySiteId: null, ...over },
  messages,
});

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

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
    isOpen: true, sessionId: null, sessionOrgId: null, hydratedSessionId: null, messages: [],
    isStreaming: false, isLoading: false, error: null, errorCode: null, pageContext: null,
    pendingApproval: null, pendingPlan: null, activePlan: null, joinedMidResponse: false,
    topologySiteId: null, topologySelection: null, topologyPhase: null, topologyRunId: null,
    composerDraft: '',
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  abortAllAttaches();
});

describe('restore attaches after the hydrate', () => {
  it('loadSession → one GET /ai/sessions/:id, then exactly one GET …/stream; unavailable on a first open does not retry', async () => {
    on('/ai/sessions/s1', () => session());
    on('/ai/sessions/s1/stream', () => sse(frame(snap({ turn: 'unavailable', turnId: null }))));

    await useAiStore.getState().loadSession('s1');
    await vi.waitFor(() => expect(streamCalls()).toHaveLength(1));
    await flush();

    const urls = fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith('/ai/sessions/'));
    expect(urls).toEqual(['/ai/sessions/s1', '/ai/sessions/s1/stream']);
    const s = useAiStore.getState();
    expect(s.sessionId).toBe('s1');
    expect(s.isStreaming).toBe(false);
    expect(s.error).toBeNull();
  });

  it('a running snapshot with a pending approval → pendingApproval set, isStreaming true', async () => {
    const live = liveSse();
    on('/ai/sessions/s1', () => session());
    on('/ai/sessions/s1/stream', () => live.res);

    await useAiStore.getState().loadSession('s1');
    live.push(frame(snap({
      lastSeq: 3,
      pendingCards: [{
        type: 'approval_required', executionId: 'ex1', toolName: 'run_script', input: {}, description: 'Run it',
        approvalExpiresAt: '2026-10-23T10:00:00Z',
      }],
    })));

    await vi.waitFor(() => expect(useAiStore.getState().pendingApproval?.executionId).toBe('ex1'));
    expect(useAiStore.getState().pendingApproval?.approvalExpiresAt).toBe('2026-10-23T10:00:00Z');
    expect(useAiStore.getState().isStreaming).toBe(true);
  });

  it('running → done: replay and live tail render, streaming stops, no extra hydrate after a full replay', async () => {
    on('/ai/sessions/s1', () => session({}, [{ id: 'u1', role: 'user', content: 'q', createdAt: '2026-10-23T10:00:00Z' }]));
    on('/ai/sessions/s1/stream', () => sse(
      frame(snap({
        lastSeq: 2, turnUserMessageId: 'u1',
        replay: [{ type: 'message_start', messageId: 'a1' }, { type: 'content_delta', delta: 'Hi' }],
      })),
      frame({ type: 'content_delta', delta: ' there', seq: 3 }),
      frame({ type: 'done', seq: 4 }),
    ));

    await useAiStore.getState().loadSession('s1');
    await vi.waitFor(() => expect(useAiStore.getState().messages.find((m) => m.id === 'a1')?.content).toBe('Hi there'));
    await flush();
    expect(useAiStore.getState().isStreaming).toBe(false);
    expect(sessionGets()).toHaveLength(1);
  });

  it('partial → done re-hydrates messages once', async () => {
    on('/ai/sessions/s1',
      () => session({}, [{ id: 'u1', role: 'user', content: 'q', createdAt: '2026-10-23T10:00:00Z' }]),
      () => session({}, [
        { id: 'u1', role: 'user', content: 'q', createdAt: '2026-10-23T10:00:00Z' },
        { id: 'a-final', role: 'assistant', content: 'full reply', createdAt: '2026-10-23T10:00:05Z' },
      ]));
    const live = liveSse();
    on('/ai/sessions/s1/stream', () => live.res);

    await useAiStore.getState().loadSession('s1');
    live.push(frame(snap({ lastSeq: 9, partial: true })));
    await vi.waitFor(() => expect(useAiStore.getState().joinedMidResponse).toBe(true));
    live.push(frame({ type: 'content_delta', delta: 'tail', seq: 10 }));
    live.push(frame({ type: 'done', seq: 11 }));

    await vi.waitFor(() => expect(sessionGets()).toHaveLength(2));
    await vi.waitFor(() => expect(useAiStore.getState().messages.map((m) => m.id)).toEqual(['u1', 'a-final']));
    expect(useAiStore.getState().joinedMidResponse).toBe(false);
    expect(useAiStore.getState().isStreaming).toBe(false);
  });

  it('the device-page org-mismatch drop makes no /stream request (#5684)', async () => {
    useAiStore.setState({ sessionId: 's1', sessionOrgId: null, pageContext: { type: 'device', id: 'd', hostname: 'h', orgId: ORG_B } });
    on('/ai/sessions/s1', () => session({ orgId: ORG_A }));
    on('/ai/sessions/s1/stream', () => sse(frame(snap({ turn: 'idle', turnId: null }))));

    await useAiStore.getState().loadSession('s1');
    await flush();

    expect(useAiStore.getState().sessionId).toBeNull();
    expect(streamCalls()).toHaveLength(0);
  });

  it('a persisted script_builder id is unbound like a 404, with no attach', async () => {
    useAiStore.setState({ sessionId: 's1' });
    on('/ai/sessions/s1', () => session({ type: 'script_builder' }, [{ id: 'm1', role: 'user', content: 'x', createdAt: '2026-10-23T10:00:00Z' }]));

    await useAiStore.getState().loadSession('s1');
    await flush();

    const s = useAiStore.getState();
    expect(s.sessionId).toBeNull();
    expect(s.messages).toEqual([]);
    expect(s.error).toBeNull();
    expect(streamCalls()).toHaveLength(0);
  });

  it('no attach when a newer load took ownership before the hydrate resolved', async () => {
    let releaseA!: (r: Response) => void;
    on('/ai/sessions/s1', () => new Promise<Response>((r) => { releaseA = r; }));
    on('/ai/sessions/s2', () => session({ id: 's2' }));
    on('/ai/sessions/s2/stream', () => sse(frame(snap({ turn: 'idle', turnId: null }))));

    const first = useAiStore.getState().loadSession('s1');
    await useAiStore.getState().loadSession('s2');
    releaseA(session());
    await first;
    await flush();

    expect(useAiStore.getState().sessionId).toBe('s2');
    expect(streamCalls('s1')).toHaveLength(0);
  });

  it('an attach that answers 404 unbinds like loadSession\'s 404 path', async () => {
    on('/ai/sessions/s1', () => session());
    on('/ai/sessions/s1/stream', () => json({ error: 'Not found' }, 404));

    await useAiStore.getState().loadSession('s1');
    await vi.waitFor(() => expect(useAiStore.getState().sessionId).toBeNull());
    expect(useAiStore.getState().messages).toEqual([]);
    expect(useAiStore.getState().error).toBeNull();
  });
});

describe('switchSession (History pick)', () => {
  it('attaches after a successful hydrate', async () => {
    useAiStore.setState({ sessionId: 's0', hydratedSessionId: 's0' });
    on('/ai/sessions/s1', () => session());
    on('/ai/sessions/s1/stream', () => sse(frame(snap({ turn: 'idle', turnId: null }))));

    await useAiStore.getState().switchSession('s1');
    await vi.waitFor(() => expect(streamCalls()).toHaveLength(1));
    expect(useAiStore.getState().sessionId).toBe('s1');
  });

  it('a non-chat type takes the non-OK path: previous session stays bound, error set, no attach', async () => {
    useAiStore.setState({ sessionId: 's0', hydratedSessionId: 's0', messages: [{ id: 'k', role: 'user', content: 'keep', createdAt: new Date() }] });
    on('/ai/sessions/s1', () => session({ type: 'script_builder' }));

    await useAiStore.getState().switchSession('s1');
    await flush();

    const s = useAiStore.getState();
    expect(s.sessionId).toBe('s0');
    expect(s.messages.map((m) => m.id)).toEqual(['k']);
    expect(s.error).toBe('Failed to load session');
    expect(streamCalls()).toHaveLength(0);
  });
});

describe('a send refused because another turn is running (Gate B #7)', () => {
  const bind = () => useAiStore.setState({ sessionId: 's1', sessionOrgId: ORG_A, hydratedSessionId: 's1', messages: [] });

  it.each([
    ['turn_in_progress', { error: 'Another response is in progress', code: 'turn_in_progress' }],
    ['uncoded', { error: 'Another response is in progress' }],
  ])('409 %s → bubble removed, text back in the composer, no error, attached to the running turn', async (_label, body) => {
    bind();
    const live = liveSse();
    on('/ai/sessions/s1/messages', () => json(body, 409));
    on('/ai/sessions/s1/stream', () => live.res);

    await useAiStore.getState().sendMessage('the text');
    await vi.waitFor(() => expect(streamCalls()).toHaveLength(1));
    live.push(frame(snap({ lastSeq: 2, replay: [{ type: 'message_start', messageId: 'a9' }, { type: 'content_delta', delta: 'other tab reply' }] })));
    await vi.waitFor(() => expect(useAiStore.getState().isStreaming).toBe(true));

    const s = useAiStore.getState();
    expect(s.composerDraft).toBe('the text');
    expect(s.error).toBeNull();
    expect(s.errorCode).toBeNull();
    expect(s.messages.some((m) => m.role === 'user' && m.content === 'the text')).toBe(false);
    expect(s.messages.find((m) => m.id === 'a9')?.content).toBe('other tab reply');
  });

  it('continuation_required, model codes and credits keep today\'s behaviour (no attach)', async () => {
    bind();
    on('/ai/sessions/s1/messages', () => json({ error: 'model gone', code: 'model_unavailable' }, 409));
    await useAiStore.getState().sendMessage('m');
    expect(useAiStore.getState().error).toBe('model gone');
    expect(useAiStore.getState().errorCode).toBe('model_unavailable');

    routes.clear();
    on('/ai/sessions/s1/messages', () => json({ error: 'no credits', code: 'ai_credits_exhausted' }, 402));
    await useAiStore.getState().sendMessage('m');
    expect(useAiStore.getState().errorCode).toBe('ai_credits_exhausted');
    expect(useAiStore.getState().composerDraft).toBe('');
    expect(streamCalls()).toHaveLength(0);
  });

  it('a 409 cycle re-attaches through an unavailable answer (the remove→recreate gap)', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1);
    bind();
    on('/ai/sessions/s1/messages', () => json({ code: 'turn_in_progress' }, 409));
    on('/ai/sessions/s1/stream',
      () => sse(frame(snap({ turn: 'unavailable', turnId: null }))),
      () => sse(frame(snap({ turn: 'idle', turnId: null }))));

    await useAiStore.getState().sendMessage('again');
    await vi.advanceTimersByTimeAsync(0);
    expect(streamCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(streamCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(streamCalls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(streamCalls()).toHaveLength(2);
    expect(useAiStore.getState().error).toBeNull();
  });
});

describe('re-attach cycle (Review Focus 1: two browser tabs, Gate B #6)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1);
    useAiStore.setState({ sessionId: 's1', sessionOrgId: ORG_A, hydratedSessionId: 's1' });
  });

  it('closed → re-attach after attachBackoffMs; an unavailable answer inside that cycle → one more attempt', async () => {
    on('/ai/sessions/s1/stream',
      () => sse(frame(snap({ lastSeq: 1 }))), // running, then the body ends without done → closed
      () => sse(frame(snap({ turn: 'unavailable', turnId: null }))),
      () => sse(frame(snap({ turn: 'idle', turnId: null }))));

    const run = useAiStore.getState().attachCurrent();
    await vi.advanceTimersByTimeAsync(0);
    expect(streamCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(streamCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); // attachBackoffMs(0, () => 1) = 500
    expect(streamCalls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(streamCalls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); // attachBackoffMs(1, () => 1) = 1000
    expect(streamCalls()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(20_000);
    await run;
    expect(streamCalls()).toHaveLength(3);
  });

  it('attempt 4 stops: one re-hydrate, isStreaming false, joinedMidResponse false, no banner', async () => {
    on('/ai/sessions/s1/stream', () => sse(frame(snap({ lastSeq: 1, partial: true }))));
    on('/ai/sessions/s1', () => session({}, [{ id: 'final', role: 'assistant', content: 'done', createdAt: '2026-10-23T10:00:00Z' }]));

    const run = useAiStore.getState().attachCurrent();
    await vi.advanceTimersByTimeAsync(0);
    expect(useAiStore.getState().joinedMidResponse).toBe(true);
    await vi.advanceTimersByTimeAsync(500 + 1000 + 2000 + 4000);
    await run;

    expect(streamCalls()).toHaveLength(5); // first attach + 4 re-attaches
    expect(sessionGets()).toHaveLength(1);
    const s = useAiStore.getState();
    expect(s.isStreaming).toBe(false);
    expect(s.joinedMidResponse).toBe(false);
    expect(s.error).toBeNull();
    expect(s.messages.map((m) => m.id)).toEqual(['final']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(streamCalls()).toHaveLength(5);
  });
});

describe('supersession and ownership (#5684 class)', () => {
  it('a newer sendMessage aborts a pending attach and drops its later events', async () => {
    useAiStore.setState({ sessionId: 's1', sessionOrgId: ORG_A, hydratedSessionId: 's1' });
    let releaseAttach!: (r: Response) => void;
    on('/ai/sessions/s1/stream', () => new Promise<Response>((r) => { releaseAttach = r; }));
    const send = liveSse();
    on('/ai/sessions/s1/messages', () => send.res);

    const run = useAiStore.getState().attachCurrent();
    await vi.waitFor(() => expect(streamCalls()).toHaveLength(1));
    const sending = useAiStore.getState().sendMessage('mine');
    await vi.waitFor(() => expect(callsTo('/ai/sessions/s1/messages')).toHaveLength(1));

    expect(signalOf(streamCalls()[0]!)?.aborted).toBe(true);
    releaseAttach(sse(frame(snap({ replay: [{ type: 'message_start', messageId: 'stale' }, { type: 'content_delta', delta: 'STALE' }] }))));
    await run;
    await flush();
    expect(useAiStore.getState().messages.some((m) => m.id === 'stale')).toBe(false);

    send.push(frame({ type: 'message_start', messageId: 'mine-a' }));
    send.push(frame({ type: 'done' }));
    send.end();
    await sending;
    expect(useAiStore.getState().messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('loadSession(B) during an attach for A: A\'s reader is cancelled and no A event lands in B', async () => {
    const liveA = liveSse();
    on('/ai/sessions/s1', () => session());
    on('/ai/sessions/s1/stream', () => liveA.res);
    on('/ai/sessions/s2', () => session({ id: 's2', orgId: ORG_B }, [{ id: 'b1', role: 'user', content: 'b', createdAt: '2026-10-23T10:00:00Z' }]));
    on('/ai/sessions/s2/stream', () => sse(frame(snap({ turn: 'idle', turnId: null }))));

    await useAiStore.getState().loadSession('s1');
    liveA.push(frame(snap({ lastSeq: 1 })));
    await vi.waitFor(() => expect(useAiStore.getState().isStreaming).toBe(true));

    await useAiStore.getState().loadSession('s2');
    expect(signalOf(streamCalls('s1')[0]!)?.aborted).toBe(true);
    await vi.waitFor(() => expect(liveA.cancel).toHaveBeenCalled());
    await vi.waitFor(() => expect(streamCalls('s2')).toHaveLength(1));
    await flush();

    const s = useAiStore.getState();
    expect(s.sessionId).toBe('s2');
    expect(s.messages.map((m) => m.id)).toEqual(['b1']);
    expect(s.isStreaming).toBe(false);
  });

  it('every attach controller is tracked: abortAllAttaches() (logout) stops it with no later write', async () => {
    useAiStore.setState({ sessionId: 's1', sessionOrgId: ORG_A, hydratedSessionId: 's1' });
    const live = liveSse();
    on('/ai/sessions/s1/stream', () => live.res);

    const run = useAiStore.getState().attachCurrent();
    live.push(frame(snap({ lastSeq: 1, replay: [{ type: 'message_start', messageId: 'a1' }] })));
    await vi.waitFor(() => expect(useAiStore.getState().isStreaming).toBe(true));

    abortAllAttaches();
    await run;
    expect(live.cancel).toHaveBeenCalled();
    const before = useAiStore.getState().messages;
    await flush();
    expect(useAiStore.getState().messages).toBe(before);
    expect(sessionGets()).toHaveLength(0);
  });
});

describe('topology investigation attach', () => {
  it('replayed and live content_delta are dropped; done clears the approval card', async () => {
    on('/ai/sessions/s1', () => session({ type: 'topology', topologySiteId: SITE }, [{ id: 'u1', role: 'user', content: 'Explain', createdAt: '2026-10-23T10:00:00Z' }]));
    const live = liveSse();
    on('/ai/sessions/s1/stream', () => live.res);

    await useAiStore.getState().loadSession('s1');
    expect(useAiStore.getState().topologySiteId).toBe(SITE);
    live.push(frame(snap({
      lastSeq: 2, turnUserMessageId: 'u1',
      replay: [{ type: 'message_start', messageId: 'a1' }, { type: 'content_delta', delta: 'RAW REPLAY' }],
      pendingCards: [{ type: 'approval_required', executionId: 'ex1', toolName: 'topology_run', input: {}, description: 'd' }],
    })));
    await vi.waitFor(() => expect(useAiStore.getState().pendingApproval?.executionId).toBe('ex1'));
    live.push(frame({ type: 'content_delta', delta: 'RAW LIVE', seq: 3 }));
    live.push(frame({ type: 'done', seq: 4 }));
    await vi.waitFor(() => expect(useAiStore.getState().isStreaming).toBe(false));

    const s = useAiStore.getState();
    expect(s.messages.find((m) => m.id === 'a1')?.content).toBe('');
    expect(JSON.stringify(s.messages)).not.toContain('RAW');
    expect(s.pendingApproval).toBeNull();
  });
});

describe('reconciliation reads (Gate B #15, Advisor finding 4)', () => {
  it('idle with a turnId → one extra GET /ai/sessions/:id', async () => {
    on('/ai/sessions/s1', () => session(), () => session({}, [{ id: 'late', role: 'assistant', content: 'finished meanwhile', createdAt: '2026-10-23T10:00:00Z' }]));
    on('/ai/sessions/s1/stream', () => sse(frame(snap({ turn: 'idle', turnId: 't-ran' }))));

    await useAiStore.getState().loadSession('s1');
    await vi.waitFor(() => expect(sessionGets()).toHaveLength(2));
    await vi.waitFor(() => expect(useAiStore.getState().messages.map((m) => m.id)).toEqual(['late']));
  });

  it('idle with turnId null → no extra GET', async () => {
    on('/ai/sessions/s1', () => session());
    on('/ai/sessions/s1/stream', () => sse(frame(snap({ turn: 'idle', turnId: null }))));

    await useAiStore.getState().loadSession('s1');
    await vi.waitFor(() => expect(streamCalls()).toHaveLength(1));
    await flush();
    expect(sessionGets()).toHaveLength(1);
  });

  it('anchor missing → re-hydrate, then attach again; still missing the second time → applied as is', async () => {
    on('/ai/sessions/s1', () => session(), () => session({}, [{ id: 'older', role: 'user', content: 'o', createdAt: '2026-10-23T09:00:00Z' }]));
    const replay = [{ type: 'message_start', messageId: 'a1' }, { type: 'content_delta', delta: 'R' }];
    const second = liveSse();
    on('/ai/sessions/s1/stream',
      () => sse(frame(snap({ lastSeq: 2, turnUserMessageId: 'u-missing', replay }))),
      () => second.res);

    await useAiStore.getState().loadSession('s1');
    await vi.waitFor(() => expect(streamCalls()).toHaveLength(2));
    expect(sessionGets()).toHaveLength(2);
    second.push(frame(snap({ lastSeq: 2, turnUserMessageId: 'u-missing', replay })));

    await vi.waitFor(() => expect(useAiStore.getState().messages.map((m) => m.id)).toEqual(['older', 'a1']));
    expect(useAiStore.getState().isStreaming).toBe(true);
    await flush();
    expect(streamCalls()).toHaveLength(2);
  });

  it('a reconciliation read that resolves after a rebind writes nothing', async () => {
    let releaseRehydrate!: (r: Response) => void;
    on('/ai/sessions/s1', () => session(), () => new Promise<Response>((r) => { releaseRehydrate = r; }));
    on('/ai/sessions/s1/stream', () => sse(frame(snap({ turn: 'idle', turnId: 't-ran' }))));
    on('/ai/sessions/s2', () => session({ id: 's2' }, [{ id: 'b1', role: 'user', content: 'b', createdAt: '2026-10-23T10:00:00Z' }]));
    on('/ai/sessions/s2/stream', () => sse(frame(snap({ turn: 'idle', turnId: null }))));

    await useAiStore.getState().loadSession('s1');
    await vi.waitFor(() => expect(sessionGets()).toHaveLength(2));
    await useAiStore.getState().loadSession('s2');
    releaseRehydrate(session({}, [{ id: 'A-LEAK', role: 'assistant', content: 'x', createdAt: '2026-10-23T10:00:00Z' }]));
    await flush();

    expect(useAiStore.getState().messages.map((m) => m.id)).toEqual(['b1']);
  });
});

describe('review round: a bind attempt is not a rebind (#9996 review)', () => {
  it('a failed History pick leaves the live attach running (no stuck spinner)', async () => {
    const live = liveSse();
    on('/ai/sessions/s1', () => session());
    on('/ai/sessions/s1/stream', () => live.res);
    on('/ai/sessions/s2', () => json({ error: 'boom' }, 500));
    routes.set('/ai/sessions/s1', [() => session({}, [{ id: 'u1', role: 'user', content: 'q', createdAt: '2026-10-23T10:00:00Z' }])]);

    await useAiStore.getState().loadSession('s1');
    live.push(frame(snap({ lastSeq: 1, turnUserMessageId: 'u1', replay: [{ type: 'message_start', messageId: 'a1' }] })));
    await vi.waitFor(() => expect(useAiStore.getState().isStreaming).toBe(true));

    await useAiStore.getState().switchSession('s2');
    expect(useAiStore.getState().sessionId).toBe('s1');
    expect(useAiStore.getState().error).toBe('Failed to load session');
    expect(signalOf(streamCalls()[0]!)?.aborted).toBe(false);

    live.push(frame({ type: 'content_delta', delta: 'still here', seq: 2 }));
    live.push(frame({ type: 'done', seq: 3 }));
    await vi.waitFor(() => expect(useAiStore.getState().isStreaming).toBe(false));
    expect(useAiStore.getState().messages.find((m) => m.id === 'a1')?.content).toBe('still here');
  });

  it('closing the attached session stops the attach and the spinner', async () => {
    const live = liveSse();
    on('/ai/sessions/s1', () => session());
    on('/ai/sessions/s1/stream', () => live.res);

    await useAiStore.getState().loadSession('s1');
    live.push(frame(snap({ lastSeq: 1 })));
    await vi.waitFor(() => expect(useAiStore.getState().isStreaming).toBe(true));
    routes.set('/ai/sessions/s1', [() => json({ success: true })]);

    await useAiStore.getState().closeSession();
    expect(useAiStore.getState().sessionId).toBeNull();
    expect(useAiStore.getState().isStreaming).toBe(false);
    expect(signalOf(streamCalls()[0]!)?.aborted).toBe(true);
  });

  it('the #5684 org-mismatch drop aborts a live attach synchronously and nothing lands after it', async () => {
    const live = liveSse();
    on('/ai/sessions/s1', () => session({ orgId: ORG_A }));
    on('/ai/sessions/s1/stream', () => live.res);

    await useAiStore.getState().loadSession('s1');
    live.push(frame(snap({ lastSeq: 1, replay: [{ type: 'message_start', messageId: 'a1' }] })));
    await vi.waitFor(() => expect(useAiStore.getState().isStreaming).toBe(true));

    useAiStore.getState().setPageContext({ type: 'device', id: 'd', hostname: 'h', orgId: ORG_B });
    expect(signalOf(streamCalls()[0]!)?.aborted).toBe(true);
    await flush();
    expect(useAiStore.getState().sessionId).toBeNull();
    expect(useAiStore.getState().messages).toEqual([]);
    expect(useAiStore.getState().isStreaming).toBe(false);
  });

  it('switching to another chat drops the old chat\'s running turn and card even when the new attach fails', async () => {
    const live = liveSse();
    on('/ai/sessions/s1', () => session());
    on('/ai/sessions/s1/stream', () => live.res);
    on('/ai/sessions/s2', () => session({ id: 's2' }));
    on('/ai/sessions/s2/stream', () => json({ error: 'boom' }, 500));

    await useAiStore.getState().loadSession('s1');
    live.push(frame(snap({ lastSeq: 1, pendingCards: [{ type: 'approval_required', executionId: 'exA', toolName: 't', input: {}, description: 'A card' }] })));
    await vi.waitFor(() => expect(useAiStore.getState().pendingApproval?.executionId).toBe('exA'));

    await useAiStore.getState().switchSession('s2');
    await vi.waitFor(() => expect(streamCalls('s2')).toHaveLength(1));
    await flush();
    const s = useAiStore.getState();
    expect(s.sessionId).toBe('s2');
    expect(s.pendingApproval).toBeNull();
    expect(s.isStreaming).toBe(false);
  });

  it('a 409 refusal that resolves after a rebind changes nothing on the new chat', async () => {
    useAiStore.setState({ sessionId: 's1', sessionOrgId: ORG_A, hydratedSessionId: 's1' });
    let refuse!: (r: Response) => void;
    on('/ai/sessions/s1/messages', () => new Promise<Response>((r) => { refuse = r; }));
    on('/ai/sessions/s2', () => session({ id: 's2' }));
    const liveB = liveSse();
    on('/ai/sessions/s2/stream', () => liveB.res);

    const sending = useAiStore.getState().sendMessage('text for A');
    await vi.waitFor(() => expect(callsTo('/ai/sessions/s1/messages')).toHaveLength(1));
    await useAiStore.getState().switchSession('s2');
    liveB.push(frame(snap({ lastSeq: 1 })));
    await vi.waitFor(() => expect(useAiStore.getState().isStreaming).toBe(true));

    refuse(json({ code: 'turn_in_progress' }, 409));
    await sending;
    await flush();

    const s = useAiStore.getState();
    expect(s.sessionId).toBe('s2');
    expect(s.composerDraft).toBe('');
    expect(s.isStreaming).toBe(true);
    expect(streamCalls('s2')).toHaveLength(1);
    expect(signalOf(streamCalls('s2')[0]!)?.aborted).toBe(false);
    expect(streamCalls('s1')).toHaveLength(0);
  });
});

describe('review round: re-attach outcomes (#9996 review)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1);
  });

  it('a re-attach un-applies the previous running snapshot: no duplicated rows', async () => {
    useAiStore.setState({ sessionId: 's1', sessionOrgId: ORG_A, hydratedSessionId: 's1', messages: [{ id: 'u1', role: 'user', content: 'q', createdAt: new Date() }] });
    const replay = [{ type: 'message_start', messageId: 'a1' }, { type: 'content_delta', delta: 'R' }];
    const second = liveSse();
    on('/ai/sessions/s1/stream',
      () => sse(frame(snap({ lastSeq: 2, turnUserMessageId: 'u1', replay }))), // ends without done → closed
      () => second.res);

    const run = useAiStore.getState().attachCurrent();
    await vi.advanceTimersByTimeAsync(0);
    expect(useAiStore.getState().messages.map((m) => m.id)).toEqual(['u1']); // un-applied before the backoff
    await vi.advanceTimersByTimeAsync(500);
    expect(streamCalls()).toHaveLength(2);
    second.push(frame(snap({ lastSeq: 2, turnUserMessageId: 'u1', replay })));
    second.push(frame({ type: 'content_delta', delta: 'S', seq: 3 }));
    await vi.advanceTimersByTimeAsync(0);

    const s = useAiStore.getState();
    expect(s.messages.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(s.messages.find((m) => m.id === 'a1')?.content).toBe('RS');
    second.push(frame({ type: 'done', seq: 4 }));
    second.end();
    await vi.advanceTimersByTimeAsync(0);
    await run;
  });

  it.each([
    ['gap', () => sse(frame(snap({ lastSeq: 2 })), frame({ type: 'content_delta', delta: 'x', seq: 5 }))],
    ['busy', () => json({ error: 'attach_limit' }, 429)],
  ])('%s → re-attach after the backoff', async (_kind, first) => {
    useAiStore.setState({ sessionId: 's1', sessionOrgId: ORG_A, hydratedSessionId: 's1' });
    on('/ai/sessions/s1/stream', first, () => sse(frame(snap({ turn: 'idle', turnId: null }))));

    const run = useAiStore.getState().attachCurrent();
    await vi.advanceTimersByTimeAsync(499);
    expect(streamCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(streamCalls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    expect(streamCalls()).toHaveLength(2);
    expect(useAiStore.getState().error).toBeNull();
  });

  it('a 404 on a re-attach unbinds and stops', async () => {
    useAiStore.setState({ sessionId: 's1', sessionOrgId: ORG_A, hydratedSessionId: 's1' });
    on('/ai/sessions/s1/stream', () => sse(frame(snap({ lastSeq: 1 }))), () => json({ error: 'Not found' }, 404));

    const run = useAiStore.getState().attachCurrent();
    await vi.advanceTimersByTimeAsync(500);
    await run;
    expect(useAiStore.getState().sessionId).toBeNull();
    expect(useAiStore.getState().isStreaming).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(streamCalls()).toHaveLength(2);
  });
});
