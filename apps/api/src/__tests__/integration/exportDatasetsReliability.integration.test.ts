/**
 * Wisp analysis sessions W04 — the set-based `export_dataset` adapters on real
 * Postgres, as the unprivileged app role under forced RLS.
 *
 * What only a real database can show: the org axis comes from RLS plus the
 * adapter's own `org_id` predicate, the site axis comes ONLY from the run's
 * device set (none of these tables has `site_id`), the keyset cursor keeps
 * microsecond precision across pages, and a 5000-device frame binds as one
 * `uuid[]` parameter without erroring.
 *
 * Fixtures are re-seeded per test (the integration setup truncates between
 * tests).
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { DATASET_ADAPTERS, EXPORT_DATASETS, type DatasetRequest, type ExportDataset } from '../../services/aiToolsExportDatasets';
import type { AuthContext } from '../../middleware/auth';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const DAY_MS = 86_400_000;

type Tenant = {
  orgA: string; orgB: string; siteS1: string; siteS2: string;
  a1: string; a2: string; b1: string;
};

async function seedTenant(): Promise<Tenant> {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const s1 = await createSite({ orgId: orgA.id });
    const s2 = await createSite({ orgId: orgA.id });
    const sB = await createSite({ orgId: orgB.id });
    const a1 = await createDevice({ orgId: orgA.id, siteId: s1.id, hostname: 'a1' });
    const a2 = await createDevice({ orgId: orgA.id, siteId: s2.id, hostname: 'a2' });
    const b1 = await createDevice({ orgId: orgB.id, siteId: sB.id, hostname: 'b1' });
    return { orgA: orgA.id, orgB: orgB.id, siteS1: s1.id, siteS2: s2.id, a1: a1.id, a2: a2.id, b1: b1.id };
  });
}

/** `YYYY-MM-DD HH:MM:SS` (UTC) of `daysAgo` days back, for a `timestamp` literal. */
function tsText(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * DAY_MS).toISOString().replace('T', ' ').slice(0, 19);
}

/** One source row for `dataset`, at `ts` (timestamp text), for `deviceId` in `orgId`. */
async function seedRow(dataset: TimeDataset, orgId: string, deviceId: string, ts: string): Promise<void> {
  const t = getTestDb();
  const iso = `${ts.replace(' ', 'T')}Z`;
  switch (dataset) {
    case 'reliability_history':
    case 'reliability_events':
      await t.execute(sql`
        INSERT INTO device_reliability_history (device_id, org_id, collected_at, uptime_seconds, boot_time, crash_events)
        VALUES (${deviceId}, ${orgId}, ${ts}::timestamp, 3600, ${ts}::timestamp,
                ${JSON.stringify([{ type: 'bsod', timestamp: iso, details: {} }])}::jsonb)`);
      return;
    case 'boot_performance':
      await t.execute(sql`
        INSERT INTO device_boot_metrics (device_id, org_id, boot_timestamp, total_boot_seconds, startup_item_count, startup_items)
        VALUES (${deviceId}, ${orgId}, ${ts}::timestamp, 42, 0, '[]'::jsonb)`);
      return;
    case 'hardware_events':
      await t.execute(sql`
        INSERT INTO device_hardware_events (device_id, org_id, component_key, component_type, event_type, occurred_at)
        VALUES (${deviceId}, ${orgId}, ${`disk-${randomUUID().slice(0, 8)}`}, 'physical_disk', 'health_changed', ${`${ts}+00`}::timestamptz)`);
      return;
    case 'service_checks':
      await t.execute(sql`
        INSERT INTO service_process_check_results (org_id, device_id, watch_type, name, status, "timestamp")
        VALUES (${orgId}, ${deviceId}, 'service', 'Spooler', 'stopped', ${ts}::timestamp)`);
      return;
  }
}

async function seedScore(orgId: string, deviceId: string): Promise<void> {
  await getTestDb().execute(sql`
    INSERT INTO device_reliability (device_id, org_id, reliability_score, uptime_score, crash_score, hang_score,
      service_failure_score, hardware_error_score, uptime_7d, uptime_30d, uptime_90d, trend_direction)
    VALUES (${deviceId}, ${orgId}, 90, 90, 90, 90, 90, 90, 99, 99, 99, 'stable')`);
}

const TIME_DATASETS = [
  'reliability_history', 'reliability_events', 'boot_performance', 'hardware_events', 'service_checks',
] as const satisfies readonly ExportDataset[];
type TimeDataset = (typeof TIME_DATASETS)[number];

function orgCtx(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], userId: null };
}

/** An analysis run's auth: an ai_agent principal pinned to the frame (agentAuthContext). */
function runAuth(orgId: string, frame: string[], sites?: string[]): AuthContext {
  return {
    orgId,
    accessibleOrgIds: [orgId],
    canAccessOrg: (id: string) => id === orgId,
    principal: { kind: 'ai_agent', agentId: randomUUID(), runId: randomUUID() },
    allowedDeviceIds: frame,
    ...(sites ? { allowedSiteIds: sites, canAccessSite: (s: string | null | undefined) => !!s && sites.includes(s) } : {}),
  } as unknown as AuthContext;
}

function request(dataset: ExportDataset, orgId: string, frame: string[], o: Partial<DatasetRequest> = {}): DatasetRequest {
  return {
    auth: runAuth(orgId, frame),
    orgId,
    filters: {},
    deviceIds: null,
    runTargets: frame,
    siteId: null,
    pageSize: 500,
    exportGrants: { datasets: [...EXPORT_DATASETS], sensitiveGates: [] },
    notes: [],
    ...o,
  };
}

/** Drain a dataset's pager as the app role in `orgId`'s context. */
async function drain(dataset: ExportDataset, req: DatasetRequest) {
  return withDbAccessContext(orgCtx(req.orgId), async () => {
    const pager = await DATASET_ADAPTERS[dataset].createPager(req);
    const pages: Array<{ rows: Array<Record<string, unknown>>; nextCursor: string | null }> = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 100; guard++) {
      const page = await pager(cursor);
      pages.push(page);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return { pages, rows: pages.flatMap((p) => p.rows) };
  });
}

const devicesOf = (rows: Array<Record<string, unknown>>) => [...new Set(rows.map((r) => r.deviceId as string))].sort();
const rowKey = (r: Record<string, unknown>) => (r.id ?? r.historyId) as string;

describe('export_dataset W04 datasets on real Postgres (breeze_app, forced RLS)', () => {
  runDb('the code under test runs as a non-BYPASSRLS role (guards against vacuous RLS)', async () => {
    const t = await seedTenant();
    const rows = await withDbAccessContext(orgCtx(t.orgA), () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls FROM pg_roles WHERE rolname = current_user`));
    const row = (rows as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0];
    expect(row?.who).toBe('breeze_app');
    expect(row?.rolbypassrls).toBe(false);
  });

  describe.each(TIME_DATASETS)('%s', (dataset) => {
    async function seedTwoEach(t: Tenant) {
      for (const [org, dev] of [[t.orgA, t.a1], [t.orgA, t.a2], [t.orgB, t.b1]] as const) {
        await seedRow(dataset, org, dev, tsText(1));
        await seedRow(dataset, org, dev, tsText(2));
      }
    }

    runDb('org isolation: a frame naming another org\'s device never reads it', async () => {
      const t = await seedTenant();
      await seedTwoEach(t);
      const { rows } = await drain(dataset, request(dataset, t.orgA, [t.a1, t.a2, t.b1]));
      expect(devicesOf(rows)).toEqual([t.a1, t.a2].sort());
      expect(rows).toHaveLength(4);
    });

    runDb('site restriction applies through the device set', async () => {
      const t = await seedTenant();
      await seedTwoEach(t);
      const frame = [t.a1, t.a2];
      const { rows } = await drain(dataset, request(dataset, t.orgA, frame, { auth: runAuth(t.orgA, frame, [t.siteS1]) }));
      expect(devicesOf(rows)).toEqual([t.a1]);
    });

    runDb('a frame with nothing in this org exports nothing', async () => {
      const t = await seedTenant();
      await seedTwoEach(t);
      const { rows } = await drain(dataset, request(dataset, t.orgA, [t.b1]));
      expect(rows).toEqual([]);
    });

    runDb('paging at pageSize 1 keeps microsecond order: no repeat, no skip, ends with a null cursor', async () => {
      const t = await seedTenant();
      const base = tsText(1);
      for (const micros of ['123001', '123002', '123003']) await seedRow(dataset, t.orgA, t.a1, `${base}.${micros}`);
      const { pages, rows } = await drain(dataset, request(dataset, t.orgA, [t.a1], { pageSize: 1 }));
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map(rowKey)).size).toBe(3);
      expect(pages[pages.length - 1]!.nextCursor).toBeNull();
      // Newest first: read the source rows' own order back from the database.
      const ordered = await getTestDb().execute(sql.raw(`SELECT id::text AS id FROM ${TABLE[dataset]}
        WHERE device_id = '${t.a1}' ORDER BY ${TIME_COLUMN[dataset]} DESC, id DESC`));
      expect(rows.map(rowKey)).toEqual((ordered as unknown as Array<{ id: string }>).map((r) => r.id));
    });

    runDb('a 5000-device frame binds as one parameter and returns only in-frame rows', async () => {
      const t = await seedTenant();
      await seedTwoEach(t);
      const frame = [t.a1, ...Array.from({ length: 4999 }, () => randomUUID())];
      const { rows } = await drain(dataset, request(dataset, t.orgA, frame));
      expect(devicesOf(rows)).toEqual([t.a1]);
      expect(rows).toHaveLength(2);
    });

    runDb('the default window is 30 days; an explicit timeRange reaches further back', async () => {
      const t = await seedTenant();
      await seedRow(dataset, t.orgA, t.a1, tsText(31));
      expect((await drain(dataset, request(dataset, t.orgA, [t.a1]))).rows).toEqual([]);
      const start = new Date(Date.now() - 35 * DAY_MS).toISOString();
      const { rows } = await drain(dataset, request(dataset, t.orgA, [t.a1], { filters: { timeRange: { start } } }));
      expect(rows).toHaveLength(1);
    });
  });

  runDb('reliability_history: non-array jsonb counts as 0 instead of failing the page', async () => {
    const t = await seedTenant();
    for (const bad of ['{"a":1}', 'null', '"x"']) {
      await getTestDb().execute(sql`
        INSERT INTO device_reliability_history (device_id, org_id, collected_at, uptime_seconds, boot_time, crash_events, app_hangs)
        VALUES (${t.a1}, ${t.orgA}, ${tsText(1)}::timestamp, 60, ${tsText(1)}::timestamp, ${bad}::jsonb, '{"k":2}'::jsonb)`);
    }
    const { rows } = await drain('reliability_history', request('reliability_history', t.orgA, [t.a1]));
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.crashCount).toBe(0);
      expect(r.appHangCount).toBe(0);
    }
    expect((await drain('reliability_events', request('reliability_events', t.orgA, [t.a1]))).rows).toEqual([]);
  });

  runDb('reliability_events: mid-row resume and a budget that ends on a row boundary lose and repeat nothing', async () => {
    const t = await seedTenant();
    const base = tsText(1);
    const t0 = Date.now() - DAY_MS;
    const at = (n: number) => new Date(t0 + n * 1000).toISOString();
    // pageSize 100: 2 history rows per page, 400 events per page.
    // Newest first: X holds exactly one page of events (boundary), Y spans three
    // pages, Z shares Y's millisecond and differs in microseconds.
    const rowsToSeed: Array<[string, number, number]> = [['123003', 400, 0], ['123002', 900, 10_000], ['123001', 3, 20_000]];
    for (const [micros, count, from] of rowsToSeed) {
      const events = Array.from({ length: count }, (_, n) => ({ type: 'bsod', timestamp: at(from + n) }));
      await getTestDb().execute(sql`
        INSERT INTO device_reliability_history (device_id, org_id, collected_at, uptime_seconds, boot_time, crash_events)
        VALUES (${t.a1}, ${t.orgA}, ${`${base}.${micros}`}::timestamp, 60, ${base}::timestamp, ${JSON.stringify(events)}::jsonb)`);
    }
    const { pages, rows } = await drain('reliability_events', request('reliability_events', t.orgA, [t.a1], { pageSize: 100 }));
    expect(rows).toHaveLength(1303);
    expect(pages.every((p) => p.rows.length <= 400)).toBe(true);
    expect(pages[pages.length - 1]!.nextCursor).toBeNull();
    const expected = rowsToSeed.flatMap(([, count, from]) => Array.from({ length: count }, (_, n) => new Date(at(from + n)).toISOString()));
    expect(rows.map((r) => r.timestamp)).toEqual(expected);
  });

  runDb('reliability_events: empty history rows between non-empty ones cost no pages', async () => {
    const t = await seedTenant();
    const t0 = Date.now() - 2 * DAY_MS;
    const at = (n: number) => new Date(t0 + n * 1000).toISOString();
    // Newest first: a row with 3 events, 1200 empty rows, a row with 2 events,
    // 1200 more empty rows, then a row with 1 event. All inside the default window.
    const insertEvents = async (secondsAgo: number, events: unknown[]) => getTestDb().execute(sql`
      INSERT INTO device_reliability_history (device_id, org_id, collected_at, uptime_seconds, boot_time, crash_events)
      VALUES (${t.a1}, ${t.orgA}, now()::timestamp - make_interval(secs => ${secondsAgo}), 60, now()::timestamp, ${JSON.stringify(events)}::jsonb)`);
    const insertEmpty = async (fromSecondsAgo: number) => getTestDb().execute(sql`
      INSERT INTO device_reliability_history (device_id, org_id, collected_at, uptime_seconds, boot_time)
      SELECT ${t.a1}, ${t.orgA}, now()::timestamp - make_interval(secs => ${fromSecondsAgo} + g), 60, now()::timestamp
      FROM generate_series(1, 1200) AS g`);
    const ev = (from: number, count: number) => Array.from({ length: count }, (_, n) => ({ type: 'bsod', timestamp: at(from + n) }));
    await insertEvents(10, ev(0, 3));
    await insertEmpty(10);
    await insertEvents(2000, ev(100, 2));
    await insertEmpty(2000);
    await insertEvents(4000, ev(200, 1));
    // pageSize 100: a page takes up to 400 events. Paging through the empty
    // rows would take more pages than the drain's 100-page guard.
    const { pages, rows } = await drain('reliability_events', request('reliability_events', t.orgA, [t.a1], { pageSize: 100 }));
    expect(pages).toHaveLength(1);
    expect(pages[0]!.nextCursor).toBeNull();
    expect(rows.map((r) => r.timestamp)).toEqual([...ev(0, 3), ...ev(100, 2), ...ev(200, 1)].map((e) => new Date(e.timestamp).toISOString()));
  });

  runDb('reliability_events: an in-range event posted after the range end is exported', async () => {
    const t = await seedTenant();
    const end = new Date(Date.now() - 5 * DAY_MS);
    const start = new Date(end.getTime() - 10 * DAY_MS);
    const iso = (ms: number) => new Date(ms).toISOString();
    // Collected 12 h after `end`: one event an hour before `end` (in range),
    // one an hour after it (out), one with no usable time (out: its row is
    // outside the range).
    const events = [
      { type: 'bsod', timestamp: iso(end.getTime() - 3_600_000) },
      { type: 'bsod', timestamp: iso(end.getTime() + 3_600_000) },
      { type: 'bsod', timestamp: 'garbage' },
    ];
    await getTestDb().execute(sql`
      INSERT INTO device_reliability_history (device_id, org_id, collected_at, uptime_seconds, boot_time, crash_events)
      VALUES (${t.a1}, ${t.orgA}, ${iso(end.getTime() + 12 * 3_600_000)}::timestamptz AT TIME ZONE 'UTC', 60, now()::timestamp, ${JSON.stringify(events)}::jsonb)`);
    const { rows } = await drain('reliability_events', request('reliability_events', t.orgA, [t.a1], {
      filters: { timeRange: { start: start.toISOString(), end: end.toISOString() } },
    }));
    expect(rows.map((r) => r.timestamp)).toEqual([events[0]!.timestamp]);
  });

  runDb('service_checks exports non-running checks only', async () => {
    const t = await seedTenant();
    await seedRow('service_checks', t.orgA, t.a1, tsText(1));
    await getTestDb().execute(sql`
      INSERT INTO service_process_check_results (org_id, device_id, watch_type, name, status, "timestamp")
      VALUES (${t.orgA}, ${t.a1}, 'service', 'Spooler', 'running', ${tsText(1)}::timestamp)`);
    const { rows } = await drain('service_checks', request('service_checks', t.orgA, [t.a1]));
    expect(rows.map((r) => r.status)).toEqual(['stopped']);
  });

  describe('reliability_scores', () => {
    async function seedScores(t: Tenant) {
      await seedScore(t.orgA, t.a1);
      await seedScore(t.orgA, t.a2);
      await seedScore(t.orgB, t.b1);
    }

    runDb('org isolation, site restriction and an empty frame', async () => {
      const t = await seedTenant();
      await seedScores(t);
      expect(devicesOf((await drain('reliability_scores', request('reliability_scores', t.orgA, [t.a1, t.a2, t.b1]))).rows))
        .toEqual([t.a1, t.a2].sort());
      const frame = [t.a1, t.a2];
      expect(devicesOf((await drain('reliability_scores', request('reliability_scores', t.orgA, frame,
        { auth: runAuth(t.orgA, frame, [t.siteS1]) }))).rows)).toEqual([t.a1]);
      expect((await drain('reliability_scores', request('reliability_scores', t.orgA, [t.b1]))).rows).toEqual([]);
    });

    runDb('pages by device id at pageSize 1 and a 5000-device frame', async () => {
      const t = await seedTenant();
      await seedScores(t);
      const paged = await drain('reliability_scores', request('reliability_scores', t.orgA, [t.a1, t.a2], { pageSize: 1 }));
      expect(paged.rows.map((r) => r.deviceId)).toEqual([t.a1, t.a2].sort());
      expect(paged.pages[paged.pages.length - 1]!.nextCursor).toBeNull();
      const frame = [t.a1, ...Array.from({ length: 4999 }, () => randomUUID())];
      expect(devicesOf((await drain('reliability_scores', request('reliability_scores', t.orgA, frame))).rows)).toEqual([t.a1]);
    });
  });
});

const TABLE: Record<TimeDataset, string> = {
  reliability_history: 'device_reliability_history',
  reliability_events: 'device_reliability_history',
  boot_performance: 'device_boot_metrics',
  hardware_events: 'device_hardware_events',
  service_checks: 'service_process_check_results',
};
const TIME_COLUMN: Record<TimeDataset, string> = {
  reliability_history: 'collected_at',
  reliability_events: 'collected_at',
  boot_performance: 'boot_timestamp',
  hardware_events: 'occurred_at',
  service_checks: '"timestamp"',
};
