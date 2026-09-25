// #6745: getLogTrends reports whether its top-N lists were cut (one-row overfetch).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ results: [] as unknown[][], limits: [] as number[], select: vi.fn() }));
vi.mock('../db', () => ({
  db: { select: mocks.select },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import { getLogTrends } from './logSearch';

const auth = { orgCondition: () => undefined } as never;
const sources = (n: number) => Array.from({ length: n }, (_, i) => ({ source: `s${i}`, count: 100 - i, errorCount: 1, criticalCount: 0 }));
const devicesRows = (n: number) => Array.from({ length: n }, (_, i) => ({ deviceId: `d${i}`, hostname: `h${i}`, count: 50 - i, errorCount: 1, criticalCount: 0 }));

describe('getLogTrends top-N honesty (#6745)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.limits.length = 0;
    let call = 0;
    mocks.select.mockImplementation(() => {
      const result = mocks.results[call++] ?? [];
      const c: Record<string, unknown> = {};
      for (const m of ['from', 'leftJoin', 'where', 'groupBy', 'orderBy']) c[m] = vi.fn(() => c);
      c.limit = vi.fn((n: number) => { mocks.limits.push(n); return c; });
      c.then = (ok?: (v: unknown) => unknown, bad?: (r: unknown) => unknown) => Promise.resolve(result).then(ok, bad);
      return c;
    });
  });

  it('overfetches one row, trims to limit, and flags hasMore', async () => {
    mocks.results = [[], sources(4), devicesRows(4), []];
    const out = await getLogTrends(auth, { limit: 3 });
    expect(mocks.limits).toEqual([4, 4]);
    expect(out.topSources).toHaveLength(3);
    expect(out.topDevices).toHaveLength(3);
    expect(out.topSourcesHasMore).toBe(true);
    expect(out.topDevicesHasMore).toBe(true);
  });

  it('reports hasMore=false when the list fits', async () => {
    mocks.results = [[], sources(2), devicesRows(3), []];
    const out = await getLogTrends(auth, { limit: 3 });
    expect(out.topSources).toHaveLength(2);
    expect(out.topSourcesHasMore).toBe(false);
    expect(out.topDevicesHasMore).toBe(false);
  });
});
