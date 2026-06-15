import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  createSession,
  decodeStreamFrame,
  flagSession,
  getTemplates,
  listSessions,
  sendMessage,
  streamEvents,
} from './client';
import { clearSession, getSessionToken, reExchange } from '../auth/session';
import type { ClientAiStreamEvent } from './types';

vi.mock('../auth/session', async () => {
  const actual = await vi.importActual<typeof import('../auth/session')>('../auth/session');
  return {
    ...actual,
    getSessionToken: vi.fn(() => 'breeze-token'),
    reExchange: vi.fn(async () => ({}) as never),
    clearSession: vi.fn(),
  };
});

const getSessionTokenMock = vi.mocked(getSessionToken);
const reExchangeMock = vi.mocked(reExchange);
const clearSessionMock = vi.mocked(clearSession);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const encoder = new TextEncoder();

function sseResponse(frames: string, opts: { keepOpen?: boolean } = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames));
      if (!opts.keepOpen) controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

beforeEach(() => {
  getSessionTokenMock.mockReturnValue('breeze-token');
  reExchangeMock.mockClear();
  clearSessionMock.mockClear();
});

describe('apiFetch wrappers', () => {
  it('attaches the Authorization bearer header and returns the session governance (201)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(201, { sessionId: 'sess-1', writeMode: 'readwrite', writeApproval: 'allow_auto' })
    );
    await expect(createSession({}, fetchImpl as unknown as typeof fetch)).resolves.toEqual({
      sessionId: 'sess-1',
      writeMode: 'readwrite',
      writeApproval: 'allow_auto',
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/client-ai/sessions');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer breeze-token');
    expect((init.headers as Headers).get('Content-Type')).toBe('application/json');
  });

  it('sends the workbookName in the create body when provided', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, { sessionId: 'sess-wb' }));
    await expect(
      createSession({ workbookName: 'Q3 Budget.xlsx' }, fetchImpl as unknown as typeof fetch),
    ).resolves.toMatchObject({ sessionId: 'sess-wb' });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ workbookName: 'Q3 Budget.xlsx' });
  });

  it('default-denies writeApproval: a response without the field collapses to ask', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, { sessionId: 'sess-1' }));
    await expect(createSession({}, fetchImpl as unknown as typeof fetch)).resolves.toEqual({
      sessionId: 'sess-1',
      writeMode: 'readwrite',
      writeApproval: 'ask',
    });
  });

  it('on 401 runs the single-flight re-exchange and retries once', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: 'invalid_token' }))
      .mockResolvedValueOnce(jsonResponse(201, { sessionId: 'sess-2' }));
    await expect(createSession({}, fetchImpl as unknown as typeof fetch)).resolves.toMatchObject({
      sessionId: 'sess-2',
    });
    expect(reExchangeMock).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('propagates a 401 that survives the re-exchange and clears the session', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: 'invalid_token' }));
    const err = await createSession({}, fetchImpl as unknown as typeof fetch).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(clearSessionMock).toHaveBeenCalled();
  });

  it('listSessions returns the sessions array from the { sessions } envelope', async () => {
    const item = {
      id: 's1',
      title: 'Budget review',
      workbookName: 'Q3 Budget.xlsx',
      status: 'active',
      createdAt: '2026-06-13T10:00:00Z',
      lastActivityAt: '2026-06-13T10:05:00Z',
      updatedAt: '2026-06-13T10:05:00Z',
      messageCount: 4,
    };
    const fetchImpl = vi.fn(async () => jsonResponse(200, { sessions: [item] }));
    await expect(listSessions(undefined, fetchImpl as unknown as typeof fetch)).resolves.toEqual([item]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/client-ai/sessions');
    expect(url).not.toContain('host=');
    expect(init.method ?? 'GET').toBe('GET');
  });

  it('listSessions forwards the host as a ?host= query when provided', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { sessions: [] }));
    await listSessions('word', fetchImpl as unknown as typeof fetch);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain('/client-ai/sessions?host=word');
  });

  it('listSessions tolerates a malformed body by returning an empty list', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { not_sessions: true }));
    await expect(listSessions(undefined, fetchImpl as unknown as typeof fetch)).resolves.toEqual([]);
  });

  it('surfaces server rejection codes (budget_exceeded) as ApiError', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(403, { error: 'budget_exceeded' }));
    const err = await sendMessage('sess-1', { content: 'hi' }, fetchImpl as unknown as typeof fetch).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('budget_exceeded');
  });

  it('flagSession POSTs the trimmed reason to /sessions/:id/flag', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { success: true }));
    await flagSession('sess-9', '  looks wrong  ', fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/client-ai/sessions/sess-9/flag');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ reason: 'looks wrong' });
  });

  it('flagSession sends an empty body when no reason is given', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { success: true }));
    await flagSession('sess-9', undefined, fetchImpl as unknown as typeof fetch);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  it('getTemplates accepts both the pinned bare array and a {data:[...]} envelope', async () => {
    const template = { id: 't1', name: 'T', description: null, category: null, body: 'B' };
    const bare = vi.fn(async () => jsonResponse(200, [template]));
    await expect(getTemplates(undefined, bare as unknown as typeof fetch)).resolves.toEqual([template]);
    const wrapped = vi.fn(async () => jsonResponse(200, { data: [template] }));
    await expect(getTemplates(undefined, wrapped as unknown as typeof fetch)).resolves.toEqual([template]);
  });

  it('getTemplates forwards the host as a ?host= query param', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, []));
    await getTemplates('powerpoint', fetchImpl as unknown as typeof fetch);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain('/client-ai/templates?host=powerpoint');
  });
});

describe('decodeStreamFrame', () => {
  it('types known events, passes ping without payload, and skips unknown names', () => {
    expect(decodeStreamFrame({ event: 'message_delta', data: '{"text":"hi"}' })).toEqual({
      type: 'message_delta',
      text: 'hi',
    });
    expect(decodeStreamFrame({ event: 'ping', data: '{}' })).toEqual({ type: 'ping' });
    expect(decodeStreamFrame({ event: 'turn_complete', data: '{"usage":null}' })).toEqual({
      type: 'turn_complete',
      usage: null,
    });
    expect(decodeStreamFrame({ event: 'some_future_event', data: '{}' })).toBeNull();
  });
});

describe('streamEvents', () => {
  it('reconnects after a dropped stream with backoff and calls onReconnect', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(sseResponse('event: message_delta\ndata: {"text":"a"}\n\n'))
      .mockResolvedValueOnce(
        sseResponse('event: message_delta\ndata: {"text":"b"}\n\n', { keepOpen: true }),
      );
    const events: ClientAiStreamEvent[] = [];
    const onReconnect = vi.fn();
    const handle = streamEvents(
      'sess-1',
      { onEvent: (e) => events.push(e), onReconnect },
      fetchImpl as unknown as typeof fetch,
      [10], // test-only backoff schedule
    );
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events.map((e) => (e.type === 'message_delta' ? e.text : ''))).toEqual(['a', 'b']);
    expect(onReconnect).toHaveBeenCalledTimes(1);
    handle.stop();
  });
});
