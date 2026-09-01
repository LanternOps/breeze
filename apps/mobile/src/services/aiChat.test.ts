import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAiSession, listAiSessions, streamChat } from './aiChat';
import type { AiStreamEvent } from './aiChat';
import { refreshToken } from './api';
import { storeToken } from './auth';
import { fetchWithTimeout } from './fetchWithTimeout';
import { advanceSessionGeneration } from './sessionGeneration';

vi.mock('./serverConfig', () => ({
  getServerUrl: vi.fn().mockResolvedValue('https://api.test'),
}));

vi.mock('@sentry/react-native', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn().mockResolvedValue('stale-token'),
}));

vi.mock('./fetchWithTimeout', () => ({
  fetchWithTimeout: vi.fn(),
}));

// api.ts pulls in Sentry/installation-id modules that don't exist in the node
// test environment — mock the whole module, we only need refreshToken.
vi.mock('./api', () => ({
  refreshToken: vi.fn(),
}));

vi.mock('./auth', () => ({
  storeToken: vi.fn().mockResolvedValue(undefined),
}));

const fetchMock = vi.mocked(fetchWithTimeout);
const refreshMock = vi.mocked(refreshToken);
const storeTokenMock = vi.mocked(storeToken);

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const sessionsBody = { data: [{ id: 's1', title: 'hi', status: 'active', turnCount: 1, lastActivityAt: null, createdAt: 'now' }] };

beforeEach(() => {
  vi.clearAllMocks();
  storeTokenMock.mockResolvedValue(undefined);
});

describe('authedFetch 401 refresh-and-retry (via listAiSessions)', () => {
  it('does not refresh when the request succeeds', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(sessionsBody));

    const sessions = await listAiSessions();

    expect(sessions).toHaveLength(1);
    expect(refreshMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes on 401, persists the new token, and retries once with it', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(jsonResponse(sessionsBody));
    refreshMock.mockResolvedValueOnce({ token: 'fresh-token' });

    const sessions = await listAiSessions();

    expect(sessions).toHaveLength(1);
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(storeTokenMock).toHaveBeenCalledWith('fresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstHeaders = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    const retryHeaders = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(firstHeaders.Authorization).toBe('Bearer stale-token');
    expect(retryHeaders.Authorization).toBe('Bearer fresh-token');
  });

  it('surfaces the original 401 when the refresh itself fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401));
    refreshMock.mockRejectedValueOnce({ message: 'Failed to refresh token' });

    await expect(listAiSessions()).rejects.toThrow('listAiSessions failed: 401');
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry without a new token
  });

  it('retries only once — a second 401 is returned, not re-refreshed', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401));
    refreshMock.mockResolvedValueOnce({ token: 'fresh-token' });

    await expect(listAiSessions()).rejects.toThrow('listAiSessions failed: 401');
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('still retries with the refreshed token when persisting it fails', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(jsonResponse(sessionsBody));
    refreshMock.mockResolvedValueOnce({ token: 'fresh-token' });
    storeTokenMock.mockRejectedValueOnce(new Error('Failed to store authentication token'));

    const sessions = await listAiSessions();

    expect(sessions).toHaveLength(1);
    const retryHeaders = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe('Bearer fresh-token');
  });

  it('replays a POST retry with the same method, body, and CSRF header', async () => {
    const created = { id: 's9', title: null, orgId: 'o1', createdAt: 'now' };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(jsonResponse(created));
    refreshMock.mockResolvedValueOnce({ token: 'fresh-token' });

    const session = await createAiSession({ title: 'hello' });

    expect(session.id).toBe('s9');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [retryUrl, retryInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(retryUrl).toBe(firstUrl);
    expect(retryInit.method).toBe('POST');
    expect(retryInit.body).toBe(firstInit.body);
    expect(retryInit.body).toBe(JSON.stringify({ title: 'hello' }));
    const retryHeaders = retryInit.headers as Record<string, string>;
    expect(retryHeaders['x-breeze-csrf']).toBe('1');
    expect(retryHeaders.Authorization).toBe('Bearer fresh-token');
  });

  it('clears the single-flight guard after a failed refresh so a later 401 refreshes again', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401));
    refreshMock.mockRejectedValueOnce({ message: 'offline' });
    await expect(listAiSessions()).rejects.toThrow('listAiSessions failed: 401');

    // A transient failure must not poison the guard: the next 401 refreshes.
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(jsonResponse(sessionsBody));
    refreshMock.mockResolvedValueOnce({ token: 'fresh-token' });

    const sessions = await listAiSessions();

    expect(sessions).toHaveLength(1);
    expect(refreshMock).toHaveBeenCalledTimes(2);
  });

  it('single-flights concurrent 401s into one refresh call', async () => {
    // Both concurrent requests 401 first, then both retries succeed.
    fetchMock.mockImplementation(async (_url, init) => {
      const headers = (init as RequestInit).headers as Record<string, string>;
      return headers.Authorization === 'Bearer fresh-token'
        ? jsonResponse(sessionsBody)
        : jsonResponse({ error: 'Unauthorized' }, 401);
    });
    let resolveRefresh: (v: { token: string }) => void;
    refreshMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveRefresh = resolve; }),
    );

    const p1 = listAiSessions();
    const p2 = listAiSessions();
    // Let both initial requests hit the 401 and enter the refresh path.
    await new Promise((r) => setTimeout(r, 0));
    resolveRefresh!({ token: 'fresh-token' });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry or accept bearer persistence superseded while storeToken is slow', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401));
    refreshMock.mockResolvedValueOnce({ token: 'fresh-from-a' });
    let releaseStore!: () => void;
    let markStoreStarted!: () => void;
    const storeStarted = new Promise<void>((resolve) => { markStoreStarted = resolve; });
    const storeRelease = new Promise<void>((resolve) => { releaseStore = resolve; });
    storeTokenMock.mockImplementationOnce(async () => {
      markStoreStarted();
      await storeRelease;
    });

    const staleRequest = listAiSessions();
    await storeStarted;
    advanceSessionGeneration();
    releaseStore();

    await expect(staleRequest).rejects.toThrow('listAiSessions failed: 401');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// streamChat SSE 401 refresh-and-reopen (#3140)
// ---------------------------------------------------------------------------

class FakeXhr {
  static instances: FakeXhr[] = [];
  method = '';
  url = '';
  headers: Record<string, string> = {};
  withCredentials = false;
  readyState = 0;
  status = 0;
  responseText = '';
  sentBody: string | null = null;
  abortCalled = false;
  onreadystatechange: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    FakeXhr.instances.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
    this.readyState = 1;
  }

  setRequestHeader(key: string, value: string): void {
    this.headers[key] = value;
  }

  // When set, the next send() throws synchronously (simulates platform-level
  // XHR failures on RN/Hermes). One-shot: cleared on use.
  static throwOnNextSend: Error | null = null;

  send(body: string): void {
    if (FakeXhr.throwOnNextSend) {
      const err = FakeXhr.throwOnNextSend;
      FakeXhr.throwOnNextSend = null;
      throw err;
    }
    this.sentBody = body;
  }

  abort(): void {
    this.abortCalled = true;
  }

  // Test helpers — simulate server behavior.
  emitChunk(status: number, text: string): void {
    this.status = status;
    this.responseText += text;
    this.readyState = 3;
    this.onreadystatechange?.();
  }

  finish(status: number, text = ''): void {
    this.status = status;
    this.responseText += text;
    this.readyState = 4;
    this.onreadystatechange?.();
  }
}

const flushAsync = () => new Promise((r) => setTimeout(r, 0));

function startStream() {
  const events: AiStreamEvent[] = [];
  const onError = vi.fn();
  const onDone = vi.fn();
  const handle = streamChat({
    sessionId: 'sess-1',
    content: 'hello there',
    onEvent: (e) => events.push(e),
    onError,
    onDone,
  });
  return { events, onError, onDone, handle };
}

describe('streamChat 401 refresh-and-reopen', () => {
  beforeEach(() => {
    FakeXhr.instances = [];
    FakeXhr.throwOnNextSend = null;
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
  });

  it('streams without refreshing when the token is still valid', async () => {
    const { events, onError, onDone } = startStream();
    await flushAsync();

    expect(FakeXhr.instances).toHaveLength(1);
    const xhr = FakeXhr.instances[0];
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('https://api.test/api/v1/ai/sessions/sess-1/messages');
    expect(xhr.headers.Authorization).toBe('Bearer stale-token');
    expect(xhr.headers.Accept).toBe('text/event-stream');
    expect(xhr.headers['x-breeze-csrf']).toBe('1');
    expect(xhr.sentBody).toBe(JSON.stringify({ content: 'hello there' }));

    xhr.emitChunk(200, 'event: content_delta\ndata: {"type":"content_delta","delta":"hi"}\n\n');
    xhr.finish(200, 'event: done\ndata: {"type":"done"}\n\n');

    expect(events).toEqual([
      { type: 'content_delta', delta: 'hi' },
      { type: 'done' },
    ]);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('refreshes on 401 at stream open and reopens once with the fresh token', async () => {
    refreshMock.mockResolvedValueOnce({ token: 'fresh-token' } as Awaited<ReturnType<typeof refreshToken>>);
    const { events, onError, onDone } = startStream();
    await flushAsync();

    // Real RN XHR delivers the 401 body incrementally at readyState 3
    // (status is already set at HEADERS_RECEIVED) before DONE — mirror that
    // sequence so the parse-skip guard is exercised where it matters.
    FakeXhr.instances[0].emitChunk(401, '{"error":"Unauthorized"}');
    FakeXhr.instances[0].finish(401);
    await flushAsync();

    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(storeTokenMock).toHaveBeenCalledWith('fresh-token');
    expect(FakeXhr.instances).toHaveLength(2);
    const retry = FakeXhr.instances[1];
    expect(retry.url).toBe(FakeXhr.instances[0].url);
    expect(retry.headers.Authorization).toBe('Bearer fresh-token');
    expect(retry.sentBody).toBe(FakeXhr.instances[0].sentBody);

    retry.emitChunk(200, 'event: content_delta\ndata: {"type":"content_delta","delta":"hi"}\n\n');
    retry.finish(200, 'event: done\ndata: {"type":"done"}\n\n');

    // The 401 body never reached callbacks; the retried stream did.
    expect(events).toEqual([
      { type: 'content_delta', delta: 'hi' },
      { type: 'done' },
    ]);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('surfaces the original 401 when the refresh fails, without reopening', async () => {
    refreshMock.mockRejectedValueOnce({ message: 'Failed to refresh token' });
    const { events, onError, onDone } = startStream();
    await flushAsync();

    FakeXhr.instances[0].finish(401, '{"error":"Unauthorized"}');
    await flushAsync();

    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(FakeXhr.instances).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe('Unauthorized');
    expect(onDone).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('reopens only once — a second 401 surfaces without another refresh', async () => {
    refreshMock.mockResolvedValueOnce({ token: 'fresh-token' } as Awaited<ReturnType<typeof refreshToken>>);
    const { onError } = startStream();
    await flushAsync();

    FakeXhr.instances[0].finish(401, '{"error":"Unauthorized"}');
    await flushAsync();
    expect(FakeXhr.instances).toHaveLength(2);

    FakeXhr.instances[1].finish(401, '{"error":"Unauthorized"}');
    await flushAsync();

    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(FakeXhr.instances).toHaveLength(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe('Unauthorized');
  });

  it('does not reopen when aborted while the refresh is in flight', async () => {
    let resolveRefresh: (v: { token: string }) => void;
    refreshMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveRefresh = resolve; }) as ReturnType<typeof refreshToken>,
    );
    const { onError, onDone, handle } = startStream();
    await flushAsync();

    FakeXhr.instances[0].finish(401, '{"error":"Unauthorized"}');
    await flushAsync();

    handle.abort();
    resolveRefresh!({ token: 'fresh-token' });
    await flushAsync();

    expect(FakeXhr.instances).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('abort() aborts the retried stream, not the dead 401 attempt', async () => {
    refreshMock.mockResolvedValueOnce({ token: 'fresh-token' } as Awaited<ReturnType<typeof refreshToken>>);
    const { handle } = startStream();
    await flushAsync();

    FakeXhr.instances[0].finish(401, '{"error":"Unauthorized"}');
    await flushAsync();
    expect(FakeXhr.instances).toHaveLength(2);

    handle.abort();
    expect(FakeXhr.instances[1].abortCalled).toBe(true);
  });

  it('surfaces a throw from the retried open via onError instead of hanging', async () => {
    refreshMock.mockResolvedValueOnce({ token: 'fresh-token' } as Awaited<ReturnType<typeof refreshToken>>);
    const { onError, onDone } = startStream();
    await flushAsync();

    FakeXhr.throwOnNextSend = new Error('send exploded');
    FakeXhr.instances[0].finish(401, '{"error":"Unauthorized"}');
    await flushAsync();

    // The retry attempt threw synchronously — the caller must still get an
    // error callback rather than a permanently "streaming" chat.
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe('send exploded');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('shares one single-flight refresh between a streamChat 401 and a concurrent authedFetch 401', async () => {
    // Replaying a rotated refresh token revokes the whole token family, so a
    // chat send racing a REST call at token expiry MUST coalesce into ONE
    // /auth/refresh across both paths.
    let resolveRefresh: (v: { token: string }) => void;
    refreshMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveRefresh = resolve; }) as ReturnType<typeof refreshToken>,
    );
    fetchMock.mockImplementation(async (_url, init) => {
      const headers = (init as RequestInit).headers as Record<string, string>;
      return headers.Authorization === 'Bearer fresh-token'
        ? jsonResponse(sessionsBody)
        : jsonResponse({ error: 'Unauthorized' }, 401);
    });

    const { events, onDone } = startStream();
    const listPromise = listAiSessions();
    await flushAsync();

    // Both paths hit their 401 and enter the shared refresh.
    FakeXhr.instances[0].finish(401, '{"error":"Unauthorized"}');
    await flushAsync();
    resolveRefresh!({ token: 'fresh-token' });
    await flushAsync();

    expect(refreshMock).toHaveBeenCalledTimes(1);

    // Both paths retried with the fresh token.
    const sessions = await listPromise;
    expect(sessions).toHaveLength(1);
    expect(FakeXhr.instances).toHaveLength(2);
    expect(FakeXhr.instances[1].headers.Authorization).toBe('Bearer fresh-token');

    FakeXhr.instances[1].finish(200, 'event: done\ndata: {"type":"done"}\n\n');
    expect(events).toEqual([{ type: 'done' }]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('non-401 HTTP failures surface immediately without refreshing', async () => {
    const { onError } = startStream();
    await flushAsync();

    FakeXhr.instances[0].finish(500, '{"error":"boom"}');
    await flushAsync();

    expect(refreshMock).not.toHaveBeenCalled();
    expect(FakeXhr.instances).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe('boom');
  });
});
