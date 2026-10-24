import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UmbrellaProvider } from './umbrella';
import { DnsProviderHttpError, requestJson } from './http';

// Transport is mocked (same pattern as umbrella.test.ts); DnsProviderHttpError
// stays REAL so the fake API can throw exactly what the real client would.
vi.mock('./http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./http')>();
  return {
    ...actual,
    requestJson: vi.fn()
  };
});

const requestJsonMock = vi.mocked(requestJson);

const TOKEN_URL = 'https://api.umbrella.com/auth/v2/token';
const ACTIVITY_URL = 'https://api.umbrella.com/reports/v2/activity';
const OFFSET_CAP = 10_000;

const SINCE = new Date('2026-08-01T00:00:00.000Z');
const UNTIL = new Date('2026-08-02T00:00:00.000Z');

function makeProvider() {
  return new UmbrellaProvider('key-abc', 'secret-xyz', {});
}

function urlOf(call: unknown[]): string {
  return String(call[0]);
}

function activityCalls() {
  return requestJsonMock.mock.calls.filter((call) => urlOf(call).startsWith(ACTIVITY_URL));
}

/** Every activity request the fake answered, with how many records it returned. */
const served: Array<{ from: number; to: number; offset: number; limit: number; count: number }> = [];

/** Offset-cap probes (limit=1) that found a record, i.e. windows that had to be split. */
function overflowProbes() {
  return served.filter((r) => r.limit === 1 && r.count > 0);
}

function offsetsSent(): number[] {
  return activityCalls().map((call) => Number(new URL(urlOf(call)).searchParams.get('offset')));
}

/**
 * A fake of Cisco's Reports v2 `/activity`: one record per given timestamp,
 * filtered to the INCLUSIVE [from, to] window, newest first, paged by
 * limit/offset — and the real HTTP 400 for any offset above 10000
 * ("invalid offset: should be integer between 0 and 10000 inclusive", #7207).
 */
function fakeActivityApi(
  timestamps: number[],
  serverPageCap: number | ((offset: number) => number) = Number.POSITIVE_INFINITY
) {
  const sorted = [...timestamps].sort((a, b) => b - a);
  requestJsonMock.mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.toString() === TOKEN_URL) {
      return { access_token: 'tok-1', expires_in: 3600 } as never;
    }
    const from = Number(url.searchParams.get('from'));
    const to = Number(url.searchParams.get('to'));
    const offset = Number(url.searchParams.get('offset'));
    const pageCap = typeof serverPageCap === 'function' ? serverPageCap(offset) : serverPageCap;
    const limit = Math.min(Number(url.searchParams.get('limit')), pageCap);
    if (!Number.isInteger(offset) || offset < 0 || offset > OFFSET_CAP) {
      throw new DnsProviderHttpError(
        400,
        'Bad Request',
        JSON.stringify({
          meta: {},
          data: {
            errors: [{
              param: 'offset',
              value: String(offset),
              error: 'invalid offset: should be integer between 0 and 10000 inclusive'
            }]
          }
        })
      );
    }
    let lo = 0;
    let hi = sorted.length;
    // `sorted` is descending: find the [to, from] run with two binary searches.
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! > to) lo = mid + 1;
      else hi = mid;
    }
    const start = lo;
    hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! >= from) lo = mid + 1;
      else hi = mid;
    }
    const inWindow = sorted.slice(start, lo);
    const page = inWindow.slice(offset, offset + limit).map((ts, i) => ({
      type: 'dns',
      timestamp: ts,
      domain: `e${ts}-${offset + i}.example`,
      verdict: 'allowed',
      internalip: '10.0.0.1'
    }));
    served.push({ from, to, offset, limit: Number(url.searchParams.get('limit')), count: page.length });
    return { data: page } as never;
  });
}

/** `count` distinct-ish timestamps spread evenly across [start, end). */
function spread(count: number, start: number, end: number): number[] {
  const step = (end - start) / count;
  return Array.from({ length: count }, (_, i) => Math.floor(start + i * step));
}

async function collectSlices(provider: UmbrellaProvider, since: Date, until: Date) {
  const slices: Array<{ events: Array<{ timestamp: Date }>; until: Date }> = [];
  for await (const slice of provider.syncEventSlices(since, until)) slices.push(slice);
  return slices;
}

describe('UmbrellaProvider offset cap — time-sliced activity sync (#7207)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    served.length = 0;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  function warnings(): string {
    return warnSpy.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n');
  }

  it('fetches every event of a >10k window without ever sending an offset past the cap', async () => {
    const timestamps = spread(25_000, SINCE.getTime(), UNTIL.getTime());
    fakeActivityApi(timestamps);

    const events = await makeProvider().syncEvents(SINCE, UNTIL);

    expect(Math.max(...offsetsSent())).toBeLessThanOrEqual(OFFSET_CAP);
    // Adjacent slices share their boundary millisecond (the API window is
    // inclusive at both ends), so an event exactly on a boundary can arrive
    // twice — the sync job dedupes on its deterministic event id. What
    // matters here is that none is missing.
    const seen = new Set(events.map((e) => e.timestamp.getTime()));
    expect(seen.size).toBe(new Set(timestamps).size);
    expect(warnings()).not.toMatch(/offset cap/);
  });

  it('yields contiguous, chronological slices whose `until` is a safe checkpoint', async () => {
    const timestamps = spread(25_000, SINCE.getTime(), UNTIL.getTime());
    fakeActivityApi(timestamps);

    const slices = await collectSlices(makeProvider(), SINCE, UNTIL);

    expect(slices.length).toBeGreaterThan(1);
    expect(slices[slices.length - 1]!.until.getTime()).toBe(UNTIL.getTime());
    let previousUntil = SINCE.getTime();
    for (const slice of slices) {
      const times = slice.events.map((e) => e.timestamp.getTime());
      expect(slice.until.getTime()).toBeGreaterThan(previousUntil);
      expect(Math.min(...times)).toBeGreaterThanOrEqual(previousUntil);
      expect(Math.max(...times)).toBeLessThanOrEqual(slice.until.getTime());
      // Everything in (previousUntil, until] was delivered by this slice.
      const expected = timestamps.filter((ts) => ts > previousUntil && ts <= slice.until.getTime());
      const delivered = new Set(times);
      expect(expected.every((ts) => delivered.has(ts))).toBe(true);
      previousUntil = slice.until.getTime();
    }
  });

  it('keeps an empty window a single request and a single slice ending at `until`', async () => {
    fakeActivityApi([]);

    const slices = await collectSlices(makeProvider(), SINCE, UNTIL);

    expect(slices).toHaveLength(1);
    expect(slices[0]!.events).toEqual([]);
    expect(slices[0]!.until.getTime()).toBe(UNTIL.getTime());
    expect(activityCalls()).toHaveLength(1);
  });

  it('detects an overfull window with the cheap probe, not by walking to the cap', async () => {
    // 50k events: the 24h, 12h and 6h windows all overflow before a 3h one fits.
    fakeActivityApi(spread(50_000, SINCE.getTime(), UNTIL.getTime()));

    for await (const slice of makeProvider().syncEventSlices(SINCE, UNTIL)) {
      expect(slice.events.length).toBeGreaterThan(0);
      break;
    }

    // 3 overflows × (first page + probe) + the fitting slice's walk (first
    // page, probe, 6 more pages, empty page) = 15. Detecting each overflow by
    // walking to the cap instead would cost 11 requests apiece (~40 total).
    expect(activityCalls().length).toBeLessThanOrEqual(15);
  });

  it('probes the offset cap even when the server serves pages smaller than asked (#10018)', async () => {
    const timestamps = spread(12_000, SINCE.getTime(), UNTIL.getTime());
    // Pages of 400 never look "full" against our limit of 1000 — the case
    // that used to skip the probe and find the overflow only by walking to
    // the cap, at 10000 / 400 = 25 requests per halving.
    fakeActivityApi(timestamps, 400);

    const events = await makeProvider().syncEvents(SINCE, UNTIL);

    expect(Math.max(...offsetsSent())).toBeLessThanOrEqual(OFFSET_CAP);
    // The full day's overflow was found by one probe, not by paging into it.
    expect(overflowProbes()).toHaveLength(1);
    const wholeDayPages = served.filter(
      (r) => r.limit !== 1 && r.from === SINCE.getTime() && r.to === UNTIL.getTime()
    );
    expect(wholeDayPages).toHaveLength(1);
    // 2 to find the overflow + 2 halves × (first page, probe, 14 pages, empty
    // page), plus one page if the halves' shared boundary record tips one over.
    expect(activityCalls().length).toBeLessThanOrEqual(37);
    expect(new Set(events.map((e) => e.timestamp.getTime())).size).toBe(new Set(timestamps).size);
    expect(warnings()).not.toMatch(/offset cap/);
  });

  it('handles a zero-width window (since === until) with one request', async () => {
    fakeActivityApi([SINCE.getTime()]);

    const slices = await collectSlices(makeProvider(), SINCE, SINCE);

    expect(slices).toHaveLength(1);
    expect(slices[0]!.events).toHaveLength(1);
    expect(slices[0]!.until.getTime()).toBe(SINCE.getTime());
  });

  it('stops splitting at the minimum slice width: takes what the cap allows, warns, and moves on', async () => {
    // 12,000 events in the SAME millisecond — no time slice can separate them.
    const burst = SINCE.getTime() + 60 * 60 * 1000;
    const tail = spread(500, burst + 10_000, UNTIL.getTime());
    fakeActivityApi([...Array.from({ length: 12_000 }, () => burst), ...tail]);

    const slices = await collectSlices(makeProvider(), SINCE, UNTIL);

    // It finishes the window instead of looping forever or failing the sync.
    expect(slices[slices.length - 1]!.until.getTime()).toBe(UNTIL.getTime());
    const all = slices.flatMap((s) => s.events.map((e) => e.timestamp.getTime()));
    const burstCount = all.filter((ts) => ts === burst).length;
    // Everything reachable under the cap was kept, the rest was not.
    expect(burstCount).toBeGreaterThanOrEqual(OFFSET_CAP);
    expect(burstCount).toBeLessThan(12_000);
    // The events after the burst are still fetched.
    expect(new Set(all.filter((ts) => ts > burst))).toEqual(new Set(tail));
    expect(warnings()).toMatch(/offset cap/);
    expect(Math.max(...offsetsSent())).toBeLessThanOrEqual(OFFSET_CAP);
  });

  it('ends at the request budget on a slice boundary, never yielding a partial slice', async () => {
    // Far more than 100 requests' worth of events in one day.
    const timestamps = spread(400_000, SINCE.getTime(), UNTIL.getTime());
    fakeActivityApi(timestamps);

    const slices = await collectSlices(makeProvider(), SINCE, UNTIL);

    expect(activityCalls().length).toBeLessThanOrEqual(100);
    expect(slices.length).toBeGreaterThan(0);
    const lastUntil = slices[slices.length - 1]!.until.getTime();
    expect(lastUntil).toBeLessThan(UNTIL.getTime());
    // Every in-window event up to the last checkpoint was delivered, so the
    // caller can resume from `lastUntil` without a hole.
    const delivered = new Set(slices.flatMap((s) => s.events.map((e) => e.timestamp.getTime())));
    expect(timestamps.filter((ts) => ts <= lastUntil).every((ts) => delivered.has(ts))).toBe(true);
    expect(warnings()).toMatch(/100-request budget/);
  });

  it('propagates a genuine upstream failure mid-window after yielding the earlier slices', async () => {
    const timestamps = spread(25_000, SINCE.getTime(), UNTIL.getTime());
    fakeActivityApi(timestamps);
    const real = requestJsonMock.getMockImplementation()!;
    let activityRequests = 0;
    requestJsonMock.mockImplementation(async (input, init) => {
      if (String(input).startsWith(ACTIVITY_URL) && ++activityRequests > 15) {
        throw new DnsProviderHttpError(503, 'Service Unavailable', 'upstream down');
      }
      return real(input, init);
    });

    const yielded: Date[] = [];
    await expect((async () => {
      for await (const slice of makeProvider().syncEventSlices(SINCE, UNTIL)) yielded.push(slice.until);
    })()).rejects.toBeInstanceOf(DnsProviderHttpError);
    // At least one slice completed before the failure, and each is a real
    // checkpoint short of the requested end.
    expect(yielded.length).toBeGreaterThan(0);
    expect(yielded[yielded.length - 1]!.getTime()).toBeLessThan(UNTIL.getTime());
  });
});

/** Drive one sync run to its end, keeping the slices AND the walk's return value. */
async function walk(
  provider: UmbrellaProvider,
  since: Date,
  until: Date,
  options?: { initialSliceMs?: number }
) {
  const slices: Array<{ events: Array<{ timestamp: Date }>; until: Date }> = [];
  const iterator = provider.syncEventSlices(since, until, options);
  for (;;) {
    const step = await iterator.next();
    if (step.done) return { slices, end: step.value };
    slices.push(step.value);
  }
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

describe('UmbrellaProvider request budget — a backlog keeps advancing (#10018)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    served.length = 0;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // The reporter's shape: ~2.5 days behind, ~10k activity records per 30 min.
  const BACKLOG_UNTIL = new Date('2026-10-24T16:00:00.000Z');
  const BACKLOG_SINCE = new Date(BACKLOG_UNTIL.getTime() - 60 * HOUR);
  const backlog = spread(
    (60 * HOUR / (30 * MINUTE)) * 10_000,
    BACKLOG_SINCE.getTime(),
    BACKLOG_UNTIL.getTime()
  );

  it.each([100, 500, 1000])(
    'completes at least one slice within the 100-request budget at a %i-record server page',
    async (serverPage) => {
      fakeActivityApi(backlog, serverPage);

      const { slices, end } = await walk(makeProvider(), BACKLOG_SINCE, BACKLOG_UNTIL);

      expect(activityCalls().length).toBeLessThanOrEqual(100);
      expect(slices.length).toBeGreaterThanOrEqual(1);
      const checkpoint = slices[slices.length - 1]!.until.getTime();
      expect(checkpoint).toBeGreaterThan(BACKLOG_SINCE.getTime());
      // Nothing up to the checkpoint is missing, so resuming from it leaves no hole.
      const delivered = new Set(slices.flatMap((s) => s.events.map((e) => e.timestamp.getTime())));
      expect(backlog.filter((ts) => ts <= checkpoint).every((ts) => delivered.has(ts))).toBe(true);
      // The walk says it stopped short, and exactly which stretch is left.
      expect(end?.stoppedShort).toEqual({ from: new Date(checkpoint), to: BACKLOG_UNTIL });
      expect(Math.max(...offsetsSent())).toBeLessThanOrEqual(OFFSET_CAP);
    }
  );

  it('reports no stoppedShort, and the working slice width, when the window completes', async () => {
    const day = spread(25_000, SINCE.getTime(), UNTIL.getTime());
    fakeActivityApi(day);

    const { slices, end } = await walk(makeProvider(), SINCE, UNTIL);

    expect(slices[slices.length - 1]!.until.getTime()).toBe(UNTIL.getTime());
    expect(end?.stoppedShort).toBeUndefined();
    // 24h and 12h overflow; 6h slices (~6.25k records) fit and do not double.
    expect(end?.sliceWidthMs).toBe(6 * HOUR);

    // Fed back in, that width walks the same day without a single split.
    vi.clearAllMocks();
    served.length = 0;
    fakeActivityApi(day);
    await walk(makeProvider(), SINCE, UNTIL, { initialSliceMs: end!.sliceWidthMs });
    expect(overflowProbes()).toEqual([]);
  });

  it('bounds the first slice by exactly what the remaining budget can page', async () => {
    // Server page 100, nothing spent yet. After the first page (request 1)
    // and the probe (request 2), 98 requests remain: 97 pages reach offset
    // 9800 and the 100th is the empty page that ends the walk. So 9800
    // records fit this run, and the probe sits at offset 9800.
    fakeActivityApi(spread(9800, SINCE.getTime(), UNTIL.getTime()), 100);
    const fits = await walk(makeProvider(), SINCE, UNTIL);
    expect(served.filter((r) => r.limit === 1).map((r) => r.offset)).toEqual([9800]);
    expect(overflowProbes()).toEqual([]);
    expect(fits.slices).toHaveLength(1);
    expect(fits.slices[0]!.until.getTime()).toBe(UNTIL.getTime());
    expect(fits.end?.stoppedShort).toBeUndefined();
    expect(activityCalls()).toHaveLength(100);

    // One more record and the window can no longer finish: split it.
    vi.clearAllMocks();
    served.length = 0;
    fakeActivityApi(spread(9801, SINCE.getTime(), UNTIL.getTime()), 100);
    await walk(makeProvider(), SINCE, UNTIL);
    expect(overflowProbes()[0]).toMatchObject({ offset: 9800, from: SINCE.getTime(), to: UNTIL.getTime() });
  });

  it('keeps the working width, and probes at the cap, once a slice has completed', async () => {
    fakeActivityApi(backlog, 100);

    const { slices, end } = await walk(makeProvider(), BACKLOG_SINCE, BACKLOG_UNTIL);

    expect(slices).toHaveLength(1);
    expect(end?.stoppedShort).toBeDefined();
    const firstUntil = slices[0]!.until.getTime();
    // After the first slice the budget no longer sizes slices: the next
    // window is probed at Cisco's cap, not at what the budget has left.
    const laterProbes = served.filter((r) => r.limit === 1 && r.from === firstUntil);
    expect(laterProbes.map((r) => r.offset)).toEqual([OFFSET_CAP]);
    // The width that completed a slice is what the next run starts at — not
    // halved because the budget ran out partway through the next one.
    const completedWidth = firstUntil - BACKLOG_SINCE.getTime();
    expect(end!.sliceWidthMs).toBe(completedWidth);
  });

  it('skips the probe for a first page shorter than one already served this run', async () => {
    const half = SINCE.getTime() + 12 * HOUR;
    // 5000 records in the first 12h (full 1000-record pages), 300 in the second.
    fakeActivityApi([
      ...spread(5000, SINCE.getTime(), half - 1),
      ...spread(300, half + 1, UNTIL.getTime())
    ]);

    const { slices } = await walk(makeProvider(), SINCE, UNTIL, { initialSliceMs: 12 * HOUR });

    expect(slices).toHaveLength(2);
    const secondWindow = served.filter((r) => r.from === half);
    // First page (300 < 1000 already seen) + the empty page; no probe.
    expect(secondWindow.map((r) => ({ offset: r.offset, limit: r.limit }))).toEqual([
      { offset: 0, limit: 1000 },
      { offset: 300, limit: 1000 }
    ]);
  });

  it('starts the next run at the remembered slice width instead of re-splitting the backlog', async () => {
    fakeActivityApi(backlog, 500);
    const first = await walk(makeProvider(), BACKLOG_SINCE, BACKLOG_UNTIL);
    expect(overflowProbes().length).toBeGreaterThan(0);
    const firstCheckpoint = first.slices[first.slices.length - 1]!.until;
    const firstProgress = firstCheckpoint.getTime() - BACKLOG_SINCE.getTime();

    vi.clearAllMocks();
    served.length = 0;
    fakeActivityApi(backlog, 500);
    const second = await walk(makeProvider(), firstCheckpoint, BACKLOG_UNTIL, {
      initialSliceMs: first.end!.sliceWidthMs
    });

    // No request was spent splitting: the remembered width already fits.
    expect(overflowProbes()).toEqual([]);
    const secondCheckpoint = second.slices[second.slices.length - 1]!.until.getTime();
    expect(secondCheckpoint - firstCheckpoint.getTime()).toBeGreaterThanOrEqual(firstProgress);
  });

  it('ignores a remembered width outside [1 s, 30 days]', async () => {
    for (const initialSliceMs of [0, -5, Number.NaN, 90 * 24 * HOUR]) {
      vi.clearAllMocks();
      fakeActivityApi([]);
      const { slices } = await walk(makeProvider(), SINCE, UNTIL, { initialSliceMs });
      // An empty day is one request and one slice, as with no remembered width.
      expect(slices).toHaveLength(1);
      expect(slices[0]!.until.getTime()).toBe(UNTIL.getTime());
      expect(activityCalls()).toHaveLength(1);
    }
  });

  it('makes progress across runs even when a run ends with no slice completed', async () => {
    // A server whose first page is full-size but whose later pages shrink to
    // 10 records defeats any page-size estimate: the budget can still catch
    // the walk mid-window with nothing yielded. Each such run must hand back
    // a NARROWER width, so successive runs converge on a slice that fits.
    const shrinkingPages = (offset: number) => (offset === 0 ? 1000 : 10);

    let since = BACKLOG_SINCE;
    let width: number | undefined;
    let zeroProgressRuns = 0;
    let progressed = false;
    for (let runIndex = 0; runIndex < 12 && !progressed; runIndex++) {
      vi.clearAllMocks();
      fakeActivityApi(backlog, shrinkingPages);
      const { slices, end } = await walk(makeProvider(), since, BACKLOG_UNTIL, { initialSliceMs: width });
      expect(activityCalls().length).toBeLessThanOrEqual(100);
      expect(end?.stoppedShort).toBeDefined();
      if (slices.length > 0) {
        progressed = true;
        since = slices[slices.length - 1]!.until;
      } else {
        zeroProgressRuns++;
        expect(end!.stoppedShort!.from.getTime()).toBe(since.getTime());
        if (width !== undefined) expect(end!.sliceWidthMs).toBeLessThan(width);
        width = end!.sliceWidthMs;
      }
    }

    expect(zeroProgressRuns).toBeGreaterThan(0);
    expect(progressed).toBe(true);
    expect(since.getTime()).toBeGreaterThan(BACKLOG_SINCE.getTime());
  });
});
