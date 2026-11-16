import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('../components/shared/Toast', () => ({ showToast: vi.fn() }));

import { fetchWithAuth } from './auth';
import { useWorkspaceStore, type TabState } from './workspaceStore';
import { abortAllAttaches } from './aiSessionAttach';
import { activeRetryTarget } from '../lib/aiErrors';

/**
 * #9428: "Try again" on a failed workspace tab turn. Mirrors aiStore.retry.test.ts
 * per tab: a retryable failure leaves a retry target on that tab; retryLastTurn
 * re-sends the failed message in the same session without a second user bubble.
 */
const fetchMock = vi.mocked(fetchWithAuth);
const SID = 'sess-1';
const TAB = 'tab-a';

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const sse = (events: unknown[]): Response => {
  const bytes = new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
  return { ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }) } as unknown as Response;
};

const idleAttach = (): Response => sse([{ type: 'attach_state', turn: 'idle', turnId: null, lastSeq: 0, turnUserMessageId: null, partial: false, replay: [], pendingCards: [], activePlan: null, turnModel: null }]);

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

const postBodies = (sid = SID) => fetchMock.mock.calls
  .filter(([url, init]) => String(url) === `/ai/sessions/${sid}/messages` && (init as RequestInit | undefined)?.method === 'POST')
  .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

function tab(over: Partial<TabState> = {}): TabState {
  return {
    id: TAB, sessionId: SID, title: 'Chat', isTitleCustom: false, contextLabel: null, pageContext: null,
    messages: [], chatRuns: {}, isStreaming: false, isLoading: false, error: null, errorCode: null, errorDetail: null,
    retryTarget: null, pendingApproval: null, pendingPlan: null, activePlan: null, approvalMode: 'per_step',
    isPaused: false, isInterrupting: false, isFlagged: false, unreadCount: 0, hasApprovalPending: false, orgId: null,
    deviceId: null, deviceLabel: null, m365ConnectionId: null, composerDraft: '', joinedMidResponse: false,
    errorAction: null, wisp: { kind: 'plain' },
    ...over,
  };
}
const tabOf = (id = TAB) => useWorkspaceStore.getState().tabs.find((t) => t.id === id)!;
const userBubbles = (id = TAB) => tabOf(id).messages.filter((m) => m.role === 'user');
const store = () => useWorkspaceStore.getState();

async function failWithTimeout(detail?: string) {
  fetchMock.mockResolvedValueOnce(timedOutTurn(detail));
  await store().sendMessage(TAB, 'Why is the server slow?');
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  store().cleanupAllStreams();
  useWorkspaceStore.setState({ tabs: [tab()], activeTabId: TAB });
});

afterEach(() => {
  store().cleanupAllStreams();
  abortAllAttaches();
});

describe('workspaceStore failure codes (#9428)', () => {
  it('a timed-out stream records code, detail and a retry target on the tab', async () => {
    await failWithTimeout('The gateway gave up.');
    const t = tabOf();
    expect(t.errorCode).toBe('timeout');
    expect(t.errorDetail).toBe('The gateway gave up.');
    expect(t.retryTarget).toMatchObject({ sessionId: SID, content: 'Why is the server slow?', code: 'timeout', mode: 'retry', detail: 'The gateway gave up.' });
    expect(activeRetryTarget(t)).not.toBeNull();
  });

  it('a fetch that throws is a disconnect (reload before re-sending)', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await store().sendMessage(TAB, 'hello');
    expect(tabOf().errorCode).toBe('disconnect');
    expect(tabOf().retryTarget).toMatchObject({ mode: 'reload_first', content: 'hello' });
  });

  it('an HTTP 503 with no code is http_5xx: the text goes back to the composer and can be re-sent', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Service unavailable' }, 503));
    await store().sendMessage(TAB, 'hello');
    const t = tabOf();
    expect(t.errorCode).toBe('http_5xx');
    expect(t.retryTarget).toMatchObject({ mode: 'resend', content: 'hello' });
    expect(t.composerDraft).toBe('hello');
    expect(userBubbles()).toHaveLength(0);
  });

  it('an HTTP 403 is rejected: no retry', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Forbidden' }, 403));
    await store().sendMessage(TAB, 'hello');
    expect(tabOf().errorCode).toBe('rejected');
    expect(tabOf().retryTarget).toBeNull();
  });

  it("a response body's own code always wins over the HTTP status", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'AI is disabled', code: 'topology_ai_disabled' }, 403));
    await store().sendMessage(TAB, 'hello');
    expect(tabOf().errorCode).toBe('topology_ai_disabled');
    expect(tabOf().retryTarget).toBeNull();
  });

  it('a non-retryable stream error (budget) leaves no retry target', async () => {
    fetchMock.mockResolvedValueOnce(sse([{ type: 'error', message: 'AI budget limit reached for this query.', code: 'budget_exceeded' }, { type: 'done' }]));
    await store().sendMessage(TAB, 'hello');
    expect(tabOf().errorCode).toBe('budget_exceeded');
    expect(tabOf().retryTarget).toBeNull();
  });

  it('a later, unrelated error retires the target (the banner no longer describes it)', async () => {
    await failWithTimeout();
    useWorkspaceStore.setState((s) => ({ tabs: s.tabs.map((t) => ({ ...t, error: 'Failed to approve' })) }));
    expect(activeRetryTarget(tabOf())).toBeNull();
  });
});

describe('workspaceStore.retryLastTurn (#9428)', () => {
  it('re-sends the failed message with retry:true, without a second bubble, and finalizes the stuck reply', async () => {
    await failWithTimeout();
    expect(userBubbles()).toHaveLength(1);
    fetchMock.mockResolvedValueOnce(okTurn());
    await store().retryLastTurn(TAB);
    expect(postBodies()[1]).toMatchObject({ content: 'Why is the server slow?', retry: true });
    expect(postBodies()[0]!.retry).toBeUndefined();
    const t = tabOf();
    expect(userBubbles()).toHaveLength(1);
    expect(t.error).toBeNull();
    expect(t.errorCode).toBeNull();
    expect(t.retryTarget).toBeNull();
    expect(t.messages.every((m) => !m.isStreaming)).toBe(true);
  });

  it('a reply left spinning by the failure is finalized by the retry', async () => {
    await failWithTimeout();
    useWorkspaceStore.setState((s) => ({
      tabs: s.tabs.map((t) => ({ ...t, messages: t.messages.map((m) => (m.role === 'assistant' ? { ...m, isStreaming: true } : m)) })),
    }));
    fetchMock.mockResolvedValueOnce(json({ error: 'busy', code: 'turn_in_progress' }, 409));
    fetchMock.mockResolvedValueOnce(idleAttach());
    await store().retryLastTurn(TAB);
    expect(tabOf().messages.filter((m) => m.role === 'assistant').every((m) => !m.isStreaming)).toBe(true);
  });

  it('a retry refused 409 turn_in_progress keeps the original bubble and attaches', async () => {
    await failWithTimeout();
    fetchMock.mockResolvedValueOnce(json({ error: 'busy', code: 'turn_in_progress' }, 409));
    fetchMock.mockResolvedValueOnce(idleAttach());
    await store().retryLastTurn(TAB);
    expect(userBubbles()).toHaveLength(1);
    expect(tabOf().composerDraft).toBe('');
  });

  it('a retry refused 409 continuation_required drops the bubble and points at the side panel', async () => {
    await failWithTimeout();
    fetchMock.mockResolvedValueOnce(json({ error: 'continue', code: 'continuation_required', reason: 'transcript_too_large' }, 409));
    await store().retryLastTurn(TAB);
    expect(userBubbles()).toHaveLength(0);
    expect(tabOf().errorAction).toBe('continue_in_panel');
  });

  it('a plain refusal on a retry keeps the bubble and the composer alone', async () => {
    await failWithTimeout();
    fetchMock.mockResolvedValueOnce(json({ error: 'Forbidden' }, 403));
    await store().retryLastTurn(TAB);
    expect(userBubbles()).toHaveLength(1);
    expect(tabOf().composerDraft).toBe('');
    expect(tabOf().errorCode).toBe('rejected');
  });

  it('does nothing while a turn is streaming (a double click never sends twice)', async () => {
    await failWithTimeout();
    fetchMock.mockClear();
    useWorkspaceStore.setState((s) => ({ tabs: s.tabs.map((t) => ({ ...t, isStreaming: true })) }));
    await store().retryLastTurn(TAB);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a double click sends once', async () => {
    await failWithTimeout();
    fetchMock.mockResolvedValueOnce(okTurn());
    await Promise.all([store().retryLastTurn(TAB), store().retryLastTurn(TAB)]);
    expect(postBodies()).toHaveLength(2);
  });

  it('does nothing once the tab moved to another session, and drops the target', async () => {
    await failWithTimeout();
    fetchMock.mockClear();
    useWorkspaceStore.setState((s) => ({ tabs: s.tabs.map((t) => ({ ...t, sessionId: 'sess-other' })) }));
    await store().retryLastTurn(TAB);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tabOf().retryTarget).toBeNull();
  });

  it('does nothing with no retry target', async () => {
    await store().retryLastTurn(TAB);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('http_5xx: re-sends the text as a new message and empties the composer', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Service unavailable' }, 503));
    await store().sendMessage(TAB, 'hello');
    fetchMock.mockResolvedValueOnce(okTurn());
    await store().retryLastTurn(TAB);
    expect(postBodies()[1]).toEqual(expect.objectContaining({ content: 'hello' }));
    expect(postBodies()[1]!.retry).toBeUndefined();
    expect(userBubbles()).toHaveLength(1);
    expect(tabOf().composerDraft).toBe('');
  });

  describe('after a disconnect it reloads first', () => {
    const session = { id: SID, status: 'active', type: 'general', orgId: null };
    const row = (id: string, role: string, content: string) => ({ id, role, content, createdAt: '2026-11-15T10:00:00.000Z' });

    async function disconnect() {
      fetchMock.mockRejectedValueOnce(new TypeError('network error'));
      await store().sendMessage(TAB, 'hello');
    }

    it('the stored transcript still ends with the message: re-sends with retry:true and no new bubble', async () => {
      await disconnect();
      fetchMock.mockResolvedValueOnce(json({ session, messages: [row('u1', 'user', 'hello')] }));
      fetchMock.mockResolvedValueOnce(okTurn());
      await store().retryLastTurn(TAB);
      expect(fetchMock).toHaveBeenCalledWith(`/ai/sessions/${SID}`);
      expect(postBodies()[1]).toMatchObject({ content: 'hello', retry: true });
      expect(userBubbles()).toHaveLength(1);
    });

    it('the turn finished server-side: shows the answer and sends nothing', async () => {
      await disconnect();
      fetchMock.mockResolvedValueOnce(json({ session, messages: [row('u1', 'user', 'hello'), row('a1', 'assistant', 'Hi!')] }));
      await store().retryLastTurn(TAB);
      expect(postBodies()).toHaveLength(1);
      expect(tabOf().messages.map((m) => m.content)).toEqual(['hello', 'Hi!']);
    });

    it('the message never reached the server: sends it as a new message', async () => {
      await disconnect();
      fetchMock.mockResolvedValueOnce(json({ session, messages: [row('u0', 'user', 'earlier'), row('a0', 'assistant', 'ok')] }));
      fetchMock.mockResolvedValueOnce(okTurn());
      await store().retryLastTurn(TAB);
      expect(postBodies()[1]).toEqual(expect.objectContaining({ content: 'hello' }));
      expect(postBodies()[1]!.retry).toBeUndefined();
      expect(userBubbles().map((m) => m.content)).toEqual(['earlier', 'hello']);
    });
  });
});

describe('per-tab isolation and clearError (#9428)', () => {
  it("retrying tab A does not touch tab B's state", async () => {
    useWorkspaceStore.setState({
      tabs: [tab(), tab({ id: 'tab-b', sessionId: 'sess-b', error: 'B broke', errorCode: 'timeout', errorDetail: 'bd', composerDraft: 'draft b' })],
      activeTabId: TAB,
    });
    const bBefore = JSON.stringify(tabOf('tab-b'));
    await failWithTimeout();
    fetchMock.mockResolvedValueOnce(okTurn());
    await store().retryLastTurn(TAB);
    expect(JSON.stringify(tabOf('tab-b'))).toBe(bBefore);
    expect(postBodies('sess-b')).toHaveLength(0);
  });

  it('clearError clears code, detail and target', async () => {
    await failWithTimeout('d');
    store().clearError(TAB);
    expect(tabOf()).toMatchObject({ error: null, errorCode: null, errorDetail: null, retryTarget: null });
  });

  it('transient retry fields are not persisted', async () => {
    await failWithTimeout('d');
    const stored = localStorage.getItem('breeze-workspace') ?? '';
    expect(stored).not.toContain('retryTarget');
    expect(stored).not.toContain('errorDetail');
  });
});
