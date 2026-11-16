import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('./orgStore', () => ({ useOrgStore: { getState: () => ({ currentOrgId: null }) } }));

import { fetchWithAuth } from './auth';
import { useAiStore } from './aiStore';
import { activeRetryTarget } from '../lib/aiErrors';

/**
 * #9428: "Try again" on a failed side-panel chat turn. A retryable failure
 * leaves a retry target; retryLastTurn re-sends the failed message in the same
 * session without a second user bubble (and, with `retry: true`, without a
 * second stored row).
 */
const fetchMock = vi.mocked(fetchWithAuth);
const SID = 'sess-1';

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const sse = (events: unknown[]): Response => {
  const bytes = new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
  return { ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }) } as unknown as Response;
};

const idleAttach = (): Response => sse([{ type: 'attach_state', turn: 'idle', turnId: null, lastSeq: 0, turnUserMessageId: null, partial: false, replay: [], pendingCards: [], activePlan: null, turnModel: null }]);

/** A turn that streams part of a reply, then times out. */
const timedOutTurn = (detail?: string): Response => sse([
  { type: 'message_start', messageId: 'srv-a1' },
  { type: 'content_delta', delta: 'Half an ans' },
  { type: 'error', message: 'AI request timed out. Please try again.', code: 'timeout', ...(detail ? { detail } : {}) },
  { type: 'done' },
]);

const okTurn = (): Response => sse([
  { type: 'message_start', messageId: 'srv-a2' },
  { type: 'content_delta', delta: 'All good.' },
  { type: 'message_end', inputTokens: 1, outputTokens: 1 },
  { type: 'done' },
]);

const postBodies = () => fetchMock.mock.calls
  .filter(([url, init]) => String(url).endsWith('/messages') && (init as RequestInit | undefined)?.method === 'POST')
  .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

const userBubbles = () => useAiStore.getState().messages.filter((m) => m.role === 'user');

async function failWithTimeout(detail?: string) {
  fetchMock.mockResolvedValueOnce(timedOutTurn(detail));
  await useAiStore.getState().sendMessage('Why is the server slow?');
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  useAiStore.setState({
    isOpen: true, sessionId: SID, messages: [], isStreaming: false, isLoading: false,
    error: null, errorCode: null, errorDetail: null, retryTarget: null,
    pageContext: null, pendingApproval: null, topologySiteId: null, composerDraft: '', wisp: null,
  });
});

describe('aiStore failure codes (#9428)', () => {
  it('a timed-out stream records code, detail and a retry target', async () => {
    await failWithTimeout('The gateway gave up.');
    const s = useAiStore.getState();
    expect(s.errorCode).toBe('timeout');
    expect(s.errorDetail).toBe('The gateway gave up.');
    expect(s.retryTarget).toMatchObject({ sessionId: SID, content: 'Why is the server slow?', code: 'timeout', mode: 'retry', detail: 'The gateway gave up.' });
    expect(activeRetryTarget(s)).not.toBeNull();
  });

  it('a fetch that throws is a disconnect (reload before re-sending)', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await useAiStore.getState().sendMessage('hello');
    expect(useAiStore.getState().errorCode).toBe('disconnect');
    expect(useAiStore.getState().retryTarget).toMatchObject({ mode: 'reload_first', content: 'hello' });
  });

  it('an HTTP 503 with no code is http_5xx: the text goes back to the composer and can be re-sent', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Service unavailable' }, 503));
    await useAiStore.getState().sendMessage('hello');
    const s = useAiStore.getState();
    expect(s.errorCode).toBe('http_5xx');
    expect(s.retryTarget).toMatchObject({ mode: 'resend', content: 'hello' });
    expect(s.composerDraft).toBe('hello');
    expect(userBubbles()).toHaveLength(0);
  });

  it('an HTTP 403 is rejected: no retry', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Forbidden' }, 403));
    await useAiStore.getState().sendMessage('hello');
    expect(useAiStore.getState().errorCode).toBe('rejected');
    expect(useAiStore.getState().retryTarget).toBeNull();
  });

  it("a response body's own code always wins over the HTTP status", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'AI is disabled', code: 'topology_ai_disabled' }, 403));
    await useAiStore.getState().sendMessage('hello');
    expect(useAiStore.getState().errorCode).toBe('topology_ai_disabled');
    expect(useAiStore.getState().retryTarget).toBeNull();
  });

  it('a non-retryable stream error (budget) leaves no retry target', async () => {
    fetchMock.mockResolvedValueOnce(sse([{ type: 'error', message: 'AI budget limit reached for this query.', code: 'budget_exceeded' }, { type: 'done' }]));
    await useAiStore.getState().sendMessage('hello');
    expect(useAiStore.getState().errorCode).toBe('budget_exceeded');
    expect(useAiStore.getState().retryTarget).toBeNull();
  });

  it('a later, unrelated error retires the target (the banner no longer describes it)', async () => {
    await failWithTimeout();
    useAiStore.setState({ error: 'Failed to approve' });
    expect(activeRetryTarget(useAiStore.getState())).toBeNull();
  });
});

describe('aiStore.retryLastTurn (#9428)', () => {
  it('re-sends the failed message with retry:true, without a second bubble, and finalizes the stuck reply', async () => {
    await failWithTimeout();
    expect(userBubbles()).toHaveLength(1);
    fetchMock.mockResolvedValueOnce(okTurn());
    await useAiStore.getState().retryLastTurn();
    expect(postBodies()[1]).toMatchObject({ content: 'Why is the server slow?', retry: true });
    expect(postBodies()[0]!.retry).toBeUndefined();
    const s = useAiStore.getState();
    expect(userBubbles()).toHaveLength(1);
    expect(s.error).toBeNull();
    expect(s.retryTarget).toBeNull();
    expect(s.messages.every((m) => !m.isStreaming)).toBe(true);
  });

  it('a reply left spinning by the failure (no error event reached it) is finalized by the retry', async () => {
    await failWithTimeout();
    useAiStore.setState((s) => ({ messages: s.messages.map((m) => (m.role === 'assistant' ? { ...m, isStreaming: true } : m)) }));
    fetchMock.mockResolvedValueOnce(json({ error: 'busy', code: 'turn_in_progress' }, 409));
    fetchMock.mockResolvedValueOnce(idleAttach());
    await useAiStore.getState().retryLastTurn();
    expect(useAiStore.getState().messages.filter((m) => m.role === 'assistant').every((m) => !m.isStreaming)).toBe(true);
  });

  it('a retry refused 409 turn_in_progress keeps the original bubble and attaches', async () => {
    await failWithTimeout();
    fetchMock.mockResolvedValueOnce(json({ error: 'busy', code: 'turn_in_progress' }, 409));
    fetchMock.mockResolvedValueOnce(idleAttach());
    await useAiStore.getState().retryLastTurn();
    expect(userBubbles()).toHaveLength(1);
    expect(useAiStore.getState().composerDraft).toBe('');
  });

  it('a retry refused 409 continuation_required drops the bubble (the continuation re-sends it)', async () => {
    await failWithTimeout();
    fetchMock.mockResolvedValueOnce(json({ error: 'continue', code: 'continuation_required', reason: 'transcript_too_large' }, 409));
    await useAiStore.getState().retryLastTurn();
    expect(userBubbles()).toHaveLength(0);
  });

  it('does nothing while a turn is streaming (a double click never sends twice)', async () => {
    await failWithTimeout();
    fetchMock.mockClear();
    useAiStore.setState({ isStreaming: true });
    await useAiStore.getState().retryLastTurn();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a double click sends once', async () => {
    await failWithTimeout();
    fetchMock.mockResolvedValueOnce(okTurn());
    await Promise.all([useAiStore.getState().retryLastTurn(), useAiStore.getState().retryLastTurn()]);
    expect(postBodies()).toHaveLength(2);
  });

  it('does nothing once the chat moved to another session', async () => {
    await failWithTimeout();
    fetchMock.mockClear();
    useAiStore.setState({ sessionId: 'sess-other' });
    await useAiStore.getState().retryLastTurn();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing with no retry target', async () => {
    await useAiStore.getState().retryLastTurn();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a topology investigation turn never gets a retry target', async () => {
    useAiStore.setState({ topologySiteId: 'site-1' });
    fetchMock.mockResolvedValueOnce(sse([{ type: 'error', message: 'AI request timed out. Please try again.', code: 'timeout' }, { type: 'done' }]));
    await useAiStore.getState().sendMessage('explain');
    expect(useAiStore.getState().retryTarget).toBeNull();
    await useAiStore.getState().retryLastTurn();
    expect(postBodies()).toHaveLength(1);
  });

  it('http_5xx: re-sends the text as a new message and empties the composer', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Service unavailable' }, 503));
    await useAiStore.getState().sendMessage('hello');
    fetchMock.mockResolvedValueOnce(okTurn());
    await useAiStore.getState().retryLastTurn();
    expect(postBodies()[1]).toEqual(expect.objectContaining({ content: 'hello' }));
    expect(postBodies()[1]!.retry).toBeUndefined();
    expect(userBubbles()).toHaveLength(1);
    expect(useAiStore.getState().composerDraft).toBe('');
  });

  describe('after a disconnect it reloads first', () => {
    const session = { id: SID, status: 'active', type: 'general', orgId: null };
    const row = (id: string, role: string, content: string) => ({ id, role, content, createdAt: '2026-11-15T10:00:00.000Z' });

    async function disconnect() {
      fetchMock.mockRejectedValueOnce(new TypeError('network error'));
      await useAiStore.getState().sendMessage('hello');
    }

    it('the stored transcript still ends with the message: re-sends with retry:true and no new bubble', async () => {
      await disconnect();
      fetchMock.mockResolvedValueOnce(json({ session, messages: [row('u1', 'user', 'hello')] }));
      fetchMock.mockResolvedValueOnce(okTurn());
      await useAiStore.getState().retryLastTurn();
      expect(fetchMock).toHaveBeenCalledWith(`/ai/sessions/${SID}`);
      expect(postBodies()[1]).toMatchObject({ content: 'hello', retry: true });
      expect(userBubbles()).toHaveLength(1);
    });

    it('the turn finished server-side: shows the answer and sends nothing', async () => {
      await disconnect();
      fetchMock.mockResolvedValueOnce(json({ session, messages: [row('u1', 'user', 'hello'), row('a1', 'assistant', 'Hi!')] }));
      await useAiStore.getState().retryLastTurn();
      expect(postBodies()).toHaveLength(1);
      expect(useAiStore.getState().messages.map((m) => m.content)).toEqual(['hello', 'Hi!']);
    });

    it('the message never reached the server: sends it as a new message', async () => {
      await disconnect();
      fetchMock.mockResolvedValueOnce(json({ session, messages: [row('u0', 'user', 'earlier'), row('a0', 'assistant', 'ok')] }));
      fetchMock.mockResolvedValueOnce(okTurn());
      await useAiStore.getState().retryLastTurn();
      expect(postBodies()[1]).toEqual(expect.objectContaining({ content: 'hello' }));
      expect(postBodies()[1]!.retry).toBeUndefined();
      expect(userBubbles().map((m) => m.content)).toEqual(['earlier', 'hello']);
    });
  });

  it('a reload that fails keeps the chat and keeps offering the retry', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network error'));
    await useAiStore.getState().sendMessage('hello');
    fetchMock.mockRejectedValueOnce(new TypeError('still offline'));
    await useAiStore.getState().retryLastTurn();
    const s = useAiStore.getState();
    expect(s.sessionId).toBe(SID);
    expect(userBubbles().map((m) => m.content)).toEqual(['hello']);
    expect(s.isLoading).toBe(false);
    expect(s.error).toBe('still offline');
    expect(activeRetryTarget(s)).toMatchObject({ mode: 'reload_first', content: 'hello' });
  });

  it('a retry refused 503 keeps its bubble and stays a retry (the row is stored), so the next try still sends retry:true', async () => {
    await failWithTimeout();
    fetchMock.mockResolvedValueOnce(json({ error: 'Unavailable' }, 503));
    await useAiStore.getState().retryLastTurn();
    let s = useAiStore.getState();
    expect(userBubbles()).toHaveLength(1);
    expect(s.composerDraft).toBe('');
    expect(s.errorCode).toBe('http_5xx');
    expect(s.retryTarget).toMatchObject({ mode: 'retry' });
    fetchMock.mockResolvedValueOnce(okTurn());
    await useAiStore.getState().retryLastTurn();
    expect(postBodies()[2]).toMatchObject({ content: 'Why is the server slow?', retry: true });
    s = useAiStore.getState();
    expect(userBubbles()).toHaveLength(1);
  });

  it('a retry refused 403 keeps its bubble and the composer alone, with no retry offered', async () => {
    await failWithTimeout();
    fetchMock.mockResolvedValueOnce(json({ error: 'Forbidden' }, 403));
    await useAiStore.getState().retryLastTurn();
    const s = useAiStore.getState();
    expect(userBubbles()).toHaveLength(1);
    expect(s.composerDraft).toBe('');
    expect(s.errorCode).toBe('rejected');
    expect(s.retryTarget).toBeNull();
  });

  it('clearError and loading a session clear the target and detail', async () => {
    await failWithTimeout('d');
    useAiStore.getState().clearError();
    expect(useAiStore.getState()).toMatchObject({ retryTarget: null, errorDetail: null });

    await failWithTimeout('d');
    fetchMock.mockResolvedValueOnce(json({ session: { id: 'sess-2', status: 'active', type: 'general', orgId: null }, messages: [] }));
    fetchMock.mockResolvedValueOnce(idleAttach());
    await useAiStore.getState().loadSession('sess-2');
    expect(useAiStore.getState()).toMatchObject({ retryTarget: null, errorDetail: null });
  });
});
