// #6745: listReliabilityDevices + summarizeReliabilityDevices share one WHERE,
// and an exact-device set (a frozen AI run) narrows it in SQL.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const mocks = vi.hoisted(() => ({
  whereArgs: [] as unknown[],
  selected: [] as Record<string, unknown>[],
  result: [] as unknown[],
  select: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { select: mocks.select },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./mlFeatureFlags', () => ({ shouldProduceMlOutput: vi.fn() }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { listReliabilityDevices, summarizeReliabilityDevices } from './reliabilityScoring';

function chain(): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'innerJoin', 'orderBy', 'limit', 'offset']) c[m] = vi.fn(() => c);
  c.where = vi.fn((w: unknown) => { mocks.whereArgs.push(w); return c; });
  c.then = (ok?: (v: unknown) => unknown, bad?: (r: unknown) => unknown) => Promise.resolve(mocks.result).then(ok, bad);
  return c;
}
const render = (w: unknown) => new PgDialect().sqlToQuery(w as SQL);

describe('reliability list filter (#6745)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.whereArgs.length = 0;
    mocks.selected.length = 0;
    mocks.result = [];
    mocks.select.mockImplementation((cols: Record<string, unknown>) => { mocks.selected.push(cols); return chain(); });
  });

  it('narrows both the list and the summary to deviceIds', async () => {
    const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
    await listReliabilityDevices({ orgIds: ['org-1'], deviceIds: ids, limit: 5 });
    await summarizeReliabilityDevices({ orgIds: ['org-1'], deviceIds: ids });
    // list issues count + data; summary issues one aggregate.
    expect(mocks.whereArgs).toHaveLength(3);
    for (const w of mocks.whereArgs) {
      const q = render(w);
      expect(q.sql).toContain('"device_reliability"."device_id" in');
      expect(q.params).toEqual(expect.arrayContaining(ids));
    }
  });

  it('an empty deviceIds set matches nothing', async () => {
    await summarizeReliabilityDevices({ orgIds: ['org-1'], deviceIds: [] });
    expect(render(mocks.whereArgs[0]).sql).toContain('false');
  });

  it('summary band counts use the scoreBand() edges and coerce numeric strings', async () => {
    mocks.result = [{ total: '7', averageScore: '63.4', criticalDevices: '2', poorDevices: '3', fairDevices: '1', goodDevices: '1', degradingDevices: '4' }];
    const summary = await summarizeReliabilityDevices({ orgIds: ['org-1'] });
    expect(summary).toEqual({ total: 7, averageScore: 63, criticalDevices: 2, poorDevices: 3, fairDevices: 1, goodDevices: 1, degradingDevices: 4 });
    const cols = mocks.selected[0]!;
    const sqlOf = (k: string) => render(cols[k]).sql;
    expect(sqlOf('criticalDevices')).toContain('<= 50');
    expect(sqlOf('poorDevices')).toContain('between 51 and 70');
    expect(sqlOf('fairDevices')).toContain('between 71 and 85');
    expect(sqlOf('goodDevices')).toContain('>= 86');
  });
});
