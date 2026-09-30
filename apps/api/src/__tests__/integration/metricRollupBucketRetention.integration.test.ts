import './setup';

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../../db';
import { devices, metricRollups } from '../../db/schema';
import { ensureMetricRollupPartitions, runMetricRollupMaintenance } from '../../services/metricRollupMaintenance';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

/**
 * #7531 — every bucket size's retention is enforced by dropping a partition,
 * never by row DELETE.
 *
 * Before #7531 the 300s / 3600s / 86400s buckets shared one monthly partition
 * that was only dropped at the DAILY cutoff (>= 730 days), and 5-minute rows
 * were trimmed with a capped DELETE. A DELETE frees space inside an old month
 * that new writes (which go to the current month) never reuse, so the disk
 * grew ~8 GB/month per 100 agents and was never given back.
 *
 * Now each month is sub-partitioned by bucket size (`_5m`, `_1h`, `_1d`
 * leaves). These tests drive the real maintenance path as `breeze_app` and
 * assert on the catalog: an expired bucket's leaf is GONE (a DROP, which
 * returns its files to the OS), while the leaves holding in-retention hourly
 * and daily rows stay, rows intact. A legacy flat month (the pre-#7531 shape,
 * still present on every existing install) is rewritten into the new shape
 * once its 5-minute rows expire, reclaiming that month's bloat.
 *
 * Months in 2020 are used so no other suite's fixtures (2026-06, the current
 * month) can already sit in metric_rollups_default for them. Retention is
 * passed explicitly — 5m: 30 days (so a 2020 month is expired), hourly/daily:
 * far longer than 2020 is old (so it is not) — rather than read from env.
 */

const RETENTION = { fiveMinute: 30, hourly: 5000, daily: 6000 } as const;
const SUB_MONTH = { start: '2020-01-01 00:00:00', end: '2020-02-01 00:00:00', name: 'metric_rollups_y2020m01' };
const LEGACY_MONTH = { start: '2020-03-01 00:00:00', end: '2020-04-01 00:00:00', name: 'metric_rollups_y2020m03' };

let orgId: string;
let deviceId: string;

async function relkind(name: string): Promise<string | null> {
  const rows = (await getTestDb().execute(sql`
    SELECT c.relkind::text AS kind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = ${name}
  `)) as unknown as Array<{ kind: string }>;
  return rows[0]?.kind ?? null;
}

async function childrenOf(parent: string): Promise<string[]> {
  const rows = (await getTestDb().execute(sql`
    SELECT child.relname AS name
    FROM pg_inherits
    JOIN pg_class child ON child.oid = pg_inherits.inhrelid
    JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
    JOIN pg_namespace n ON n.oid = parent.relnamespace
    WHERE n.nspname = 'public' AND parent.relname = ${parent}
    ORDER BY child.relname
  `)) as unknown as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

async function bucketCounts(monthStart: string, monthEnd: string): Promise<Record<number, number>> {
  const rows = (await getTestDb().execute(sql`
    SELECT bucket_seconds AS "bucketSeconds", count(*)::int AS n
    FROM metric_rollups
    WHERE org_id = ${orgId}
      AND bucket_start >= ${monthStart}::timestamp
      AND bucket_start < ${monthEnd}::timestamp
    GROUP BY bucket_seconds
  `)) as unknown as Array<{ bucketSeconds: number; n: number }>;
  return Object.fromEntries(rows.map((row) => [row.bucketSeconds, row.n]));
}

async function seedMonth(monthStart: string): Promise<void> {
  const base = new Date(`${monthStart.replace(' ', 'T')}Z`);
  const rows = [
    { bucketSeconds: 300, offsets: [0, 300, 600] },
    { bucketSeconds: 3600, offsets: [0, 3600] },
    { bucketSeconds: 86400, offsets: [0] },
  ].flatMap(({ bucketSeconds, offsets }) =>
    offsets.map((offset) => ({
      orgId,
      sourceTable: 'device_metrics',
      deviceId,
      metricType: 'cpu',
      metricName: 'cpu_percent',
      bucketStart: new Date(base.getTime() + offset * 1000),
      bucketSeconds,
      avgValue: 10,
      minValue: 5,
      maxValue: 20,
      sampleCount: 5,
    })),
  );
  await getTestDb().insert(metricRollups).values(rows);
}

async function dropMonth(name: string): Promise<void> {
  await getTestDb().execute(sql.raw(`DROP TABLE IF EXISTS public."${name}"`));
}

describe('metric rollup bucket retention by partition drop (#7531, real DB, breeze_app)', () => {
  beforeAll(async () => {
    // Non-vacuity: the code under test must run as the unprivileged app role,
    // exactly as production, or the SECURITY DEFINER seam proves nothing.
    const rows = await db.execute(sql`SELECT current_user AS who`);
    const who = (Array.isArray(rows) ? (rows[0] as { who?: unknown } | undefined) : undefined)?.who;
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
        agentId: `metric-rollup-retention-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        hostname: 'rollup-retention',
        displayName: 'rollup-retention',
        osType: 'linux',
        osVersion: 'test',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'online',
      })
      .returning({ id: devices.id });
    deviceId = device!.id;
    for (const name of [SUB_MONTH.name, 'metric_rollups_y2020m02', LEGACY_MONTH.name]) {
      await dropMonth(name);
    }
  });

  it('drops the expired 5-minute leaf and keeps the in-retention hourly and daily leaves', async () => {
    // Created through the production seam, so the month has the new shape.
    const ensured = await withSystemDbAccessContext(() =>
      ensureMetricRollupPartitions({ referenceDate: new Date(Date.UTC(2020, 0, 1)), monthsBack: 0, monthsAhead: 1 }),
    );
    expect(ensured).toContain(SUB_MONTH.name);
    expect(await relkind(SUB_MONTH.name)).toBe('p');
    expect(await childrenOf(SUB_MONTH.name)).toEqual([
      `${SUB_MONTH.name}_1d`,
      `${SUB_MONTH.name}_1h`,
      `${SUB_MONTH.name}_5m`,
    ]);

    await seedMonth(SUB_MONTH.start);
    expect(await bucketCounts(SUB_MONTH.start, SUB_MONTH.end)).toEqual({ 300: 3, 3600: 2, 86400: 1 });

    // The rollup writer's ON CONFLICT upsert still resolves through both
    // partition levels (the unique key carries both partition keys).
    await getTestDb()
      .insert(metricRollups)
      .values({
        orgId,
        sourceTable: 'device_metrics',
        deviceId,
        metricType: 'cpu',
        metricName: 'cpu_percent',
        bucketStart: new Date('2020-01-01T00:00:00Z'),
        bucketSeconds: 3600,
        avgValue: 99,
        sampleCount: 5,
      })
      .onConflictDoUpdate({
        target: [
          metricRollups.orgId,
          metricRollups.sourceTable,
          metricRollups.deviceId,
          metricRollups.metricType,
          metricRollups.metricName,
          metricRollups.bucketSeconds,
          metricRollups.bucketStart,
        ],
        set: { avgValue: 99 },
      });
    expect(await bucketCounts(SUB_MONTH.start, SUB_MONTH.end)).toEqual({ 300: 3, 3600: 2, 86400: 1 });

    const result = await runMetricRollupMaintenance({ now: new Date(), retentionDays: RETENTION });

    expect(result.skipped).toBeUndefined();
    expect(result.droppedBucketPartitions).toContain(`${SUB_MONTH.name}_5m`);
    expect(result.droppedBucketPartitions).not.toContain(`${SUB_MONTH.name}_1h`);
    expect(result.droppedBucketPartitions).not.toContain(`${SUB_MONTH.name}_1d`);
    // Partition level: the 5m leaf no longer exists at all (its files are
    // gone), not merely emptied by a DELETE.
    expect(await relkind(`${SUB_MONTH.name}_5m`)).toBeNull();
    expect(await childrenOf(SUB_MONTH.name)).toEqual([`${SUB_MONTH.name}_1d`, `${SUB_MONTH.name}_1h`]);
    expect(await bucketCounts(SUB_MONTH.start, SUB_MONTH.end)).toEqual({ 3600: 2, 86400: 1 });
    expect(result.droppedPartitions).not.toContain(SUB_MONTH.name);

    await dropMonth(SUB_MONTH.name);
    await dropMonth('metric_rollups_y2020m02');
  });

  it('rewrites a legacy flat month into per-bucket leaves once its 5-minute rows expire, reclaiming the space', async () => {
    // The pre-#7531 shape: one flat monthly partition holding every bucket
    // size. Every existing install has these for the current and past months.
    await getTestDb().execute(sql.raw(`
      CREATE TABLE public."${LEGACY_MONTH.name}" PARTITION OF public.metric_rollups
        FOR VALUES FROM ('${LEGACY_MONTH.start}') TO ('${LEGACY_MONTH.end}')
    `));
    await getTestDb().execute(sql.raw(`
      ALTER TABLE public."${LEGACY_MONTH.name}" ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public."${LEGACY_MONTH.name}" FORCE ROW LEVEL SECURITY;
      CREATE POLICY breeze_org_isolation_select ON public."${LEGACY_MONTH.name}" FOR SELECT USING (public.breeze_has_org_access(org_id));
      CREATE POLICY breeze_org_isolation_insert ON public."${LEGACY_MONTH.name}" FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
      CREATE POLICY breeze_org_isolation_update ON public."${LEGACY_MONTH.name}" FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
      CREATE POLICY breeze_org_isolation_delete ON public."${LEGACY_MONTH.name}" FOR DELETE USING (public.breeze_has_org_access(org_id));
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."${LEGACY_MONTH.name}" TO breeze_app;
    `));
    expect(await relkind(LEGACY_MONTH.name)).toBe('r');
    await seedMonth(LEGACY_MONTH.start);
    expect(await bucketCounts(LEGACY_MONTH.start, LEGACY_MONTH.end)).toEqual({ 300: 3, 3600: 2, 86400: 1 });

    const result = await runMetricRollupMaintenance({ now: new Date(), retentionDays: RETENTION });

    expect(result.compactedPartitions).toContain(LEGACY_MONTH.name);
    expect(await relkind(LEGACY_MONTH.name)).toBe('p');
    // No 5m leaf: the expired rows were never copied, so they cost nothing.
    expect(await childrenOf(LEGACY_MONTH.name)).toEqual([`${LEGACY_MONTH.name}_1d`, `${LEGACY_MONTH.name}_1h`]);
    expect(await bucketCounts(LEGACY_MONTH.start, LEGACY_MONTH.end)).toEqual({ 3600: 2, 86400: 1 });

    // The rewritten month is fully converged: RLS forced + the four org
    // policies + the breeze_app grant, on the sub-parent and on every leaf.
    for (const relation of [LEGACY_MONTH.name, `${LEGACY_MONTH.name}_1h`, `${LEGACY_MONTH.name}_1d`]) {
      const [flags] = (await getTestDb().execute(sql`
        SELECT relrowsecurity AS rls, relforcerowsecurity AS forced
        FROM pg_class WHERE relname = ${relation}
      `)) as unknown as Array<{ rls: boolean; forced: boolean }>;
      expect(flags, relation).toMatchObject({ rls: true, forced: true });
      const policies = (await getTestDb().execute(sql`
        SELECT polname FROM pg_policy WHERE polrelid = ${`public.${relation}`}::regclass ORDER BY polname
      `)) as unknown as Array<{ polname: string }>;
      expect(policies.map((p) => p.polname), relation).toEqual([
        'breeze_org_isolation_delete',
        'breeze_org_isolation_insert',
        'breeze_org_isolation_select',
        'breeze_org_isolation_update',
      ]);
    }

    // Idempotent: a second run finds nothing left to do for this month.
    const again = await runMetricRollupMaintenance({ now: new Date(), retentionDays: RETENTION });
    expect(again.compactedPartitions).not.toContain(LEGACY_MONTH.name);
    expect(await bucketCounts(LEGACY_MONTH.start, LEGACY_MONTH.end)).toEqual({ 3600: 2, 86400: 1 });

    await dropMonth(LEGACY_MONTH.name);
  });
});
