/**
 * #9429: the side panel's stream loops feed the notification tracker. The
 * mapping (error then done → one "failed", no "ready") and the visibility rule
 * live in lib/aiNotifications and are tested there; this file asserts what the
 * store hands over, and that a notification problem never breaks a turn.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('./orgStore', () => ({ useOrgStore: { getState: () => ({ currentOrgId: null }) } }));
vi.mock('@/lib/aiNotifications', () => ({
  noteAiTurnEvent: vi.fn(),
  noteAiStreamFailure: vi.fn(),
  resetAiTurnNotify: vi.fn(),
  closeAiNotification: vi.fn(),
}));

import { fetchWithAuth } from './auth';
import { useAiStore } from './aiStore';
import {
  closeAiNotification,
  noteAiStreamFailure,
  noteAiTurnEvent,
  resetAiTurnNotify,
  type AiNotifyContext,
} from '@/lib/aiNotifications';

const fetchMock = vi.mocked(fetchWithAuth);
const noteEvent = vi.mocked(noteAiTurnEvent);
const noteFailure = vi.mocked(noteAiStreamFailure);
const SID = 'sess-1';
const SIDEBAR = { kind: 'sidebar' };

const sse = (events: unknown[]): Response => {
  const bytes = new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
  return { ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }) } as unknown as Response;
};

const okTurn = () => sse([
  { type: 'message_start', messageId: 'srv-a1' },
  { type: 'content_delta', delta: 'All good.' },
  { type: 'message_end', inputTokens: 1, outputTokens: 1 },
  { type: 'done' },
]);

const notedTypes = () => noteEvent.mock.calls.map(([type]) => type);
const lastCtx = () => noteEvent.mock.calls.at(-1)![2] as AiNotifyContext;

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  useAiStore.setState({
    isOpen: false, sessionId: SID, messages: [], isStreaming: false, isLoading: false,
    error: null, errorCode: null, errorDetail: null, retryTarget: null,
    pageContext: null, pendingApproval: null, topologySiteId: null, composerDraft: '', wisp: null,
  });
});

describe('aiStore notifications (#9429)', () => {
  it('hands every applied send event to the tracker for the side panel, once per event', async () => {
    fetchMock.mockResolvedValueOnce(okTurn());
    await useAiStore.getState().sendMessage('hello');
    expect(notedTypes()).toEqual(['message_start', 'content_delta', 'message_end', 'done']);
    for (const [, surface] of noteEvent.mock.calls) expect(surface).toEqual(SIDEBAR);
    expect(lastCtx()).toMatchObject({ sessionId: SID, surfaceVisible: false });
  });

  it('starts each turn with a clean failure state', async () => {
    fetchMock.mockResolvedValueOnce(okTurn());
    await useAiStore.getState().sendMessage('hello');
    expect(resetAiTurnNotify).toHaveBeenCalledWith(SIDEBAR);
    expect(vi.mocked(resetAiTurnNotify).mock.invocationCallOrder[0]!)
      .toBeLessThan(noteEvent.mock.invocationCallOrder[0]!);
  });

  it('reports the panel as visible while it is open', async () => {
    useAiStore.setState({ isOpen: true });
    fetchMock.mockResolvedValueOnce(okTurn());
    await useAiStore.getState().sendMessage('hello');
    expect(lastCtx().surfaceVisible).toBe(true);
  });

  it('reports a Wisp thread as visible (its page shows the chat without the panel)', async () => {
    useAiStore.setState({ isOpen: false, wisp: { grantId: 'g1' } as never });
    fetchMock.mockResolvedValueOnce(okTurn());
    await useAiStore.getState().sendMessage('hello');
    expect(lastCtx().surfaceVisible).toBe(true);
  });

  it('forwards approvals and stream errors', async () => {
    fetchMock.mockResolvedValueOnce(sse([
      { type: 'approval_required', executionId: 'e1', toolName: 'run_script', input: {}, description: 'x' },
      { type: 'error', message: 'boom', code: 'timeout' },
      { type: 'done' },
    ]));
    await useAiStore.getState().sendMessage('hello');
    expect(notedTypes()).toEqual(['approval_required', 'error', 'done']);
  });

  it('a click opens the side panel', async () => {
    fetchMock.mockResolvedValueOnce(okTurn());
    await useAiStore.getState().sendMessage('hello');
    expect(useAiStore.getState().isOpen).toBe(false);
    lastCtx().onOpen();
    expect(useAiStore.getState().isOpen).toBe(true);
  });

  it('a request that throws reports one stream failure', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await useAiStore.getState().sendMessage('hello');
    expect(noteFailure).toHaveBeenCalledTimes(1);
    expect(noteFailure.mock.calls[0]![0]).toEqual(SIDEBAR);
  });

  it('never notifies for a topology investigation turn', async () => {
    useAiStore.setState({ topologySiteId: 'site-1' });
    fetchMock.mockResolvedValueOnce(okTurn());
    await useAiStore.getState().sendMessage('hello');
    expect(noteEvent).not.toHaveBeenCalled();
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await useAiStore.getState().sendMessage('again');
    expect(noteFailure).not.toHaveBeenCalled();
  });

  it('a superseded stream notifies nothing', async () => {
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, body } as unknown as Response);
    const pending = useAiStore.getState().sendMessage('hello');
    await Promise.resolve();
    // Another conversation takes the panel over before the turn ends.
    useAiStore.setState({ sessionId: 'other' });
    ctl.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'done' })}\n\n`));
    ctl.close();
    await pending;
    expect(noteEvent).not.toHaveBeenCalled();
    expect(noteFailure).not.toHaveBeenCalled();
  });

  it('a throwing tracker does not break the turn', async () => {
    noteEvent.mockImplementation(() => { throw new Error('notify broke'); });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(okTurn());
    await useAiStore.getState().sendMessage('hello');
    const s = useAiStore.getState();
    expect(s.isStreaming).toBe(false);
    expect(s.error).toBeNull();
    expect(s.messages.some((m) => m.role === 'assistant' && m.content === 'All good.')).toBe(true);
  });

  it('opening the panel closes this conversation\'s notifications', () => {
    useAiStore.getState().open();
    expect(closeAiNotification).toHaveBeenCalledWith(SIDEBAR, SID);
  });

  it('toggling the panel open closes them; toggling it closed does not', () => {
    useAiStore.getState().toggle();
    expect(closeAiNotification).toHaveBeenCalledTimes(1);
    useAiStore.getState().toggle();
    expect(closeAiNotification).toHaveBeenCalledTimes(1);
  });

  // The /wisp page composer holds this conversation: open() and toggle() focus
  // it instead of opening the pane, and the user is now looking at the chat.
  it.each(['open', 'toggle'] as const)('%s() handed off to the /wisp page composer still closes the conversation\'s notifications', (action) => {
    useAiStore.setState({
      wisp: { threadId: 'thread-1', grantId: 'grant-1' } as never,
      wispPageThreadId: 'thread-1',
      wispPageComposerFocusRequest: 0,
    });
    useAiStore.getState()[action]();
    expect(useAiStore.getState().isOpen).toBe(false);
    expect(useAiStore.getState().wispPageComposerFocusRequest).toBe(1);
    expect(closeAiNotification).toHaveBeenCalledWith(SIDEBAR, SID);
  });

  it('a /wisp page claim that closes the open pane on that thread closes the conversation\'s notifications too', () => {
    useAiStore.setState({
      isOpen: true, showHistory: false,
      wisp: { threadId: 'thread-1', grantId: 'grant-1' } as never,
      wispPageThreadId: null, wispPageComposerFocusRequest: 0,
    });
    useAiStore.getState().setWispPageThreadId('thread-1');
    expect(useAiStore.getState().isOpen).toBe(false);
    expect(closeAiNotification).toHaveBeenCalledWith(SIDEBAR, SID);
  });

  it('a claim that hands nothing off (pane closed) leaves notifications alone', () => {
    useAiStore.setState({ isOpen: false, wisp: { threadId: 'thread-1', grantId: 'grant-1' } as never, wispPageThreadId: null });
    useAiStore.getState().setWispPageThreadId('thread-1');
    expect(closeAiNotification).not.toHaveBeenCalled();
  });
});

describe('aiStore notifications on an attached turn (#9429 × #9427)', () => {
  const snapshot = { type: 'attach_state', turn: 'running', turnId: 't1', lastSeq: 0, turnUserMessageId: null, partial: false, replay: [], pendingCards: [], activePlan: null, turnModel: null };

  it('events delivered by attach reach the tracker too, after a reset', async () => {
    const stream = sse([snapshot, { type: 'plan_approval_required', planId: 'p1', steps: [] }, { type: 'done' }]);
    fetchMock.mockImplementation(async (url) => (String(url).endsWith('/stream')
      ? stream
      : ({ ok: true, status: 200, json: async () => ({ session: { id: SID }, messages: [] }) } as unknown as Response)));
    await useAiStore.getState().attachCurrent();
    expect(resetAiTurnNotify).toHaveBeenCalledWith(SIDEBAR);
    expect(notedTypes()).toEqual(['attach_state', 'plan_approval_required', 'done']);
    expect(lastCtx()).toMatchObject({ sessionId: SID, surfaceVisible: false });
  });

  it('never notifies for an attached topology turn', async () => {
    useAiStore.setState({ topologySiteId: 'site-1' });
    fetchMock.mockImplementation(async (url) => (String(url).endsWith('/stream')
      ? sse([snapshot, { type: 'done' }])
      : ({ ok: true, status: 200, json: async () => ({ session: { id: SID }, messages: [] }) } as unknown as Response)));
    await useAiStore.getState().attachCurrent();
    expect(noteEvent).not.toHaveBeenCalled();
  });
});
