import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  classifyGraphPollError,
  listInboxDelta,
  markRead,
  getFileAttachmentBytes,
  GRAPH_POLL_TIMEOUT_MS,
  GRAPH_DELTA_PAGE_SIZE,
  GRAPH_DELTA_MAX_PAGES_PER_SWEEP,
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
    const realFetch = globalThis.fetch;
    try {
      const { port } = server.address() as { port: number };
      // Graph-origin URLs are routed to the local server, so Node's real fetch
      // produces the errors while the client's origin check still passes.
      vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
        realFetch(url.replace('https://graph.microsoft.com', `http://127.0.0.1:${port}`), init));

      const redirectErr = await listInboxDelta('tok', 'support@example.com', 'https://graph.microsoft.com/redirect')
        .catch((e: unknown) => e);
      expect(redirectErr).toBeInstanceOf(TypeError);
      expect(classifyGraphPollError(redirectErr)).toBe('fatal');

      // Node's own ERR_INVALID_URL shape is still fatal.
      const invalidUrlErr = await realFetch('not a url').catch((e: unknown) => e);
      expect(invalidUrlErr).toBeInstanceOf(TypeError);
      expect(classifyGraphPollError(invalidUrlErr)).toBe('fatal');

      const droppedErr = await listInboxDelta('tok', 'support@example.com', 'https://graph.microsoft.com/drop')
        .catch((e: unknown) => e);
      expect(droppedErr).toBeInstanceOf(TypeError);
      expect(classifyGraphPollError(droppedErr)).toBe('transient');
    } finally {
      vi.unstubAllGlobals();
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

  it('stops paging once the budget is spent and returns the pages read with where to resume', async () => {
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

    const result = await listInboxDelta('tok', 'support@example.com', 'https://graph.microsoft.com/stored-delta');
    // 0 s, 50 s and 100 s start a request; at 150 s the 120 s budget is spent.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(result.deltaLink).toBeNull();
    expect(result.resumeLink).toBe('https://graph.microsoft.com/next-3');
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

  it('a budget spent before the first page is a transient failure with nothing to resume', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => page({ value: [] })));
    const err = await listInboxDelta('tok', 'support@example.com', null, { deadlineAt: Date.now() - 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphSweepBudgetError);
    expect(classifyGraphPollError(err)).toBe('transient');
  });

  it('a many-page first sync completes across sweeps, each sweep\'s Graph time within the budget (#8400)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const PAGES = 40;
    const pageUrl = (i: number) => `https://graph.microsoft.com/next-${i}`;
    const fetchMock = vi.fn(async (url: string) => {
      // 40 s per page: three pages use the whole 120 s budget, so the fourth
      // request is never started.
      vi.setSystemTime(Date.now() + 40_000);
      const i = url.startsWith('https://graph.microsoft.com/next-') ? Number(url.split('-').pop()) : 0;
      return i + 1 < PAGES
        ? page({ value: [{ id: `m${i}` }], '@odata.nextLink': pageUrl(i + 1) })
        : page({ value: [{ id: `m${i}` }], '@odata.deltaLink': 'https://graph.microsoft.com/delta-final' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const seen: string[] = [];
    let cursor: string | null = null;
    let sweeps = 0;
    for (; sweeps < 100; sweeps++) {
      const started = Date.now();
      const result = await listInboxDelta('tok', 'support@example.com', cursor);
      expect(Date.now() - started).toBeLessThanOrEqual(GRAPH_POLL_SWEEP_BUDGET_MS);
      seen.push(...result.messages.map((m) => m.id));
      if (result.deltaLink) {
        cursor = result.deltaLink;
        break;
      }
      expect(result.resumeLink).toBeDefined();
      cursor = result.resumeLink!;
    }
    expect(cursor).toBe('https://graph.microsoft.com/delta-final');
    // Every message exactly once, in order, and more than one sweep was needed.
    expect(seen).toEqual(Array.from({ length: PAGES }, (_, i) => `m${i}`));
    expect(sweeps).toBeGreaterThan(1);
  });

  it('asks Graph for large delta pages on every request of the round', async () => {
    let n = 0;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      n += 1;
      return n === 1
        ? page({ value: [], '@odata.nextLink': 'https://graph.microsoft.com/next-1' })
        : page({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/delta-final' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await listInboxDelta('tok', 'support@example.com', null);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Prefer).toBe(`odata.maxpagesize=${GRAPH_DELTA_PAGE_SIZE}`);
      expect(headers.Authorization).toBe('Bearer tok');
    }
  });

  it('never sends the token to a stored cursor off the Graph origin', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const stored of ['http://127.0.0.1:8080/delta', 'https://graph.microsoft.com.evil.example/x', 'not a url']) {
      const err = await listInboxDelta('tok', 'support@example.com', stored).catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/not on the Graph origin/);
      expect(classifyGraphPollError(err)).toBe('fatal');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a nextLink off the Graph origin instead of following it', async () => {
    const fetchMock = vi.fn(async () => page({ value: [{ id: 'm1' }], '@odata.nextLink': 'https://attacker.example/next' }));
    vi.stubGlobal('fetch', fetchMock);

    const err = await listInboxDelta('tok', 'support@example.com', null).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/not on the Graph origin/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('markRead honours the sweep deadline it is given', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
    const err = await markRead('tok', 'support@example.com', 'msg-1', Date.now() - 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphSweepBudgetError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a delta round that hits the per-sweep page cap resumes next sweep instead of failing', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1;
      return page({ value: [{ id: `m${n}` }], '@odata.nextLink': `https://graph.microsoft.com/next-${n}` });
    }));

    const result = await listInboxDelta('tok', 'support@example.com', null);
    expect(n).toBe(GRAPH_DELTA_MAX_PAGES_PER_SWEEP);
    expect(result.messages).toHaveLength(GRAPH_DELTA_MAX_PAGES_PER_SWEEP);
    expect(result.deltaLink).toBeNull();
    expect(result.resumeLink).toBe(`https://graph.microsoft.com/next-${GRAPH_DELTA_MAX_PAGES_PER_SWEEP}`);
  });

  it('fails instead of resuming when Graph repeats a nextLink in the same sweep', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1;
      // next-1, next-2, then back to next-1.
      const next = n === 3 ? 1 : n;
      return page({ value: [{ id: `m${n}` }], '@odata.nextLink': `https://graph.microsoft.com/next-${next}` });
    }));

    const err = await listInboxDelta('tok', 'support@example.com', null).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/nextLink repeated/);
    expect(classifyGraphPollError(err)).toBe('fatal');
  });

  it('fails when the next page points back at the stored cursor it started from', async () => {
    const stored = 'https://graph.microsoft.com/next-7';
    vi.stubGlobal('fetch', vi.fn(async () => page({ value: [{ id: 'm' }], '@odata.nextLink': stored })));

    const err = await listInboxDelta('tok', 'support@example.com', stored).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/nextLink repeated/);
  });
});
