import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({
  fetchWithAuth: vi.fn()
}));

import { fetchWithAuth } from './auth';
import { useAiStore } from './aiStore';
import { useAiModelPickerStore } from './aiModelPickerStore';

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
// Captured before any case spies on the store's own actions.
const realCreateSession = useAiStore.getState().createSession;
const realSendMessage = useAiStore.getState().sendMessage;

const makeResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

describe('ai store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAiStore.setState({
      isOpen: false,
      sessionId: null,
      messages: [],
      isStreaming: false,
      isLoading: false,
      error: null,
      pageContext: null,
      pendingApproval: null,
      sessions: [],
      showHistory: false,
      searchResults: [],
      isSearching: false,
      isInterrupting: false
    });
  });

  it('searchConversations short query clears results without request', async () => {
    useAiStore.setState({ searchResults: [{ id: 's1', title: 'old', matchedContent: 'old', createdAt: 'x' }] });

    await useAiStore.getState().searchConversations('a');

    expect(fetchWithAuthMock).not.toHaveBeenCalled();
    expect(useAiStore.getState().searchResults).toEqual([]);
    expect(useAiStore.getState().isSearching).toBe(false);
  });

  it('searchConversations populates results on success', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeResponse({
        data: [
          {
            id: 'session-1',
            title: 'Patch rollout',
            matchedContent: 'check deployment errors',
            createdAt: '2026-02-07T12:00:00.000Z'
          }
        ]
      })
    );

    await useAiStore.getState().searchConversations('patch');

    expect(fetchWithAuthMock).toHaveBeenCalledWith('/ai/sessions/search?q=patch&limit=20');
    expect(useAiStore.getState().searchResults).toHaveLength(1);
    expect(useAiStore.getState().isSearching).toBe(false);
  });

  it('switchSession loads messages and clears history panel', async () => {
    useAiStore.setState({ showHistory: true });

    fetchWithAuthMock.mockResolvedValueOnce(
      makeResponse({
        messages: [
          {
            id: 'm-1',
            role: 'assistant',
            content: 'Done',
            createdAt: '2026-02-07T12:30:00.000Z'
          }
        ]
      })
    );

    await useAiStore.getState().switchSession('session-1');

    expect(fetchWithAuthMock).toHaveBeenCalledWith('/ai/sessions/session-1');
    expect(useAiStore.getState().sessionId).toBe('session-1');
    expect(useAiStore.getState().showHistory).toBe(false);
    expect(useAiStore.getState().messages).toHaveLength(1);
    expect(useAiStore.getState().messages[0]?.createdAt).toBeInstanceOf(Date);
  });

  it('sendMessage ignores requests while streaming', async () => {
    useAiStore.setState({ sessionId: 'session-1', isStreaming: true });

    await useAiStore.getState().sendMessage('Hello');

    expect(fetchWithAuthMock).not.toHaveBeenCalled();
    expect(useAiStore.getState().messages).toHaveLength(0);
  });

  it('sendMessage rolls back optimistic message on 409 conflict', async () => {
    useAiStore.setState({ sessionId: 'session-1' });

    fetchWithAuthMock.mockResolvedValueOnce(
      makeResponse(
        { error: 'A message is already being processed for this session' },
        false,
        409
      )
    );

    await useAiStore.getState().sendMessage('Hello');

    expect(fetchWithAuthMock).toHaveBeenCalledWith('/ai/sessions/session-1/messages', {
      method: 'POST',
      body: JSON.stringify({ content: 'Hello', pageContext: undefined })
    });
    expect(useAiStore.getState().messages).toHaveLength(0);
    expect(useAiStore.getState().isStreaming).toBe(false);
    expect(useAiStore.getState().error).toContain('already being processed');
  });

  it('startDeviceTask forwards initialMessage to sendMessage', async () => {
    const state = useAiStore.getState();
    const createSpy = vi.spyOn(state, 'createSession').mockImplementation(async () => {
      useAiStore.setState({ sessionId: 'session-x' });
    });
    const sendSpy = vi.spyOn(state, 'sendMessage').mockResolvedValue();

    await useAiStore.getState().startDeviceTask(
      'dev-1',
      { type: 'device', id: 'dev-1', hostname: 'host-1' },
      'seed prompt',
    );

    expect(createSpy).toHaveBeenCalledWith({ deviceId: 'dev-1' });
    expect(sendSpy).toHaveBeenCalledWith('seed prompt');
    expect(useAiStore.getState().isOpen).toBe(true);
    expect(useAiStore.getState().pageContext).toEqual({ type: 'device', id: 'dev-1', hostname: 'host-1' });
  });

  it('startDeviceTask does not send when initialMessage is omitted', async () => {
    const state = useAiStore.getState();
    vi.spyOn(state, 'createSession').mockImplementation(async () => {
      useAiStore.setState({ sessionId: 'session-x' });
    });
    const sendSpy = vi.spyOn(state, 'sendMessage').mockResolvedValue();

    await useAiStore.getState().startDeviceTask('dev-1', { type: 'device', id: 'dev-1', hostname: 'host-1' });

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('startDeviceTask does not send when session creation failed', async () => {
    const state = useAiStore.getState();
    vi.spyOn(state, 'createSession').mockImplementation(async () => {
      useAiStore.setState({ sessionId: null, error: 'nope' });
    });
    const sendSpy = vi.spyOn(state, 'sendMessage').mockResolvedValue();

    await useAiStore.getState().startDeviceTask('dev-1', { type: 'device', id: 'dev-1', hostname: 'host-1' }, 'seed prompt');

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('clearPendingApproval nulls pendingApproval', () => {
    // Wired to AiApprovalDialog's onIntentDecided: after an inline sole-operator
    // self-approve the intent is already settled server-side, so the card must
    // come down without going back through the legacy approve endpoint.
    useAiStore.setState({
      pendingApproval: {
        executionId: 'exec-1',
        toolName: 'file_operations',
        input: {},
        description: 'Read a file',
        intentBacked: true,
        selfApprovalRequestId: 'ap-1'
      }
    });

    useAiStore.getState().clearPendingApproval();

    expect(useAiStore.getState().pendingApproval).toBeNull();
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('createSession sends an explicit topology page context without device or M365 binding (M4)', async () => {
    // Earlier cases spy on createSession itself; exercise the real action.
    useAiStore.setState({ createSession: realCreateSession, pageContext: { type: 'dashboard' }, selectedM365ConnectionId: 'conn-1' } as never);
    fetchWithAuthMock.mockResolvedValueOnce(makeResponse({ id: 'sess-topo', orgId: 'org-1', delegantM365ConnectionId: null }));
    const topology = { type: 'topology' as const, siteId: 'site-1', subject: { kind: 'node' as const, id: 'node-1' }, view: 'physical' as const, graphRevision: '7' };

    await useAiStore.getState().createSession({ pageContext: topology });

    const [, init] = fetchWithAuthMock.mock.calls[0]!;
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.pageContext).toEqual(topology);
    expect(body).not.toHaveProperty('delegantM365ConnectionId');
    expect(body).not.toHaveProperty('deviceId');
    expect(useAiStore.getState().sessionId).toBe('sess-topo');
  });

  describe('W05 model choice on sendMessage', () => {
    const streamResponse = (events: unknown[]): Response => {
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
          c.close();
        }
      });
      return { ok: true, status: 200, body: stream, json: vi.fn() } as unknown as Response;
    };
    const mockStreamResponse = (events: unknown[]) => fetchWithAuthMock.mockResolvedValueOnce(streamResponse(events));
    const mockJsonResponse = (status: number, payload: unknown) =>
      fetchWithAuthMock.mockResolvedValueOnce(makeResponse(payload, status < 400, status));
    const lastPostBody = (suffix: string): string => {
      const call = [...fetchWithAuthMock.mock.calls].reverse().find(([url, init]) =>
        String(url).endsWith(suffix) && (init as RequestInit | undefined)?.method === 'POST');
      return String((call?.[1] as RequestInit).body);
    };

    beforeEach(() => {
      useAiModelPickerStore.getState().reset();
      useAiStore.setState({ createSession: realCreateSession, sendMessage: realSendMessage } as never);
    });

    it('sends the composer\'s pending model choice, and commits it after the reply (W05)', async () => {
      useAiStore.setState({ sessionId: 'session-1' });
      useAiModelPickerStore.setState({ choices: { surface: 'chat', allowUserChoice: true, defaultOfferingId: 'def', choices: [], current: { offeringId: 'def', options: null } }, selection: { offeringId: 'haiku', options: {} } });
      mockStreamResponse([{ type: 'done' }]);
      await useAiStore.getState().sendMessage('hi');
      expect(JSON.parse(lastPostBody('/messages')).model).toEqual({ offeringId: 'haiku', options: {} });
      expect(useAiModelPickerStore.getState().choices!.current!.offeringId).toBe('haiku');
    });

    it('a model picked before the first message creates the session ON that model (Codex review finding 12)', async () => {
      useAiStore.setState({ sessionId: null });
      useAiModelPickerStore.setState({ choices: { surface: 'chat', allowUserChoice: true, defaultOfferingId: 'def', choices: [], current: null }, selection: { offeringId: 'haiku', options: { budgetThinking: 'on' } } });
      mockJsonResponse(201, { id: 'new-1', orgId: 'o1' });
      mockJsonResponse(200, { data: { surface: 'chat', allowUserChoice: true, defaultOfferingId: 'def', choices: [], current: { offeringId: 'haiku', options: { budgetThinking: 'on' } } } });
      mockStreamResponse([{ type: 'done' }]);
      await useAiStore.getState().sendMessage('first');
      expect(JSON.parse(lastPostBody('/ai/sessions'))).toMatchObject({ offeringId: 'haiku', options: { budgetThinking: 'on' } });
      expect(JSON.parse(lastPostBody('/messages'))).not.toHaveProperty('model');
    });

    it('a 409 continuation_required parks the message for the continuation prompt instead of showing an error (W05)', async () => {
      useAiStore.setState({ sessionId: 'session-1' });
      useAiModelPickerStore.setState({ selection: { offeringId: 'haiku' } });
      mockJsonResponse(409, { error: 'too long', code: 'continuation_required', reason: 'transcript_too_large', recoverable: true, target: { offeringId: 'haiku', displayName: 'Haiku 4.5' } });
      await useAiStore.getState().sendMessage('next question');
      expect(useAiModelPickerStore.getState().continuation).toMatchObject({ pendingContent: 'next question', required: { reason: 'transcript_too_large' } });
      expect(useAiStore.getState().error).toBeNull();
      expect(useAiStore.getState().messages.some((m) => m.content === 'next question')).toBe(false);
    });
  });
});
