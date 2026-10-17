import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const runActionMock = vi.hoisted(() => vi.fn());
vi.mock('./runAction', async (orig) => ({
  ...(await orig<typeof import('./runAction')>()),
  runAction: runActionMock,
}));

import { fetchWithAuth } from '../stores/auth';
import {
  ChatReadError,
  closeConversation,
  latestMessageStamp,
  createConversationPoller,
  deviceChatCapability,
  getConversation,
  isLiveStatus,
  listConversations,
  mergeMessages,
  openConversation,
  sendChatMessage,
  type ChatConversation,
  type ChatMessage,
} from './endpointChat';

const authMock = vi.mocked(fetchWithAuth);
const res = (status: number, payload: unknown) =>
  ({ ok: status < 400, status, json: async () => payload }) as Response;

const conv = (over: Partial<ChatConversation> = {}): ChatConversation => ({
  id: 'c1', orgId: 'o1', deviceId: 'd1', status: 'open', allowUserReply: true,
  targetUsername: null, errorCode: null, closeReason: null, openedBy: null,
  createdAt: '2026-10-17T10:00:00.000Z', lastActivityAt: '2026-10-17T10:00:00.000Z', closedAt: null,
  ...over,
});
const msg = (id: string, createdAt: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id, conversationId: 'c1', direction: 'to_user', body: id, senderName: 'Tech', senderUsername: null,
  createdAt, deliveredAt: null, errorCode: null, ...over,
});

describe('deviceChatCapability', () => {
  it('is unsupported off Windows (platform)', () => {
    expect(deviceChatCapability({ osType: 'macos', agentVersion: '999.0.0' })).toEqual({ supported: false, reason: 'platform' });
  });
  it('is unsupported for old agents (agent_version)', () => {
    expect(deviceChatCapability({ osType: 'windows', agentVersion: '0.100.0' })).toEqual({ supported: false, reason: 'agent_version' });
    expect(deviceChatCapability({ osType: 'windows', agentVersion: null })).toEqual({ supported: false, reason: 'agent_version' });
  });
  it('is supported on Windows with a new enough agent', () => {
    expect(deviceChatCapability({ osType: 'windows', agentVersion: '999.0.0' })).toEqual({ supported: true });
  });
});

describe('mergeMessages / isLiveStatus', () => {
  it('merges by id, keeps createdAt order, later copy wins', () => {
    const merged = mergeMessages([msg('a', '2026-10-17T10:00:01Z'), msg('b', '2026-10-17T10:00:03Z')], [
      msg('c', '2026-10-17T10:00:02Z'),
      msg('b', '2026-10-17T10:00:03Z', { deliveredAt: 'x' }),
    ]);
    expect(merged.map((m) => m.id)).toEqual(['a', 'c', 'b']);
    expect(merged[2]!.deliveredAt).toBe('x');
  });
  it('only opening/open are live', () => {
    expect(['opening', 'open'].every((s) => isLiveStatus(s as never))).toBe(true);
    expect(['closed', 'expired', 'failed'].some((s) => isLiveStatus(s as never))).toBe(false);
  });
});

describe('API client', () => {
  beforeEach(() => { authMock.mockReset(); runActionMock.mockReset(); });

  it('lists by deviceId and reads a conversation with since', async () => {
    authMock.mockResolvedValue(res(200, { conversations: [conv()] }));
    await expect(listConversations('d 1')).resolves.toHaveLength(1);
    expect(authMock.mock.calls[0]![0]).toBe('/endpoint-messages/conversations?deviceId=d%201');
    authMock.mockResolvedValue(res(200, { conversation: conv(), messages: [] }));
    await getConversation('c1', '2026-10-17T10:00:00.000Z');
    authMock.mockResolvedValue(res(404, {}));
    await expect(getConversation('c1')).rejects.toMatchObject({ status: 404 });
    authMock.mockResolvedValue(res(200, { conversation: conv(), messages: [] }));
    expect(authMock.mock.calls[1]![0]).toBe('/endpoint-messages/conversations/c1?since=2026-10-17T10%3A00%3A00.000Z');
  });

  it('open / message / close go through runAction with the right request', async () => {
    runActionMock.mockImplementation(async (o: { request: () => Promise<Response> }) => { await o.request(); return {}; });
    authMock.mockResolvedValue(res(200, {}));
    await openConversation({ conversationId: 'c1', deviceId: 'd1', body: 'hi' }, { errorFallback: 'x' });
    await sendChatMessage('c1', { messageId: 'm1', body: 'yo' }, { errorFallback: 'x' });
    await closeConversation('c1', { errorFallback: 'x' });
    expect(runActionMock).toHaveBeenCalledTimes(3);
    expect(authMock.mock.calls.map((c) => [c[0], (c[1] as RequestInit).method])).toEqual([
      ['/endpoint-messages/conversations', 'POST'],
      ['/endpoint-messages/conversations/c1/messages', 'POST'],
      ['/endpoint-messages/conversations/c1/close', 'POST'],
    ]);
    expect(JSON.parse(String((authMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ conversationId: 'c1', deviceId: 'd1', body: 'hi' });
    expect(JSON.parse(String((authMock.mock.calls[1]![1] as RequestInit).body))).toEqual({ messageId: 'm1', body: 'yo' });
  });
});

describe('createConversationPoller', () => {
  let visibility: 'visible' | 'hidden';
  const setVisibility = (v: 'visible' | 'hidden') => {
    visibility = v;
    document.dispatchEvent(new Event('visibilitychange'));
  };
  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const make = (statuses: ChatConversation['status'][], onUpdate = vi.fn()) => {
    let i = 0;
    const fetchOnce = vi.fn(async (_id: string, _since?: string) => ({
      conversation: conv({ status: statuses[Math.min(i++, statuses.length - 1)]! }),
      messages: [msg(`m${i}`, `2026-10-17T10:00:0${i}.000Z`)],
    }));
    const poller = createConversationPoller({ conversationId: 'c1', initialStatus: 'open', fetchConversation: fetchOnce, onUpdate });
    return { poller, fetchOnce, onUpdate };
  };

  it('polls every 3000 ms while visible and live, passing since', async () => {
    const { poller, fetchOnce } = make(['open']);
    poller.start();
    expect(fetchOnce).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchOnce).toHaveBeenCalledTimes(2);
    expect(fetchOnce.mock.calls[1]![1]).toBe('2026-10-17T10:00:01.000Z');
    poller.stop();
  });

  it('stops while the tab is hidden and resumes (with a catch-up poll) when visible', async () => {
    const { poller, fetchOnce } = make(['open']);
    poller.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchOnce).toHaveBeenCalledTimes(1);
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(30000);
    expect(fetchOnce).toHaveBeenCalledTimes(1);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchOnce).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchOnce).toHaveBeenCalledTimes(3);
    poller.stop();
  });

  it('does not poll at all when started while hidden', async () => {
    visibility = 'hidden';
    const { poller, fetchOnce } = make(['open']);
    poller.start();
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetchOnce).not.toHaveBeenCalled();
    poller.stop();
  });

  it.each(['closed', 'expired', 'failed'] as const)('stops for good on %s, even after visibility returns', async (status) => {
    const { poller, fetchOnce, onUpdate } = make(['open', status]);
    poller.start();
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchOnce).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ conversation: expect.objectContaining({ status }) }));
    await vi.advanceTimersByTimeAsync(30000);
    setVisibility('hidden');
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(30000);
    expect(fetchOnce).toHaveBeenCalledTimes(2);
  });

  it('stops on unmount (stop()) and ignores an in-flight result afterwards', async () => {
    const { poller, fetchOnce, onUpdate } = make(['open']);
    poller.start();
    await vi.advanceTimersByTimeAsync(3000);
    poller.stop();
    await vi.advanceTimersByTimeAsync(30000);
    expect(fetchOnce).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('keeps polling after a transient fetch error and reports it', async () => {
    const onError = vi.fn();
    const fetchOnce = vi.fn()
      .mockRejectedValueOnce(new Error('net'))
      .mockResolvedValue({ conversation: conv(), messages: [] });
    const poller = createConversationPoller({ conversationId: 'c1', initialStatus: 'opening', fetchConversation: fetchOnce, onUpdate: vi.fn(), onError });
    poller.start();
    await vi.advanceTimersByTimeAsync(6000);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(fetchOnce).toHaveBeenCalledTimes(2);
    poller.stop();
  });
  it('advances the cursor by updatedAt (falling back to createdAt), not createdAt alone (W1)', async () => {
    const fetchOnce = vi.fn(async (_id: string, _since?: string) => ({
      conversation: conv(),
      messages: [msg('a', '2026-10-17T10:00:01.000Z', { updatedAt: '2026-10-17T10:00:09.000Z' }), msg('b', '2026-10-17T10:00:05.000Z')],
    }));
    const poller = createConversationPoller({ conversationId: 'c1', initialStatus: 'open', fetchConversation: fetchOnce, onUpdate: vi.fn() });
    poller.start();
    await vi.advanceTimersByTimeAsync(6000);
    expect(fetchOnce.mock.calls[1]![1]).toBe('2026-10-17T10:00:09.000Z');
    poller.stop();
  });

  it('latestMessageStamp is the max of updatedAt ?? createdAt', () => {
    expect(latestMessageStamp([])).toBeUndefined();
    expect(latestMessageStamp([msg('a', '2026-10-17T10:00:01.000Z', { updatedAt: '2026-10-17T10:00:07.000Z' }), msg('b', '2026-10-17T10:00:05.000Z')])).toBe('2026-10-17T10:00:07.000Z');
  });

  it.each([403, 404])('stops for good on a terminal %s and reports it as terminal (W3)', async (status) => {
    const onError = vi.fn();
    const fetchOnce = vi.fn().mockRejectedValue(new ChatReadError(status));
    const poller = createConversationPoller({ conversationId: 'c1', initialStatus: 'open', fetchConversation: fetchOnce, onUpdate: vi.fn(), onError });
    poller.start();
    await vi.advanceTimersByTimeAsync(30000);
    expect(fetchOnce).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(ChatReadError), true);
  });

  it('reports a transient error as non-terminal (W3)', async () => {
    const onError = vi.fn();
    const fetchOnce = vi.fn().mockRejectedValue(new ChatReadError(503));
    const poller = createConversationPoller({ conversationId: 'c1', initialStatus: 'open', fetchConversation: fetchOnce, onUpdate: vi.fn(), onError });
    poller.start();
    await vi.advanceTimersByTimeAsync(6000);
    expect(onError).toHaveBeenCalledWith(expect.any(ChatReadError), false);
    expect(fetchOnce).toHaveBeenCalledTimes(2);
    poller.stop();
  });
});
