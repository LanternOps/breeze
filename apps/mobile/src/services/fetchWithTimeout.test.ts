import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { fetchWithTimeout, FetchTimeoutError } from './fetchWithTimeout';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A fetch that never settles until its signal aborts. */
function hangingFetch() {
  return (_url: string, opts: RequestInit) =>
    new Promise((_resolve, reject) => {
      opts.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
}

describe('fetchWithTimeout', () => {
  it('passes the response through untouched when it resolves in time', async () => {
    const response = { ok: true, status: 200 } as Response;
    fetchMock.mockResolvedValue(response);

    await expect(fetchWithTimeout('https://x.test/a')).resolves.toBe(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('forwards method, headers and body to the underlying fetch', async () => {
    fetchMock.mockResolvedValue({ ok: true } as Response);

    await fetchWithTimeout('https://x.test/a', {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
      body: '{"a":1}',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://x.test/a');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Bearer t' });
    expect(init.body).toBe('{"a":1}');
    expect(init.signal).toBeDefined();
  });

  it('throws FetchTimeoutError once the header timeout elapses', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hangingFetch());

    const promise = fetchWithTimeout('https://x.test/slow', {}, 1000);
    // Attach the rejection handler before advancing so the rejection is never
    // momentarily unhandled.
    const assertion = expect(promise).rejects.toBeInstanceOf(FetchTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('carries the url and timeout on the timeout error for diagnosis', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hangingFetch());

    const promise = fetchWithTimeout('https://x.test/slow', {}, 250);
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'FetchTimeoutError',
      url: 'https://x.test/slow',
      timeoutMs: 250,
    });
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
  });

  it('does not fire the timeout once the response headers have arrived (SSE stays open)', async () => {
    vi.useFakeTimers();
    // Resolve immediately with a response whose body is still streaming. The
    // timeout must be cleared at this point, or every SSE stream would be
    // aborted `timeoutMs` after it started.
    let abortedAfterResolve = false;
    fetchMock.mockImplementation((_url: string, opts: RequestInit) => {
      opts.signal?.addEventListener('abort', () => {
        abortedAfterResolve = true;
      });
      return Promise.resolve({ ok: true } as Response);
    });

    await fetchWithTimeout('https://x.test/stream', {}, 100);
    await vi.advanceTimersByTimeAsync(5000);

    expect(abortedAfterResolve).toBe(false);
  });

  it('propagates a caller abort and reports it as AbortError, not a timeout', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(hangingFetch());

    const promise = fetchWithTimeout('https://x.test/slow', { signal: controller.signal }, 10_000);
    const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
  });

  it('aborts immediately when the caller signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockImplementation(hangingFetch());

    await expect(
      fetchWithTimeout('https://x.test/slow', { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rethrows a genuine network error unchanged', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));

    await expect(fetchWithTimeout('https://x.test/a')).rejects.toThrow('Network request failed');
  });
});
