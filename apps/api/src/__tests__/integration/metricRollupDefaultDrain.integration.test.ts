import './setup';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../../db';
import { devices, metricRollups } from '../../db/schema';
import { runMetricRollupMaintenance } from '../../services/metricRollupMaintenance';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

/**
 * #7541 — metric_rollups_default is drained, not just pruned.
 *
 * A row lands in metric_rollups_default only when its month had no partition
 * when it was written. From then on that month can never be created (the
 * CREATE would have to move the row), so its writes keep landing in the
 * default, retention there is a row DELETE whose space is never returned, and
 * every month creation has to scan the whole default under ACCESS EXCLUSIVE.
 *
 * The maintenance run now swaps the full default out (detached into
 * metric_rollups_staging under a short bounded lock, with a fresh empty
 * default and the blocked months created in its place), moves the retained
 * rows back through metric_rollups in short batches, discards the expired
 * ones, and drops the drained table — which returns all of its space.
 *
 * Runs as breeze_app, exactly as production.
 */

const RETENTION = { fiveMinute: 30, hourly: 5000, daily: 6000 } as const;
// Far-future months: nothing else in the suite partitions them.
const BLOCKED = { start: '2035-01-01 00:00:00', end: '2035-02-01 00:00:00', name: 'metric_rollups_y2035m01' };
const BLOCKED_2 = { start: '2035-03-01 00:00:00', end: '2035-04-01 00:00:00', name: 'metric_rollups_y2035m03' };
const DRAIN_TABLE = 'metric_rollups_default_drain';
// Created by the drain when the test's long daily window keeps 2019 rows.
const EXPIRED_MONTH = 'metric_rollups_y2019m07';
const ALL_MONTHS = [BLOCKED.name, BLOCKED_2.name, EXPIRED_MONTH];

let orgId: string;
let deviceId: string;

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await getTestDb().execute(query)) as unknown as T[];
}

async function relkind(schema: string, name: string): Promise<string | null> {
  const [row] = await rows<{ kind: string }>(sql`
    SELECT c.relkind::text AS kind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND c.relname = ${name}
  `);
  return row?.kind ?? null;
}

async function defaultRowCount(): Promise<number> {
  const [row] = await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM public.metric_rollups_default`);
  return row!.n;
}

async function monthRows(month: { start: string; end: string }): Promise<Array<{ bucketSeconds: number; avg: number }>> {
  return rows(sql`
    SELECT bucket_seconds AS "bucketSeconds", avg_value AS avg
    FROM metric_rollups
    WHERE org_id = ${orgId} AND bucket_start >= ${month.start}::timestamp AND bucket_start < ${month.end}::timestamp
    ORDER BY bucket_seconds, bucket_start
  `);
}

function rollup(at: string, bucketSeconds: 300 | 3600 | 86400, avgValue: number) {
  return {
    orgId,
    sourceTable: 'device_metrics',
    deviceId,
    metricType: 'cpu',
    metricName: 'cpu_percent',
    bucketStart: new Date(at),
    bucketSeconds,
    avgValue,
    sampleCount: 1,
  };
}

async function dropMonth(name: string): Promise<void> {
  await getTestDb().execute(sql.raw(`DROP TABLE IF EXISTS public."${name}"`));
}

describe('metric_rollups_default drain (#7541, real DB, breeze_app)', () => {
  beforeAll(async () => {
    const result = await db.execute(sql`SELECT current_user AS who`);
    const who = (Array.isArray(result) ? (result[0] as { who?: unknown } | undefined) : undefined)?.who;
    expect(who).toBe('breeze_app');
  });

  beforeEach(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    orgId = org.id;
    const [device] = await getTestDb()
      .insert(devices)
      .values({
        orgId,
        siteId: site.id,
        agentId: `metric-rollup-drain-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        hostname: 'rollup-drain',
        displayName: 'rollup-drain',
        osType: 'linux',
        osVersion: 'test',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'online',
      })
      .returning({ id: devices.id });
    deviceId = device!.id;
    await getTestDb().execute(sql.raw(`DROP TABLE IF EXISTS metric_rollups_staging."${DRAIN_TABLE}"`));
    await getTestDb().execute(sql`DELETE FROM public.metric_rollups_default`);
    for (const name of ALL_MONTHS) await dropMonth(name);
  });

  afterEach(async () => {
    for (const name of ALL_MONTHS) await dropMonth(name);
    await getTestDb().execute(sql`DELETE FROM public.metric_rollups_default`);
  });

  it('moves retained rows into newly created month partitions, discards expired ones, and leaves the default empty', async () => {
    // Blocked month: rows sit in the default because the month had no partition.
    await getTestDb().insert(metricRollups).values([
      rollup('2035-01-01T00:00:00Z', 300, 1),
      rollup('2035-01-01T00:05:00Z', 300, 2),
      rollup('2035-01-01T00:00:00Z', 3600, 3),
      rollup('2035-01-01T00:00:00Z', 86400, 4),
      rollup('2035-03-10T00:00:00Z', 3600, 5),
      // Expired 5-minute rows (2019 is far past the 30 day cutoff).
      rollup('2019-07-01T00:00:00Z', 300, 9),
      rollup('2019-07-01T00:05:00Z', 300, 9),
    ]);
    expect(await defaultRowCount()).toBe(7);
    expect(await relkind('public', BLOCKED.name)).toBeNull();

    const result = await runMetricRollupMaintenance({
      now: new Date(),
      retentionDays: RETENTION,
      // Two rows per batch-ish: proves the move loops over several batches.
      defaultDrainPagesPerBatch: 1,
    });

    expect(result.failures).toEqual([]);
    expect(result.defaultPartitionDrain).toMatchObject({
      swapped: true,
      rowsMoved: 5,
      rowsDiscarded: 2,
      completed: true,
    });
    expect(result.defaultPartitionDrain?.monthsCreated).toEqual(expect.arrayContaining([BLOCKED.name, BLOCKED_2.name]));

    // The blocked months now exist in the per-bucket shape and hold the rows.
    expect(await relkind('public', BLOCKED.name)).toBe('p');
    expect(await relkind('public', `${BLOCKED.name}_5m`)).toBe('r');
    expect(await monthRows(BLOCKED)).toEqual([
      { bucketSeconds: 300, avg: 1 },
      { bucketSeconds: 300, avg: 2 },
      { bucketSeconds: 3600, avg: 3 },
      { bucketSeconds: 86400, avg: 4 },
    ]);
    expect(await monthRows(BLOCKED_2)).toEqual([{ bucketSeconds: 3600, avg: 5 }]);
    const [leafCount] = await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM public.metric_rollups_y2035m01_5m`);
    expect(leafCount!.n).toBe(2);

    // The default is empty and the drained table is gone (its space returned).
    expect(await defaultRowCount()).toBe(0);
    expect(await relkind('metric_rollups_staging', DRAIN_TABLE)).toBeNull();

    // The new default is a converged DEFAULT partition of metric_rollups.
    const [attached] = await rows<{ isDefault: boolean }>(sql`
      SELECT pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT' AS "isDefault"
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_inherits i ON i.inhrelid = c.oid
      WHERE n.nspname = 'public' AND c.relname = 'metric_rollups_default'
        AND i.inhparent = 'public.metric_rollups'::regclass
    `);
    expect(attached?.isDefault).toBe(true);
    const [flags] = await rows<{ rls: boolean; forced: boolean }>(sql`
      SELECT relrowsecurity AS rls, relforcerowsecurity AS forced
      FROM pg_class WHERE oid = 'public.metric_rollups_default'::regclass
    `);
    expect(flags).toEqual({ rls: true, forced: true });
    const policies = await rows<{ polname: string }>(sql`
      SELECT polname FROM pg_policy WHERE polrelid = 'public.metric_rollups_default'::regclass ORDER BY polname
    `);
    expect(policies.map((p) => p.polname)).toEqual([
      'breeze_org_isolation_delete',
      'breeze_org_isolation_insert',
      'breeze_org_isolation_select',
      'breeze_org_isolation_update',
    ]);
    const [grant] = await rows<{ ok: boolean }>(sql`
      SELECT has_table_privilege('breeze_app', 'public.metric_rollups_default', 'SELECT')
        AND has_table_privilege('breeze_app', 'public.metric_rollups_default', 'INSERT')
        AND has_table_privilege('breeze_app', 'public.metric_rollups_default', 'UPDATE')
        AND has_table_privilege('breeze_app', 'public.metric_rollups_default', 'DELETE') AS ok
    `);
    expect(grant?.ok).toBe(true);

    // Writes for an unpartitioned month still route to the new default.
    await getTestDb().insert(metricRollups).values(rollup('2040-05-01T00:00:00Z', 3600, 7));
    expect(await defaultRowCount()).toBe(1);

    // Idempotent: a second run with an (almost) empty default reports no swap failures.
    await getTestDb().execute(sql`DELETE FROM public.metric_rollups_default`);
    const again = await runMetricRollupMaintenance({ now: new Date(), retentionDays: RETENTION });
    expect(again.failures).toEqual([]);
    expect(again.defaultPartitionDrain?.swapped).toBe(false);

    for (const month of [BLOCKED, BLOCKED_2]) await dropMonth(month.name);
  });

  it('resumes a drain left over by an interrupted run, keeping a newer live row over the drained copy', async () => {
    const [doomedDevice] = await getTestDb()
      .insert(devices)
      .values({
        orgId,
        siteId: (await rows<{ siteId: string }>(sql`SELECT site_id AS "siteId" FROM devices WHERE id = ${deviceId}`))[0]!.siteId,
        agentId: `metric-rollup-drain-doomed-${Date.now()}`,
        hostname: 'rollup-drain-doomed',
        displayName: 'rollup-drain-doomed',
        osType: 'linux',
        osVersion: 'test',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'online',
      })
      .returning({ id: devices.id });
    await getTestDb().insert(metricRollups).values([
      rollup('2035-01-01T00:00:00Z', 3600, 1),
      rollup('2035-01-01T01:00:00Z', 3600, 2),
      { ...rollup('2035-01-01T02:00:00Z', 3600, 3), deviceId: doomedDevice!.id },
    ]);

    // Swap only (an earlier run died before moving anything).
    await withSystemDbAccessContext(() =>
      db.execute(sql`
        SELECT public.breeze_swap_metric_rollup_default(
          ARRAY['2035-01-01 00:00:00']::timestamp[],
          '2000-01-01 00:00:00'::timestamp
        )
      `),
    );
    expect(await relkind('metric_rollups_staging', DRAIN_TABLE)).toBe('r');
    expect(await relkind('public', BLOCKED.name)).toBe('p');

    // The swap dropped the drain table's FKs: deleting a device mid-drain is
    // not blocked by the drained rows, and those rows are discarded at the move.
    await getTestDb().delete(devices).where(sql`id = ${doomedDevice!.id}`);

    // Meanwhile the rollup writer re-upserted one of the keys into the new month.
    await getTestDb().execute(sql`
      INSERT INTO metric_rollups (org_id, source_table, device_id, metric_type, metric_name, bucket_start, bucket_seconds, avg_value, sample_count, updated_at)
      VALUES (${orgId}, 'device_metrics', ${deviceId}, 'cpu', 'cpu_percent', '2035-01-01 00:00:00', 3600, 50, 1, now() + interval '1 hour')
    `);

    const result = await runMetricRollupMaintenance({ now: new Date(), retentionDays: RETENTION });

    expect(result.failures).toEqual([]);
    expect(result.defaultPartitionDrain).toMatchObject({
      resumed: true,
      swapped: false,
      completed: true,
      rowsMoved: 2,
      rowsDiscarded: 1,
    });
    expect(await monthRows(BLOCKED)).toEqual([
      { bucketSeconds: 3600, avg: 50 },
      { bucketSeconds: 3600, avg: 2 },
    ]);
    expect(await relkind('metric_rollups_staging', DRAIN_TABLE)).toBeNull();

    await dropMonth(BLOCKED.name);
  });

  it('re-inserts a drained row under its device\'s CURRENT org when the device moved mid-drain', async () => {
    await getTestDb().insert(metricRollups).values(rollup('2035-01-01T00:00:00Z', 3600, 1));
    await withSystemDbAccessContext(() =>
      db.execute(sql`SELECT public.breeze_swap_metric_rollup_default(ARRAY['2035-01-01 00:00:00']::timestamp[], '2000-01-01 00:00:00'::timestamp)`),
    );
    const partner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: partner.id });
    const otherSite = await createSite({ orgId: otherOrg.id });
    await getTestDb().execute(sql`UPDATE devices SET org_id = ${otherOrg.id}, site_id = ${otherSite.id} WHERE id = ${deviceId}`);

    const result = await runMetricRollupMaintenance({ now: new Date(), retentionDays: RETENTION });

    expect(result.failures).toEqual([]);
    const moved = await rows<{ orgId: string }>(sql`
      SELECT org_id AS "orgId" FROM metric_rollups
      WHERE device_id = ${deviceId} AND bucket_start = '2035-01-01 00:00:00' AND bucket_seconds = 3600
    `);
    expect(moved).toEqual([{ orgId: otherOrg.id }]);
  });

  it('refuses a second swap while a drain is pending', async () => {
    const swap = () =>
      withSystemDbAccessContext(() =>
        db.execute(sql`SELECT public.breeze_swap_metric_rollup_default(ARRAY[]::timestamp[], '2000-01-01 00:00:00'::timestamp)`),
      );
    await swap();
    let code: string | undefined;
    try {
      await swap();
    } catch (error) {
      code = (error as { cause?: { code?: string } }).cause?.code;
    }
    expect(code).toBe('55000');
    // Finish the (empty) drain so the next test starts clean.
    await withSystemDbAccessContext(() => db.execute(sql`SELECT public.breeze_finish_metric_rollup_default_drain()`));
    expect(await relkind('metric_rollups_staging', DRAIN_TABLE)).toBeNull();
  });

  it('clamps caller cutoffs to the retention floors: a row inside the 30 day 5-minute floor is never discarded', async () => {
    // A 5-minute row from a few days ago, for a month whose partition exists.
    const recent = new Date(Date.now() - 3 * 86_400_000);
    recent.setUTCMinutes(0, 0, 0);
    await withSystemDbAccessContext(() =>
      db.execute(sql`SELECT public.breeze_swap_metric_rollup_default(ARRAY[]::timestamp[], '2000-01-01 00:00:00'::timestamp)`),
    );
    await getTestDb().execute(sql`
      INSERT INTO metric_rollups_staging.metric_rollups_default_drain
        (org_id, source_table, device_id, metric_type, metric_name, bucket_start, bucket_seconds, avg_value, sample_count)
      VALUES (${orgId}, 'device_metrics', ${deviceId}, 'cpu', 'cpu_floor_probe', ${recent.toISOString()}::timestamptz AT TIME ZONE 'UTC', 300, 1, 1)
    `);

    // A caller asking to discard everything older than "now".
    const [batch] = await withSystemDbAccessContext(async () =>
      (await db.execute(sql`
        SELECT rows_moved::int AS moved, rows_discarded::int AS discarded
        FROM public.breeze_drain_metric_rollup_default_batch(0, 1000, now()::timestamp, now()::timestamp, now()::timestamp)
      `)) as unknown as Array<{ moved: number; discarded: number }>,
    );
    expect(batch).toEqual({ moved: 1, discarded: 0 });
    const [kept] = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM metric_rollups WHERE device_id = ${deviceId} AND metric_name = 'cpu_floor_probe'
    `);
    expect(kept!.n).toBe(1);
    await withSystemDbAccessContext(() => db.execute(sql`SELECT public.breeze_finish_metric_rollup_default_drain()`));
    await getTestDb().execute(sql`DELETE FROM metric_rollups WHERE metric_name = 'cpu_floor_probe'`);
  });

  it('does not create a month past the daily cutoff; its rows are discarded', async () => {
    await getTestDb().insert(metricRollups).values(rollup('2019-07-01T00:00:00Z', 86400, 1));

    const result = await runMetricRollupMaintenance({
      now: new Date(),
      retentionDays: { fiveMinute: 30, hourly: 365, daily: 730 },
    });

    expect(result.failures).toEqual([]);
    expect(result.defaultPartitionDrain).toMatchObject({ swapped: true, monthsCreated: [], rowsMoved: 0, rowsDiscarded: 1 });
    expect(await relkind('public', EXPIRED_MONTH)).toBeNull();
    expect(await defaultRowCount()).toBe(0);
  });

  it('moves a drain table spanning many pages in page-range batches', async () => {
    await getTestDb().execute(sql`
      INSERT INTO metric_rollups (org_id, source_table, device_id, metric_type, metric_name, bucket_start, bucket_seconds, avg_value, sample_count)
      SELECT ${orgId}, 'device_metrics', ${deviceId}, 'cpu', 'cpu_percent',
             '2035-01-01 00:00:00'::timestamp + make_interval(mins => 5 * g), 300, g, 1
      FROM generate_series(0, 2999) AS g
    `);
    const [pages] = await rows<{ n: number }>(sql`
      SELECT (pg_relation_size('public.metric_rollups_default') / current_setting('block_size')::bigint)::int AS n
    `);
    expect(pages!.n).toBeGreaterThan(5);

    const result = await runMetricRollupMaintenance({
      now: new Date(),
      retentionDays: RETENTION,
      defaultDrainPagesPerBatch: 2,
    });

    expect(result.failures).toEqual([]);
    expect(result.defaultPartitionDrain).toMatchObject({ swapped: true, rowsMoved: 3000, rowsDiscarded: 0, completed: true });
    const [moved] = await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM public.metric_rollups_y2035m01_5m`);
    expect(moved!.n).toBe(3000);
    expect(await defaultRowCount()).toBe(0);

    await dropMonth(BLOCKED.name);
  });

  it('refuses to move or finish a drain outside system scope (RLS would hide rows)', async () => {
    // Raw connection with no breeze.scope set: breeze_current_scope() is 'none'.
    const failure = async (query: ReturnType<typeof sql>) => {
      try {
        await getTestDb().execute(query);
      } catch (error) {
        const cause = (error as { cause?: { message?: string; code?: string } }).cause;
        return { code: cause?.code, message: cause?.message ?? String(error) };
      }
      return null;
    };
    expect(
      await failure(sql`SELECT * FROM public.breeze_drain_metric_rollup_default_batch(0, 1, now()::timestamp, now()::timestamp, now()::timestamp)`),
    ).toMatchObject({ code: '42501', message: expect.stringContaining('requires breeze.scope = system') });
    expect(await failure(sql`SELECT public.breeze_finish_metric_rollup_default_drain()`)).toMatchObject({
      code: '42501',
      message: expect.stringContaining('requires breeze.scope = system'),
    });
  });
});
