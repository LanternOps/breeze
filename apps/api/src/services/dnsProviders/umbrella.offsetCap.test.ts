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

function offsetsSent(): number[] {
  return activityCalls().map((call) => Number(new URL(urlOf(call)).searchParams.get('offset')));
}

/**
 * A fake of Cisco's Reports v2 `/activity`: one record per given timestamp,
 * filtered to the INCLUSIVE [from, to] window, newest first, paged by
 * limit/offset — and the real HTTP 400 for any offset above 10000
 * ("invalid offset: should be integer between 0 and 10000 inclusive", #7207).
 */
function fakeActivityApi(timestamps: number[], serverPageCap = Number.POSITIVE_INFINITY) {
  const sorted = [...timestamps].sort((a, b) => b - a);
  requestJsonMock.mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.toString() === TOKEN_URL) {
      return { access_token: 'tok-1', expires_in: 3600 } as never;
    }
    const from = Number(url.searchParams.get('from'));
    const to = Number(url.searchParams.get('to'));
    const limit = Math.min(Number(url.searchParams.get('limit')), serverPageCap);
    const offset = Number(url.searchParams.get('offset'));
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

  it('still never passes the cap when the server serves pages smaller than asked, so the probe never fires', async () => {
    const timestamps = spread(12_000, SINCE.getTime(), UNTIL.getTime());
    // Pages of 400 never look "full" against our limit of 1000.
    fakeActivityApi(timestamps, 400);

    const events = await makeProvider().syncEvents(SINCE, UNTIL);

    expect(Math.max(...offsetsSent())).toBeLessThanOrEqual(OFFSET_CAP);
    // No probe (limit=1) request was ever sent: the in-walk guard caught it.
    expect(activityCalls().some((call) => new URL(urlOf(call)).searchParams.get('limit') === '1')).toBe(false);
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
