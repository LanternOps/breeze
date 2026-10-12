import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  classifyGraphPollError,
  listInboxDelta,
  markRead,
  getFileAttachmentBytes,
  GRAPH_POLL_TIMEOUT_MS,
  GRAPH_POLL_SWEEP_BUDGET_MS,
  GraphSweepBudgetError,
} from './graphMailClient';

const withStatus = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

describe('classifyGraphPollError (#8299)', () => {
  it.each([401, 403])('HTTP %i needs a reconnect', (s) => {
    expect(classifyGraphPollError(withStatus(s))).toBe('reauth');
  });

  it.each([408, 429, 500, 502, 503, 504])('HTTP %i is transient', (s) => {
    expect(classifyGraphPollError(withStatus(s))).toBe('transient');
  });

  it.each([400, 404, 409])('HTTP %i is fatal', (s) => {
    expect(classifyGraphPollError(withStatus(s))).toBe('fatal');
  });

  // Node's fetch puts the network reason in `cause`, with an error code (#8308).
  it.each(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'])(
    'a fetch network failure (TypeError, cause code %s) is transient',
    (code) => {
      const cause = Object.assign(new Error(code), { code });
      expect(classifyGraphPollError(new TypeError('fetch failed', { cause }))).toBe('transient');
    },
  );

  it('a network code one level deeper in the cause chain is still transient', () => {
    const inner = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const cause = new Error('socket failed', { cause: inner });
    expect(classifyGraphPollError(new TypeError('fetch failed', { cause }))).toBe('transient');
  });

  it('a refused redirect (TypeError, cause with no code) is fatal, not retried forever (#8308)', () => {
    expect(classifyGraphPollError(new TypeError('fetch failed', { cause: new Error('unexpected redirect') }))).toBe('fatal');
  });

  it.each(['ERR_INVALID_URL', 'ERR_INVALID_ARG_TYPE', 'SOMETHING_ELSE'])(
    'a TypeError whose cause code %s is not a network failure is fatal (#8308)',
    (code) => {
      const cause = Object.assign(new Error(code), { code });
      expect(classifyGraphPollError(new TypeError('fetch failed', { cause }))).toBe('fatal');
    },
  );

  it('a TypeError with no cause (a coding bug) is fatal (#8308)', () => {
    expect(classifyGraphPollError(new TypeError("Cannot read properties of undefined (reading 'value')"))).toBe('fatal');
  });

  it('a spent sweep budget is transient (#8308)', () => {
    expect(classifyGraphPollError(new GraphSweepBudgetError('Graph sweep budget spent'))).toBe('transient');
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
    expect(timeoutSpy).toHaveBeenCalledWith(GRAPH_POLL_TIMEOUT_MS);
    controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

    const err = await pending.catch((e: unknown) => e);
    expect((err as Error).name).toBe('TimeoutError');
    expect(classifyGraphPollError(err)).toBe('transient');
  });

  it('attachment downloads keep no poll deadline (they run outside the sweep)', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ contentBytes: 'aGk=' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await getFileAttachmentBytes('tok', 'support@example.com', 'msg-1', 'att-1');
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBeUndefined();
    expect(timeoutSpy).not.toHaveBeenCalled();
  });

  it('the sweep\'s markRead call carries the deadline', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await markRead('tok', 'support@example.com', 'msg-1');
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe('error');
  });
});

describe('listInboxDelta error to classifier contract (#8299)', () => {
  afterEach(() => vi.unstubAllGlobals());

  // The sweep only sees what listInboxDelta throws. If a real Graph error ever
  // lost its HTTP status, a 502 would classify as 'fatal' and stop the mailbox.
  it.each([
    [502, 'transient'],
    [503, 'transient'],
    [408, 'transient'],
    [401, 'reauth'],
    [404, 'fatal'],
  ] as const)('a real Graph %i response reaches the classifier as %s', async (status, kind) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"code":"UnknownError"}}', { status })));

    const err = await listInboxDelta('tok', 'support@example.com', null).catch((e: unknown) => e);
    expect((err as Error & { status?: number }).status).toBe(status);
    expect(classifyGraphPollError(err)).toBe(kind);
  });
});

describe('real fetch failures reach the classifier correctly (#8308)', () => {
  // Against a real local server, so the TypeError shapes are Node's own rather
  // than hand-built ones.
  it('a Graph redirect is refused as fatal, a dropped socket as transient', async () => {
    const http = await import('node:http');
    const server = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/elsewhere' });
        res.end();
      } else {
        req.socket.destroy();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as { port: number };
      const redirectErr = await listInboxDelta('tok', 'support@example.com', `http://127.0.0.1:${port}/redirect`)
        .catch((e: unknown) => e);
      expect(redirectErr).toBeInstanceOf(TypeError);
      expect(classifyGraphPollError(redirectErr)).toBe('fatal');

      // A malformed stored deltaLink never fixes itself (Node: ERR_INVALID_URL).
      const invalidUrlErr = await listInboxDelta('tok', 'support@example.com', 'not a url')
        .catch((e: unknown) => e);
      expect(invalidUrlErr).toBeInstanceOf(TypeError);
      expect(classifyGraphPollError(invalidUrlErr)).toBe('fatal');

      const droppedErr = await listInboxDelta('tok', 'support@example.com', `http://127.0.0.1:${port}/drop`)
        .catch((e: unknown) => e);
      expect(droppedErr).toBeInstanceOf(TypeError);
      expect(classifyGraphPollError(droppedErr)).toBe('transient');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('sweep budget for one mailbox (#8308)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const page = (body: Record<string, unknown>) => new Response(JSON.stringify(body), { status: 200 });

  it('stops paging once the budget is spent and returns no partial read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n += 1;
      // Each page takes 50 s of wall clock, so the third request has no budget left.
      vi.setSystemTime(Date.now() + 50_000);
      return page({ value: [{ id: `m${n}` }], '@odata.nextLink': `https://graph.microsoft.com/next-${n}` });
    });
    vi.stubGlobal('fetch', fetchMock);

    const err = await listInboxDelta('tok', 'support@example.com', 'https://graph.microsoft.com/stored-delta')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphSweepBudgetError);
    expect(classifyGraphPollError(err)).toBe('transient');
    // 0 s, 50 s and 100 s start a request; at 150 s the 120 s budget is spent.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('cuts the last request\'s timeout down to what is left of the budget', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1;
      if (n === 1) {
        vi.setSystemTime(Date.now() + 100_000);
        return page({ value: [], '@odata.nextLink': 'https://graph.microsoft.com/next' });
      }
      return page({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/delta-final' });
    }));

    const result = await listInboxDelta('tok', 'support@example.com', null);
    expect(result.deltaLink).toBe('https://graph.microsoft.com/delta-final');
    expect(timeoutSpy.mock.calls.map((c) => c[0])).toEqual([GRAPH_POLL_TIMEOUT_MS, GRAPH_POLL_SWEEP_BUDGET_MS - 100_000]);
  });

  it('does not sleep out a Retry-After that would pass the budget', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fetchMock = vi.fn(async () => {
      vi.setSystemTime(Date.now() + 100_000);
      return new Response('throttled', { status: 429, headers: { 'retry-after': '30' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const started = performance.now();
    const err = await listInboxDelta('tok', 'support@example.com', null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphSweepBudgetError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('a request ended by the budget reports the budget, not a bare timeout', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    })));

    const pending = listInboxDelta('tok', 'support@example.com', null, { deadlineAt: Date.now() + 1_000 });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 5_000);
    controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphSweepBudgetError);
    expect(((err as Error).cause as Error).name).toBe('TimeoutError');
  });

  it('markRead honours the sweep deadline it is given', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
    const err = await markRead('tok', 'support@example.com', 'msg-1', Date.now() - 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphSweepBudgetError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a delta round that never ends is treated as a spent budget, not a partial success', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1;
      return page({ value: [{ id: `m${n}` }], '@odata.nextLink': `https://graph.microsoft.com/next-${n}` });
    }));

    const err = await listInboxDelta('tok', 'support@example.com', null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphSweepBudgetError);
    expect(n).toBe(1000);
  });
});
