import { describe, it, expect, vi, afterEach } from 'vitest';
import { classifyGraphPollError, listInboxDelta, markRead, GRAPH_REQUEST_TIMEOUT_MS } from './graphMailClient';

const withStatus = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

describe('classifyGraphPollError (#8299)', () => {
  it.each([401, 403])('HTTP %i needs a reconnect', (s) => {
    expect(classifyGraphPollError(withStatus(s))).toBe('reauth');
  });

  it.each([429, 500, 502, 503, 504])('HTTP %i is transient', (s) => {
    expect(classifyGraphPollError(withStatus(s))).toBe('transient');
  });

  it.each([400, 404, 409])('HTTP %i is fatal', (s) => {
    expect(classifyGraphPollError(withStatus(s))).toBe('fatal');
  });

  it('a fetch transport failure (TypeError) is transient', () => {
    expect(classifyGraphPollError(new TypeError('fetch failed'))).toBe('transient');
  });

  it.each(['TimeoutError', 'AbortError'])('a %s from the request timeout is transient', (name) => {
    expect(classifyGraphPollError(Object.assign(new Error('aborted'), { name }))).toBe('transient');
  });

  it('a plain error with no status (configuration) is fatal', () => {
    expect(classifyGraphPollError(new Error('Invalid M365 tenant id'))).toBe('fatal');
  });

  it('a non-numeric status is not trusted', () => {
    expect(classifyGraphPollError(Object.assign(new Error('x'), { status: '503' }))).toBe('fatal');
  });

  it('null and non-Error values are fatal', () => {
    expect(classifyGraphPollError(null)).toBe('fatal');
    expect(classifyGraphPollError('boom')).toBe('fatal');
  });
});

describe('Graph request deadline (#8299)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** A fetch that never answers on its own: it settles only when its signal aborts. */
  function hangingFetch() {
    return vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // no deadline: hangs forever, so the test times out
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
  }

  it('a delta request Graph never answers rejects as a transient TimeoutError', async () => {
    const controller = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);

    const pending = listInboxDelta('tok', 'support@example.com', null);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(timeoutSpy).toHaveBeenCalledWith(GRAPH_REQUEST_TIMEOUT_MS);
    controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

    const err = await pending.catch((e: unknown) => e);
    expect((err as Error).name).toBe('TimeoutError');
    expect(classifyGraphPollError(err)).toBe('transient');
  });

  it('every Graph call carries the deadline, including markRead', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await markRead('tok', 'support@example.com', 'msg-1');
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe('error');
  });
});
