import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AuthContext } from '../../middleware/auth';
import type { DatasetAdapter, DatasetRequest } from '../aiToolsExportDatasets';
import { EXPORT_DATASETS } from '../aiToolsExportDatasetNames';

vi.mock('../../db', async () => {
  const { drizzle } = await import('drizzle-orm/postgres-js');
  return {
    db: drizzle.mock(),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

const exportDeviceSet = vi.fn();
const runExportQuery = vi.fn();
vi.mock('../aiToolsExportShared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../aiToolsExportShared')>();
  return {
    ...actual,
    exportDeviceSet: (...a: unknown[]) => exportDeviceSet(...a),
    runExportQuery: (...a: unknown[]) => runExportQuery(...a),
  };
});

import { createHash } from 'node:crypto';
import { reliabilityEventKey } from '../reliabilityScoring';
import { reliabilityScoresAdapter, reliabilityHistoryAdapter, reliabilityEventsAdapter, RELIABILITY_LATE_EVENTS_NOTE } from './reliability';

const NOW = new Date('2026-11-13T12:00:00.000Z');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const D1 = id(1);
const D2 = id(2);

function req(filters: Record<string, unknown> = {}, over: Partial<DatasetRequest> = {}): DatasetRequest {
  return {
    auth: { orgId: 'org-1' } as unknown as AuthContext,
    orgId: 'org-1',
    filters,
    deviceIds: null,
    runTargets: [D1, D2],
    siteId: null,
    pageSize: 500,
    notes: [],
    exportGrants: { datasets: [...EXPORT_DATASETS], sensitiveGates: [] },
    ...over,
  };
}
const scope = (ids: string[]) => ({
  deviceIds: ids,
  hostnames: new Map(ids.map((d) => [d, `h-${d}`])),
});
type Compiled = { sql: string; params: unknown[] };
const compiled = (call: number): Compiled =>
  (runExportQuery.mock.calls[call]![0] as { toSQL(): Compiled }).toSQL();

async function firstQuery(adapter: DatasetAdapter, r: DatasetRequest): Promise<Compiled> {
  exportDeviceSet.mockResolvedValue(scope([D1]));
  runExportQuery.mockResolvedValue([]);
  await (await adapter.createPager(r))(null);
  return compiled(0);
}

async function allRows(adapter: DatasetAdapter, fixtures: unknown[], r: DatasetRequest = req()) {
  exportDeviceSet.mockResolvedValue(scope([D1]));
  runExportQuery.mockResolvedValue(fixtures);
  const pager = await adapter.createPager(r);
  const out: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;
  do {
    const page: { rows: Array<Record<string, unknown>>; nextCursor: string | null } = await pager(cursor);
    out.push(...page.rows);
    cursor = null; // the fixture is one page
  } while (cursor);
  return out;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  exportDeviceSet.mockReset();
  runExportQuery.mockReset();
});
afterEach(() => vi.useRealTimers());

const SCORE_KEYS = [
  'deviceId', 'hostname', 'siteId', 'osType', 'status', 'computedAt', 'reliabilityScore',
  'uptimeScore', 'crashScore', 'hangScore', 'serviceFailureScore', 'hardwareErrorScore',
  'uptime7d', 'uptime30d', 'uptime90d', 'crashCount7d', 'crashCount30d', 'crashCount90d',
  'hangCount7d', 'hangCount30d', 'hangCount90d', 'serviceFailureCount7d', 'serviceFailureCount30d',
  'hardwareErrorCount7d', 'hardwareErrorCount30d', 'mtbfHours', 'trendDirection', 'trendConfidence',
  'provisional', 'topIssues',
];

const scoreRow = (deviceId: string) => ({
  deviceId, siteId: 's1', osType: 'windows', status: 'online',
  computedAt: new Date('2026-11-13T00:00:00Z'), reliabilityScore: 80,
  uptimeScore: 1, crashScore: 2, hangScore: 3, serviceFailureScore: 4, hardwareErrorScore: 5,
  uptime7d: 99, uptime30d: 98, uptime90d: 97, crashCount7d: 0, crashCount30d: 1, crashCount90d: 2,
  hangCount7d: 0, hangCount30d: 1, hangCount90d: 2, serviceFailureCount7d: 0, serviceFailureCount30d: 1,
  hardwareErrorCount7d: 0, hardwareErrorCount30d: 1, mtbfHours: 12.5, trendDirection: 'stable',
  trendConfidence: 0.5, provisional: false, topIssues: [{ type: 'crashes', count: 1, severity: 'error' }],
});

describe('reliability_scores', () => {
  it('reads the frame through reliabilityListWhere, keyset on device_id, pageSize+1', async () => {
    exportDeviceSet.mockResolvedValue(scope([D1, D2]));
    runExportQuery.mockResolvedValue([]);
    await (await reliabilityScoresAdapter.createPager(req({})))(null);
    const { sql, params } = compiled(0);
    expect(sql).toContain('"device_reliability"."org_id" = $');
    expect(params).toEqual(expect.arrayContaining(['org-1', D1, D2, 501]));
    expect(sql).toMatch(/order by "device_reliability"."device_id" asc/i);
  });

  it('empty device set yields nothing and runs no query', async () => {
    exportDeviceSet.mockResolvedValue(scope([]));
    expect(await (await reliabilityScoresAdapter.createPager(req({})))(null)).toEqual({ rows: [], nextCursor: null });
    expect(runExportQuery).not.toHaveBeenCalled();
  });

  it('second page starts strictly after the last device id', async () => {
    exportDeviceSet.mockResolvedValue(scope([D1, D2]));
    runExportQuery.mockResolvedValueOnce([scoreRow(D1), scoreRow(D2)]).mockResolvedValueOnce([]);
    const pager = await reliabilityScoresAdapter.createPager(req({}, { pageSize: 1 }));
    const first = await pager(null);
    expect(first.rows).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    await pager(first.nextCursor);
    const second = compiled(1);
    expect(second.sql).toMatch(/"device_id" > \$\d+::uuid/);
    expect(second.params).toContain(D1);
  });

  it('validates timeRange and notes that it does not apply', async () => {
    const bad = req({ timeRange: { start: '2026-01-01T00:00:00Z', end: '2026-11-01T00:00:00Z' } });
    await expect(reliabilityScoresAdapter.createPager(bad)).rejects.toMatchObject({ code: 'invalid_time_range' });
    expect(exportDeviceSet).not.toHaveBeenCalled();
    const ok = req({ timeRange: { start: '2026-10-01T00:00:00Z' } });
    exportDeviceSet.mockResolvedValue(scope([D1]));
    await reliabilityScoresAdapter.createPager(ok);
    expect(ok.notes).toEqual(['reliability_scores is current state; timeRange was not applied.']);
  });

  it('adds no note when no timeRange was supplied', async () => {
    const r = req({});
    exportDeviceSet.mockResolvedValue(scope([D1]));
    await reliabilityScoresAdapter.createPager(r);
    expect(r.notes).toEqual([]);
  });

  it('row carries every window and the hostname from the device set', async () => {
    const [row] = await allRows(reliabilityScoresAdapter, [scoreRow(D1)]);
    expect(Object.keys(row!)).toEqual(SCORE_KEYS);
    expect(row!.hostname).toBe(`h-${D1}`);
    expect(row!.computedAt).toBe('2026-11-13T00:00:00.000Z');
    expect(row).not.toHaveProperty('details');
  });
});


const historyRow = (n: number, text = '2026-11-10 00:00:00.123456') => ({
  id: id(100 + n), deviceId: D1, collectedAt: new Date('2026-11-10T00:00:00.123Z'), collectedAtText: text,
  bootTime: new Date('2026-11-01T00:00:00Z'), uptimeSeconds: 1000,
  crashCount: 1, appHangCount: 2, serviceFailureCount: 3, hardwareErrorCount: 4,
});

describe('reliability_history', () => {
  it('one keyset query: org, device set as one uuid[] param, 30-day default window, desc order', async () => {
    const { sql, params } = await firstQuery(reliabilityHistoryAdapter, req({}));
    expect(sql).toMatch(/"org_id" = \$\d+/);
    expect(sql).toMatch(/"device_id" = ANY\(\$\d+::uuid\[\]\)/);
    expect(params).toContainEqual([D1]);
    expect(sql).toMatch(/order by .*"collected_at" desc, .*"id" desc/i);
    expect(params).toContain(new Date('2026-10-14T12:00:00.000Z').toISOString());
    expect(params).toContain(501);
  });

  it('counts are guarded against a non-array jsonb and raw_metrics is not selected', async () => {
    const { sql } = await firstQuery(reliabilityHistoryAdapter, req({}));
    expect(sql).toContain('jsonb_typeof');
    expect(sql).not.toContain('"raw_metrics"');
    expect(sql).toContain("jsonb_array_length");
  });

  it('cursor carries collected_at::text and the next page uses keysetBefore', async () => {
    exportDeviceSet.mockResolvedValue(scope([D1]));
    runExportQuery.mockResolvedValueOnce([historyRow(1), historyRow(2, '2026-11-09 00:00:00')]).mockResolvedValueOnce([]);
    const pager = await reliabilityHistoryAdapter.createPager(req({}, { pageSize: 1 }));
    const first = await pager(null);
    expect(first.nextCursor).not.toBeNull();
    await pager(first.nextCursor);
    const second = compiled(1);
    expect(second.sql).toMatch(/<= \$\d+::timestamp AND \(/);
    expect(second.params).toContain('2026-11-10 00:00:00.123456');
  });

  it('row shape and hostname', async () => {
    const [row] = await allRows(reliabilityHistoryAdapter, [historyRow(1)]);
    expect(Object.keys(row!)).toEqual([
      'id', 'deviceId', 'hostname', 'collectedAt', 'bootTime', 'uptimeSeconds',
      'crashCount', 'appHangCount', 'serviceFailureCount', 'hardwareErrorCount',
    ]);
    expect(row!.hostname).toBe(`h-${D1}`);
    expect(row!.collectedAt).toBe('2026-11-10T00:00:00.123Z');
  });

  it('empty device set yields nothing and runs no query', async () => {
    exportDeviceSet.mockResolvedValue(scope([]));
    expect(await (await reliabilityHistoryAdapter.createPager(req({})))(null)).toEqual({ rows: [], nextCursor: null });
    expect(runExportQuery).not.toHaveBeenCalled();
  });

  it('a 181-day range is refused before any query', async () => {
    const r = req({ timeRange: { start: '2026-01-01T00:00:00Z', end: '2026-11-01T00:00:00Z' } });
    await expect(reliabilityHistoryAdapter.createPager(r)).rejects.toMatchObject({ code: 'invalid_time_range' });
    expect(exportDeviceSet).not.toHaveBeenCalled();
    expect(runExportQuery).not.toHaveBeenCalled();
  });
});

const EVENT_KEYS = [
  'historyId', 'deviceId', 'hostname', 'collectedAt', 'eventClass', 'eventType', 'timestamp', 'name',
  'severity', 'errorCode', 'eventId', 'duration', 'recovered', 'detail', 'eventKey',
];
const H1 = id(201);
const H2 = id(202);
/** One history row as both queries see it: the key/count query reads `id`,
 *  `collectedAtText` and `eventCount`; the arrays query reads the rest. */
const eventsHistory = (hid: string, over: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = {
    id: hid, deviceId: D1, collectedAt: new Date('2026-11-10T00:00:00Z'), collectedAtText: '2026-11-10 00:00:00',
    crashEvents: [{ type: 'bsod', timestamp: '2026-11-09T01:00:00Z', details: { dump: 'C:\\Users\\jdoe\\x.dmp', token: 't' } }],
    appHangs: [{ processName: 'C:\\Users\\jdoe\\app.exe', timestamp: '2026-11-09T02:00:00Z', duration: 30, resolved: true }],
    serviceFailures: [{ serviceName: 'Spooler', timestamp: 'garbage', errorCode: 'password=hunter2', recovered: false }],
    hardwareErrors: { not: 'an array' },
    ...over,
  };
  const arrays = [row.crashEvents, row.appHangs, row.serviceFailures, row.hardwareErrors];
  return { ...row, collectedAtText: String(row.collectedAtText), eventCount: arrays.reduce<number>((n, a) => n + (Array.isArray(a) ? a.length : 0), 0) };
};
const cursorOf = (c: string | null) => JSON.parse(Buffer.from(c!, 'base64url').toString('utf8')) as string[];
const cursorFor = (key: string[]) => Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');

describe('reliability_events', () => {
  it('flattens every class with one key set, in order', async () => {
    const rows = await allRows(reliabilityEventsAdapter, [
      eventsHistory(H1, { hardwareErrors: [{ type: 'disk', severity: 'error', timestamp: '2026-11-09T03:00:00Z', source: 'disk0', eventId: '7' }] }),
    ]);
    expect(rows.map((r) => r.eventClass)).toEqual(['crash', 'app_hang', 'service_failure', 'hardware_error']);
    for (const r of rows) expect(Object.keys(r)).toEqual(EVENT_KEYS);
    const hw = rows[3]!;
    expect(hw).toMatchObject({ eventType: 'disk', severity: 'error', name: 'disk0', eventId: '7', historyId: H1 });
  });

  it('skips non-array classes and non-object elements without throwing', async () => {
    const rows = await allRows(reliabilityEventsAdapter, [
      eventsHistory(H1, { crashEvents: 'nope', appHangs: [null, 4, 'x'], serviceFailures: [] }),
    ]);
    expect(rows).toEqual([]);
  });

  it('redacts each free-text column', async () => {
    const [crash, hang, svc] = await allRows(reliabilityEventsAdapter, [eventsHistory(H1)]);
    expect(crash!.detail).not.toContain('jdoe');
    expect(crash!.detail).not.toContain('"t"');
    expect(hang!.name).not.toContain('jdoe');
    expect(svc!.errorCode).not.toContain('hunter2');
    expect(svc!.timestamp).toBeNull();
  });

  it('wrong-typed enumerated and numeric columns become null', async () => {
    const [, hang] = await allRows(reliabilityEventsAdapter, [
      eventsHistory(H1, { appHangs: [{ processName: 'a', timestamp: '2026-11-09T02:00:00Z', duration: 'long', resolved: 'yes' }] }),
    ]);
    expect(hang).toMatchObject({ duration: null, recovered: null });
  });

  it('drops an event outside the window by its own timestamp', async () => {
    const rows = await allRows(reliabilityEventsAdapter, [
      eventsHistory(H1, { crashEvents: [{ type: 'bsod', timestamp: '2026-01-01T00:00:00Z' }], appHangs: [], serviceFailures: [] }),
    ]);
    expect(rows).toEqual([]);
  });

  it('carries the scoring dedup key and notes it', async () => {
    const r = req({});
    const rows = await allRows(reliabilityEventsAdapter, [eventsHistory(H1), eventsHistory(H2)], r);
    expect(rows).toHaveLength(6);
    expect(rows[0]!.eventKey).toBe(rows[3]!.eventKey);
    expect(rows[0]!.eventKey).not.toBe(rows[1]!.eventKey);
    expect(r.notes).toContain('reliability_events can list one event more than once; drop duplicates on eventKey.');
  });

  it('first reads keys and counts of rows that HAVE events (limit 2001 at pageSize 500), desc keyset on collected_at', async () => {
    const { sql, params } = await firstQuery(reliabilityEventsAdapter, req({}));
    expect(params).toContain(2001);
    expect(sql).toMatch(/order by .*"collected_at" desc, .*"id" desc/i);
    expect(sql).toMatch(/"device_id" = ANY\(\$\d+::uuid\[\]\)/);
    // Empty rows are skipped in SQL, not paged through.
    expect(sql).toMatch(/jsonb_array_length\(.*\) > 0/);
    // The arrays themselves are not read by this query.
    const selectList = sql.slice(0, sql.indexOf(' from "device_reliability_history"'));
    expect(selectList).not.toMatch(/"(crash_events|app_hangs|service_failures|hardware_errors)"\s*(,|$)/);
  });

  it('then reads only the chosen rows\' arrays, by id, in one query', async () => {
    exportDeviceSet.mockResolvedValue(scope([D1]));
    runExportQuery.mockResolvedValue([eventsHistory(H1), eventsHistory(H2)]);
    await (await reliabilityEventsAdapter.createPager(req({})))(null);
    expect(runExportQuery).toHaveBeenCalledTimes(2);
    const second = compiled(1);
    expect(second.sql).toMatch(/"crash_events"/);
    expect(second.sql).toMatch(/"id" = ANY\(\$\d+::uuid\[\]\)/);
    expect(second.params).toContainEqual([H1, H2]);
    expect(second.sql).not.toMatch(/ limit /i);
  });

  it('no row with events: one query, nothing more', async () => {
    exportDeviceSet.mockResolvedValue(scope([D1]));
    runExportQuery.mockResolvedValue([]);
    expect(await (await reliabilityEventsAdapter.createPager(req({})))(null)).toEqual({ rows: [], nextCursor: null });
    expect(runExportQuery).toHaveBeenCalledTimes(1);
  });

  it('pages on the history row cursor when more rows are left than a page takes', async () => {
    // pageSize 1: budget 4 events, at most 4 rows per page.
    const rows = [1, 2, 3, 4, 5].map((n) => eventsHistory(id(300 + n), {
      collectedAtText: `2026-11-10 00:00:0${9 - n}`,
      crashEvents: [{ type: 'bsod', timestamp: '2026-11-09T01:00:00Z' }], appHangs: [], serviceFailures: [], hardwareErrors: [],
    }));
    exportDeviceSet.mockResolvedValue(scope([D1]));
    runExportQuery.mockResolvedValueOnce(rows).mockResolvedValueOnce(rows.slice(0, 4)).mockResolvedValue([]);
    const pager = await reliabilityEventsAdapter.createPager(req({}, { pageSize: 1 }));
    const first = await pager(null);
    expect(first.rows).toHaveLength(4);
    expect(cursorOf(first.nextCursor)).toEqual(['2026-11-10 00:00:05', id(304), '0']);
    await pager(first.nextCursor);
    expect(compiled(2).params).toContain('2026-11-10 00:00:05');
    expect(compiled(2).sql).toMatch(/\(.*\) < \(\$\d+::timestamp, \$\d+::uuid\)/);
  });

  it('a page whose events all fall outside the window still advances past its rows', async () => {
    const old = Array.from({ length: 10 }, () => ({ type: 'bsod', timestamp: '2026-01-01T00:00:00Z' }));
    const r1 = eventsHistory(H1, { crashEvents: old, appHangs: [], serviceFailures: [], hardwareErrors: [] });
    const r2 = eventsHistory(H2, { collectedAtText: '2026-11-09 00:00:00' });
    exportDeviceSet.mockResolvedValue(scope([D1]));
    runExportQuery.mockResolvedValueOnce([r1, r2]).mockResolvedValueOnce([r1]);
    const page = await (await reliabilityEventsAdapter.createPager(req({}, { pageSize: 1 })))(null);
    expect(page.rows).toEqual([]);
    expect(cursorOf(page.nextCursor)).toEqual([r1.collectedAtText, H1, '0']);
  });

  it('a resumed cursor whose row is gone skips none of the next row\'s events', async () => {
    const next = eventsHistory(H2, { collectedAtText: '2026-11-09 00:00:00' });
    exportDeviceSet.mockResolvedValue(scope([D1]));
    runExportQuery.mockResolvedValue([next]);
    const pager = await reliabilityEventsAdapter.createPager(req({}));
    const page = await pager(cursorFor(['2026-11-10 00:00:00', H1, '5']));
    expect(page.rows.map((r) => r.historyId)).toEqual([H2, H2, H2]);
  });

  it('a cursor row removed between the two queries: the next row loses nothing and the page cursor stays on the key order', async () => {
    const a = eventsHistory(H1, { collectedAtText: '2026-11-10 00:00:00' });
    const b = eventsHistory(H2, { collectedAtText: '2026-11-09 00:00:00' });
    const c = eventsHistory(id(203), { collectedAtText: '2026-11-08 00:00:00' });
    exportDeviceSet.mockResolvedValue(scope([D1]));
    // Key query sees A (the cursor row), B and C; the arrays query finds only B.
    runExportQuery.mockResolvedValueOnce([a, b, c]).mockResolvedValueOnce([b]);
    // pageSize 1: budget 4. need = 4 + offset 1 = 5; A 3 + B 3 = 6 > 5, so A and B are chosen.
    const pager = await reliabilityEventsAdapter.createPager(req({}, { pageSize: 1 }));
    const page = await pager(cursorFor([a.collectedAtText, H1, '1']));
    expect(page.rows.map((r) => r.historyId)).toEqual([H2, H2, H2]);
    expect(cursorOf(page.nextCursor)).toEqual([b.collectedAtText, H2, '0']);
  });

  it('the resumed row\'s skipped events count toward the prefix, so the page still fills', async () => {
    const at = (n: number) => new Date(Date.UTC(2026, 10, 9) + n * 1000).toISOString();
    const a = eventsHistory(H1, {
      collectedAtText: '2026-11-10 00:00:02',
      crashEvents: Array.from({ length: 500 }, (_, n) => ({ type: 'bsod', timestamp: at(n) })),
      appHangs: [], serviceFailures: [], hardwareErrors: [],
    });
    const b = eventsHistory(H2, {
      collectedAtText: '2026-11-10 00:00:01',
      crashEvents: Array.from({ length: 300 }, (_, n) => ({ type: 'bsod', timestamp: at(1000 + n) })),
      appHangs: [], serviceFailures: [], hardwareErrors: [],
    });
    exportDeviceSet.mockResolvedValue(scope([D1]));
    runExportQuery.mockResolvedValue([a, b]);
    // pageSize 100: budget 400. Resuming A at 300 leaves 200 of A; B must be read too.
    const page = await (await reliabilityEventsAdapter.createPager(req({}, { pageSize: 100 })))(cursorFor([a.collectedAtText, H1, '300']));
    expect(compiled(1).params).toContainEqual([H1, H2]);
    expect(page.rows).toHaveLength(400);
    expect(cursorOf(page.nextCursor)).toEqual([b.collectedAtText, H2, '200']);
  });

  it('a supplied range end notes that late-reported events are not included', async () => {
    const r = req({ timeRange: { start: '2026-11-01T00:00:00Z', end: '2026-11-10T00:00:00Z' } });
    await firstQuery(reliabilityEventsAdapter, r);
    expect(r.notes).toContain(RELIABILITY_LATE_EVENTS_NOTE);
    const open = req({});
    await firstQuery(reliabilityEventsAdapter, open);
    expect(open.notes).not.toContain(RELIABILITY_LATE_EVENTS_NOTE);
  });

  it('time range: reads rows collected up to 26 h after end and keeps in-range events from them', async () => {
    const r = req({ timeRange: { start: '2026-11-01T00:00:00Z', end: '2026-11-10T00:00:00Z' } });
    const lateRow = eventsHistory(H1, {
      collectedAt: new Date('2026-11-10T12:00:00Z'), collectedAtText: '2026-11-10 12:00:00',
      crashEvents: [{ type: 'bsod', timestamp: '2026-11-09T23:00:00Z' }], // in range, posted after end
      appHangs: [{ processName: 'a', timestamp: '2026-11-10T06:00:00Z', duration: 1, resolved: true }], // after end
      serviceFailures: [{ serviceName: 'S', timestamp: 'garbage', recovered: false }], // no own time, row after end
      hardwareErrors: [],
    });
    exportDeviceSet.mockResolvedValue(scope([D1]));
    runExportQuery.mockResolvedValue([lateRow]);
    const page = await (await reliabilityEventsAdapter.createPager(r))(null);
    expect(page.rows.map((x) => [x.eventClass, x.timestamp])).toEqual([['crash', '2026-11-09T23:00:00.000Z']]);
    expect(compiled(0).params).toContain('2026-11-11T02:00:00.000Z');
    expect(compiled(0).params).not.toContain('2026-11-10T00:00:00.000Z');
  });

  it('enumerated columns map to the known set; anything else exports as other', async () => {
    const rows = await allRows(reliabilityEventsAdapter, [eventsHistory(H1, {
      crashEvents: [
        { type: 'kernel_panic', timestamp: '2026-11-09T01:00:00Z' },
        { type: 'C:\\Users\\jdoe password=hunter2', timestamp: '2026-11-09T01:00:00Z' },
        { type: 7, timestamp: '2026-11-09T01:00:00Z' },
        { timestamp: '2026-11-09T01:00:00Z' },
      ],
      appHangs: [], serviceFailures: [],
      hardwareErrors: [
        { type: 'thermal', severity: 'warning', source: 's', timestamp: '2026-11-09T01:00:00Z' },
        { type: 'jdoe', severity: 'apocalyptic jdoe', source: 's', timestamp: '2026-11-09T01:00:00Z' },
      ],
    })]);
    expect(rows.map((x) => [x.eventType, x.severity])).toEqual([
      ['kernel_panic', null], ['other', null], ['other', null], [null, null],
      ['thermal', 'warning'], ['other', 'other'],
    ]);
  });

  it('empty device set and a bad range behave like the history dataset', async () => {
    exportDeviceSet.mockResolvedValue(scope([]));
    expect(await (await reliabilityEventsAdapter.createPager(req({})))(null)).toEqual({ rows: [], nextCursor: null });
    expect(runExportQuery).not.toHaveBeenCalled();
    exportDeviceSet.mockClear();
    const bad = req({ timeRange: { start: '2026-01-01T00:00:00Z', end: '2026-11-01T00:00:00Z' } });
    await expect(reliabilityEventsAdapter.createPager(bad)).rejects.toMatchObject({ code: 'invalid_time_range' });
    expect(exportDeviceSet).not.toHaveBeenCalled();
  });

  it('hashes the dedup key: no raw name, error code or path, equal for equal events', async () => {
    const hang = { processName: 'C:\\Users\\jdoe\\app.exe', timestamp: '2026-11-09T02:00:00Z', duration: 3, resolved: true };
    const svc = { serviceName: 'S', timestamp: '2026-11-09T02:00:00Z', errorCode: 'password=hunter2', recovered: false };
    const mk = (hid: string) => eventsHistory(hid, { crashEvents: [], appHangs: [hang], serviceFailures: [svc], hardwareErrors: [] });
    const rows = await allRows(reliabilityEventsAdapter, [mk(H1), mk(H2)]);
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.eventKey).toMatch(/^[0-9a-f]{32}$/);
      expect(String(r.eventKey)).not.toMatch(/jdoe|hunter2/);
    }
    expect(rows[0]!.eventKey).toBe(rows[2]!.eventKey);
    expect(rows[1]!.eventKey).toBe(rows[3]!.eventKey);
    expect(rows[0]!.eventKey).not.toBe(rows[1]!.eventKey);
  });

  it('the dedup key is keyed and bound to the export org: no plain hash of the scoring key, stable per org', async () => {
    // The row also exports the redacted name and error code, so an unkeyed hash
    // of the scoring key would let a holder confirm a guessed name by hashing it.
    const hang = { processName: 'C:\\Users\\jdoe\\app.exe', timestamp: '2026-11-09T02:00:00Z', duration: 3, resolved: true };
    const mk = () => eventsHistory(H1, { crashEvents: [], appHangs: [hang], serviceFailures: [], hardwareErrors: [] });
    const keyFor = async (orgId: string) => (await allRows(reliabilityEventsAdapter, [mk()], req({}, { orgId })))[0]!.eventKey;
    const k1 = await keyFor('org-1');
    expect(k1).toMatch(/^[0-9a-f]{32}$/);
    expect(k1).not.toBe(createHash('sha256').update(reliabilityEventKey('app_hang', hang)).digest('hex').slice(0, 32));
    expect(await keyFor('org-1')).toBe(k1);
    expect(await keyFor('org-2')).not.toBe(k1);
  });

  it('bounds events per page and resumes mid-row from a sub-row cursor', async () => {
    const crashEvents = Array.from({ length: 2500 }, (_, n) => ({
      type: 'bsod', timestamp: new Date(Date.UTC(2026, 10, 9, 0, 0, 0) + n * 1000).toISOString(),
    }));
    exportDeviceSet.mockResolvedValue(scope([D1]));
    runExportQuery.mockResolvedValue([eventsHistory(H1, { crashEvents, appHangs: [], serviceFailures: [], hardwareErrors: [] })]);
    const pager = await reliabilityEventsAdapter.createPager(req({}));
    const p1 = await pager(null);
    expect(p1.rows).toHaveLength(2000);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await pager(p1.nextCursor);
    expect(p2.rows).toHaveLength(500);
    expect(p2.nextCursor).toBeNull();
    const stamps = [...p1.rows, ...p2.rows].map((r) => r.timestamp);
    expect(stamps).toEqual(crashEvents.map((e) => new Date(e.timestamp).toISOString()));
    // the resumed key query (call 2: page 1 ran calls 0 and 1) includes the partly consumed row (<=, not <)
    expect(compiled(2).sql).toMatch(/\(.*\) <= \(\$\d+::timestamp, \$\d+::uuid\)/);
    expect(compiled(0).sql).not.toMatch(/<= \(\$\d+::timestamp/);
  });

  it('a budget that fills exactly at a row boundary resumes at the next row, never skipping it', async () => {
    const at = (n: number) => new Date(Date.UTC(2026, 10, 9) + n * 1000).toISOString();
    const rowA = eventsHistory(H1, {
      collectedAtText: '2026-11-10 00:00:02',
      crashEvents: Array.from({ length: 400 }, (_, n) => ({ type: 'bsod', timestamp: at(n) })),
      appHangs: [], serviceFailures: [], hardwareErrors: [],
    });
    const rowB = eventsHistory(H2, {
      collectedAtText: '2026-11-10 00:00:01',
      crashEvents: Array.from({ length: 50 }, (_, n) => ({ type: 'bsod', timestamp: at(1000 + n) })),
      appHangs: [], serviceFailures: [], hardwareErrors: [],
    });
    exportDeviceSet.mockResolvedValue(scope([D1]));
    // pageSize 100: budget 400. Each page runs the key query, then the arrays query.
    runExportQuery.mockResolvedValueOnce([rowA, rowB]).mockResolvedValueOnce([rowA, rowB]);
    const pager = await reliabilityEventsAdapter.createPager(req({}, { pageSize: 100 }));
    const p1 = await pager(null);
    expect(p1.rows).toHaveLength(400);
    // Row A is fully consumed; the cursor must resume strictly after A, not after B.
    expect(JSON.parse(Buffer.from(p1.nextCursor!, 'base64url').toString('utf8'))).toEqual([rowA.collectedAtText, H1, '0']);
    runExportQuery.mockResolvedValueOnce([rowB]).mockResolvedValueOnce([rowB]);
    const p2 = await pager(p1.nextCursor);
    expect(p2.rows.map((r) => r.historyId)).toEqual(Array(50).fill(H2));
    expect(p2.nextCursor).toBeNull();
  });

  it('counts window-filtered events toward the offset so resume stays aligned', async () => {
    const old = Array.from({ length: 1500 }, () => ({ type: 'bsod', timestamp: '2026-01-01T00:00:00Z' }));
    const fresh = Array.from({ length: 700 }, (_, n) => ({ type: 'bsod', timestamp: new Date(Date.UTC(2026, 10, 9) + n * 1000).toISOString() }));
    exportDeviceSet.mockResolvedValue(scope([D1]));
    runExportQuery.mockResolvedValue([eventsHistory(H1, { crashEvents: [...old, ...fresh], appHangs: [], serviceFailures: [], hardwareErrors: [] })]);
    const pager = await reliabilityEventsAdapter.createPager(req({}, { pageSize: 100 })); // budget 400
    const out: Array<Record<string, unknown>> = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const page: { rows: Array<Record<string, unknown>>; nextCursor: string | null } = await pager(cursor);
      out.push(...page.rows);
      cursor = page.nextCursor;
    } while (cursor && ++guard < 20);
    expect(out.map((r) => r.timestamp)).toEqual(fresh.map((e) => new Date(e.timestamp).toISOString()));
  });
});
