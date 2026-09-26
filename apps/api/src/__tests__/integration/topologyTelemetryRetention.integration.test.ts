import './setup';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import metricFixture from '../../../../../packages/shared/src/testing/topology-interface-metrics-v1.json';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { orgContext } from './topology-fixtures';
import { topologyIngestFixture } from '../helpers/topologyIngest';
import { registerTopologyTelemetryAuthority, resolveTopologyTelemetryProducer } from '../../services/topology/collectionAuthority';
import { persistTopologyInterfaceSamples } from '../../services/topology/interfaceSamples';
import { rollupTopologyInterfaceSource } from '../../services/topology/interfaceRollups';
import { maintainTopologyInterfacePartitions } from '../../services/topology/interfaceRetention';
import { runTopologyTelemetryMaintenanceTick } from '../../jobs/topologyTelemetryMaintenance';

const TARGET = 'snmp:192.0.2.10';
const MIN = 60_000, DAY = 86_400_000;
let allowed: string[] = [];
let unregister: (() => void) | undefined;
beforeEach(() => {
  allowed = [];
  unregister = registerTopologyTelemetryAuthority('snmp', async request => (request.authorityKey === TARGET
    ? { authorized: true, configurationGeneration: 'arm-1', interfaceIds: allowed } : { authorized: false, reason: 'arm_not_found' }));
});
afterEach(() => { unregister?.(); unregister = undefined; });

const system = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));
const iso = (ms: number) => new Date(ms).toISOString();

async function tenant() {
  const f = await topologyIngestFixture();
  const scope = { orgId: f.orgId, siteId: f.siteId };
  const scoped = <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(f.orgId), fn);
  const ifA = crypto.randomUUID();
  await scoped(async () => {
    await db.execute(sql`UPDATE organizations SET settings='{"topologyFeatureFlags":{"materialization":true,"interfaceHealth":true}}' WHERE id=${f.orgId}::uuid`);
    await db.execute(sql`INSERT INTO topology_interfaces (id, org_id, site_id, owner_node_id, interface_key, epoch) VALUES (${ifA}::uuid, ${f.orgId}::uuid, ${f.siteId}::uuid, ${f.nodeId}::uuid, 'port-1', 'gen:1')`);
  });
  allowed = [...allowed, ifA];
  const producer = await scoped(() => resolveTopologyTelemetryProducer({ producerKind: 'snmp', deviceId: f.deviceId, scope, authorityKey: TARGET }));
  let sequence = 0;
  /** One single-sample batch; octets advance 7500 per minute (1000 bps). */
  const write = (atMs: number, octets: bigint) => scoped(() => persistTopologyInterfaceSamples(producer, {
    schemaVersion: 1, family: 'if_metrics', producerEpoch: producer.producerEpoch, sequence: String(++sequence), commandId: null,
    configurationRevision: producer.configurationRevision, startedAt: iso(atMs - 500), finishedAt: iso(atMs + 500), captureAgeAtSendMs: null,
    expectedIntervalSeconds: 60, outcome: 'complete', reasonCode: null,
    samples: [{ ...structuredClone(metricFixture.valid.samples[0]!), interfaceId: ifA, interfaceEpoch: 'gen:1', sampledAt: iso(atMs), counterWidth: 64,
      inOctets: octets.toString(), outOctets: '0', inErrors: '0', outErrors: '0', inDiscards: '0', outDiscards: '0', capacityBps: '1000000',
      discontinuityTicks: '0', deviceUptimeTicks: String(1_000_000 + Math.floor(atMs / 10) % 1_000_000_000) }],
  }));
  const source = async () => (await system(() => db.execute<{ id: string; dirty: Date | string | null }>(sql`SELECT id, telemetry_rollup_dirty_from AS dirty
    FROM topology_collection_sources WHERE org_id=${f.orgId}::uuid AND protocol='if_metrics'`)))[0]!;
  const rows = (resolution: string) => system(() => db.execute<{ sampled_at: Date; sample_count: number; valid_duration_ms: string; readings: { series: { in_bps?: { mean: number } } } }>(sql`
    SELECT sampled_at, sample_count, valid_duration_ms::text AS valid_duration_ms, readings FROM topology_interface_samples
    WHERE org_id=${f.orgId}::uuid AND resolution=${resolution} ORDER BY sampled_at`));
  return { ...f, scope, scoped, ifA, producer, write, source, rows };
}
const rollup = (sourceId: string, through: Date) => system(() => db.transaction(() => rollupTopologyInterfaceSource(sourceId, through)));

describe('topology interface rollups', () => {
  it('rolls closed raw buckets into 5-minute and hourly rows, clears progress and reruns identically', async () => {
    const t = await tenant();
    const now = Date.now();
    const start = Math.floor((now - 3 * 3_600_000) / 3_600_000) * 3_600_000; // an hour boundary in the past
    for (let i = 0; i <= 10; i += 1) expect(await t.write(start + i * MIN, BigInt(i) * 7500n)).toMatchObject({ accepted: true, inserted: 1 });
    const { id, dirty } = await t.source();
    expect(new Date(dirty!).getTime()).toBe(start);

    const first = await rollup(id, new Date(now));
    expect(first).toMatchObject({ busy: false, fiveMinute: 3, hourly: 1 });
    const five = await t.rows('5m');
    expect(five.map(r => [new Date(r.sampled_at).getTime() - start, r.sample_count, Number(r.valid_duration_ms)]))
      .toEqual([[0, 5, 5 * MIN], [5 * MIN, 5, 5 * MIN], [10 * MIN, 1, 0]]);
    expect(five[0]!.readings.series.in_bps!.mean).toBe(1000);
    const [hour] = await t.rows('1h');
    expect(hour!.sample_count).toBe(11);
    expect(hour!.readings.series.in_bps!.mean).toBe(1000);
    expect((await t.source()).dirty).toBeNull();

    // Idempotent: nothing dirty, nothing rewritten.
    expect(await rollup(id, new Date(now))).toMatchObject({ fiveMinute: 0, hourly: 0 });
    expect(await t.rows('5m')).toEqual(five);
  });

  it('re-dirties and recomputes a closed bucket when a late sample lands in it', async () => {
    const t = await tenant();
    const now = Date.now();
    const start = Math.floor((now - 2 * 3_600_000) / 300_000) * 300_000;
    await t.write(start, 0n);
    await t.write(start + 2 * MIN, 15000n);
    const { id } = await t.source();
    await rollup(id, new Date(now));
    expect((await t.rows('5m'))[0]!.sample_count).toBe(2);
    // Late (historical-only) sample between the two, accepted under a higher sequence.
    expect(await t.write(start + MIN, 7500n)).toMatchObject({ accepted: true, historicalOnly: 1 });
    expect(new Date((await t.source()).dirty!).getTime()).toBe(start + MIN);
    await rollup(id, new Date(now));
    const [bucket] = await t.rows('5m');
    expect(bucket!.sample_count).toBe(3);
    expect(Number(bucket!.valid_duration_ms)).toBe(2 * MIN);
  });

  it('skips a source while the telemetry sink holds it on another connection', async () => {
    const t = await tenant();
    await t.write(Date.now() - 3_600_000, 0n);
    const { id } = await t.source();
    const { topologyTelemetryInFlightLockKey, TOPOLOGY_TELEMETRY_INFLIGHT_LOCK_SEED } = await import('../../services/topology/interfaceSamples');
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const isLocked = new Promise<void>(resolve => { locked = resolve; });
    const holder = system(() => db.transaction(async () => {
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${topologyTelemetryInFlightLockKey(t.producer)}, ${TOPOLOGY_TELEMETRY_INFLIGHT_LOCK_SEED}))`);
      locked();
      await gate;
    }));
    await isLocked;
    const held = await rollup(id, new Date()).finally(release);
    await holder;
    expect(held.busy).toBe(true);
    expect((await t.source()).dirty).not.toBeNull();
  });
});

describe('topology interface retention', () => {
  async function seedOld(t: Awaited<ReturnType<typeof tenant>>, resolution: 'raw' | '5m' | '1h', ageMs: number) {
    const at = new Date(Date.now() - ageMs);
    const { id } = await t.source();
    await system(async () => {
      await db.execute(sql`SELECT public.breeze_ensure_topology_interface_sample_partition(${resolution}, ${at.toISOString().slice(0, 10)}::date)`);
      await db.execute(sql`INSERT INTO topology_interface_samples (org_id, site_id, interface_id, interface_epoch, source_id, producer_epoch, source_sequence, sampled_at, resolution, readings)
        VALUES (${t.orgId}::uuid, ${t.siteId}::uuid, ${t.ifA}::uuid, 'gen:1', ${id}::uuid, ${t.producer.producerEpoch}, '1', ${at.toISOString()}::timestamptz, ${resolution}, '{}'::jsonb)`);
    });
  }
  const count = (orgId: string, resolution: string) => system(async () => Number((await db.execute(sql`SELECT count(*)::int AS n FROM topology_interface_samples
    WHERE org_id=${orgId}::uuid AND resolution=${resolution}`))[0]!.n));
  const maintain = () => system(() => db.transaction(() => maintainTopologyInterfacePartitions(new Date())));

  it('drops 8/31/91-day history in every tenant, keeps live rows, and reruns as a no-op', async () => {
    const [a, b] = [await tenant(), await tenant()];
    for (const t of [a, b]) {
      await t.write(Date.now() - 3_600_000, 0n);
      await rollup((await t.source()).id, new Date());
      await seedOld(t, 'raw', 8 * DAY);
      await seedOld(t, '5m', 31 * DAY);
      await seedOld(t, '1h', 91 * DAY);
    }
    const before = { raw: await count(a.orgId, 'raw'), five: await count(a.orgId, '5m'), hour: await count(a.orgId, '1h') };
    const result = await maintain();
    expect(result.dropped).toBeGreaterThanOrEqual(3);
    expect(result.incomplete).toBe(false);
    for (const t of [a, b]) {
      expect(await count(t.orgId, 'raw')).toBe(before.raw - 1);
      expect(await count(t.orgId, '5m')).toBe(before.five - 1);
      expect(await count(t.orgId, '1h')).toBe(before.hour - 1);
    }
    const again = await maintain();
    expect(again).toMatchObject({ created: 0, dropped: 0, deleted: 0, incomplete: false });
    expect(await count(a.orgId, 'raw')).toBe(before.raw - 1);
  });

  it('refuses to discard unrolled raw history and reports backlog', async () => {
    const t = await tenant();
    await t.write(Date.now() - 3_600_000, 0n);
    await seedOld(t, 'raw', 8 * DAY);
    const { id } = await t.source();
    await system(() => db.execute(sql`UPDATE topology_collection_sources SET telemetry_rollup_dirty_from = now() - interval '8 days' WHERE id=${id}::uuid`));
    try {
      const result = await maintain();
      expect(result.backlog).toBeGreaterThanOrEqual(1);
      expect(result.incomplete).toBe(true);
      expect(await count(t.orgId, 'raw')).toBe(2);
    } finally {
      await system(() => db.execute(sql`UPDATE topology_collection_sources SET telemetry_rollup_dirty_from = NULL WHERE id=${id}::uuid`));
    }
  });

  it('never recomputes a complete rollup bucket from raw history retention already expired (maintenance suspended > 7 d)', async () => {
    const t = await tenant();
    const T = Math.floor((Date.now() - 3 * 3_600_000) / 3_600_000) * 3_600_000;
    for (let i = 0; i <= 20; i += 1) await t.write(T + i * MIN, BigInt(i) * 7500n);
    const { id } = await t.source();
    await rollup(id, new Date());
    expect((await t.source()).dirty).toBeNull();
    // More samples land, then maintenance stops (nothing rolls them up) for 8 days.
    for (let i = 21; i <= 30; i += 1) await t.write(T + i * MIN, BigInt(i) * 7500n);
    expect(new Date((await t.source()).dirty!).getTime()).toBe(T + 21 * MIN);
    const shift = 8 * DAY;
    await system(async () => {
      for (const resolution of ['raw', '5m', '1h']) {
        await db.execute(sql`SELECT public.breeze_ensure_topology_interface_sample_partition(${resolution}, ${new Date(T - shift).toISOString().slice(0, 10)}::date)`);
      }
      // Raw rows are immutable: move the history by re-inserting it 8 days earlier.
      const cols = sql.raw('org_id, site_id, interface_id, interface_epoch, source_id, producer_epoch, source_sequence, resolution, readings, valid_duration_ms, sample_count, gap_duration_ms');
      await db.execute(sql`INSERT INTO topology_interface_samples (${cols}, sampled_at)
        SELECT ${cols}, sampled_at - ${`${shift} milliseconds`}::interval FROM topology_interface_samples WHERE org_id=${t.orgId}::uuid`);
      await db.execute(sql`DELETE FROM topology_interface_samples WHERE org_id=${t.orgId}::uuid AND sampled_at >= ${new Date(T).toISOString()}::timestamptz`);
      await db.execute(sql`UPDATE topology_collection_sources SET telemetry_rollup_dirty_from = telemetry_rollup_dirty_from - ${`${shift} milliseconds`}::interval WHERE id=${id}::uuid`);
    });
    const complete = (await t.rows('5m')).map(r => [new Date(r.sampled_at).getTime() - (T - shift), r.sample_count, Number(r.valid_duration_ms)]);
    expect(complete.slice(0, 4)).toEqual([[0, 5, 5 * MIN], [5 * MIN, 5, 5 * MIN], [10 * MIN, 5, 5 * MIN], [15 * MIN, 5, 5 * MIN]]);

    // Maintenance resumes: retention first, then the rollup of the dirty range.
    await maintain();
    await rollup(id, new Date());
    const after = (await t.rows('5m')).map(r => [new Date(r.sampled_at).getTime() - (T - shift), r.sample_count, Number(r.valid_duration_ms)]);
    // Every bucket that was complete stays complete; the formerly open 20-minute
    // bucket is completed from the newly rolled-up samples.
    expect(after.slice(0, 4)).toEqual(complete.slice(0, 4));
    expect(after[4]).toEqual([20 * MIN, 5, 5 * MIN]);
  });

  it('provisions leaves ahead with forced RLS through the worker tick', async () => {
    const tick = await runTopologyTelemetryMaintenanceTick(new Date());
    expect(tick.failed).toBe(0);
    const ahead = new Date(Date.now() + 7 * DAY).toISOString().slice(0, 10).replaceAll('-', '');
    const [leaf] = await system(() => db.execute<{ rls: boolean; forced: boolean; policies: number }>(sql`SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
      (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname) AS policies FROM pg_class c WHERE c.relname = ${`topology_interface_samples_raw_p${ahead}`}`));
    expect(leaf).toEqual({ rls: true, forced: true, policies: 4 });
  });
});
