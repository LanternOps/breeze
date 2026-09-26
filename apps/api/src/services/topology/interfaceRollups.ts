import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { TOPOLOGY_INTERFACE_METRIC_SERIES, type TopologyInterfaceMetricSeriesName, type TopologyScope } from '@breeze/shared';
import { assertInTransaction, db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { topologyCollectionSources, topologyInterfaceSamples } from '../../db/schema';
import { topologySourceIdentity } from './collectionAuthority';
import { TOPOLOGY_TELEMETRY_PROTOCOL } from './interfaceMetricTypes';
import { calculateInterfaceWindow, INTERFACE_WINDOW_MAX_GAP_CADENCES, INTERFACE_WINDOW_SERIES_FIELDS, type InterfaceRateSample, type InterfaceWindow } from './interfaceRates';
import { TOPOLOGY_TELEMETRY_INFLIGHT_LOCK_SEED, topologyTelemetryInFlightLockKey } from './interfaceSamples';

/**
 * Interface rollups (M3 Task 5).
 *
 * Raw samples → 5-minute buckets → hourly buckets, per (interface id + epoch,
 * source + producer epoch): exactly the aggregate row identity of
 * `topology_interface_samples`, so a generation change, source switch or new
 * producer epoch is never merged into one series and no window bridges them.
 * Windows (interfaceRates) are split across bucket boundaries by duration; each
 * series keeps min, max, duration-weighted mean and its own valid duration.
 * Invalid windows (gaps, restarts, discontinuities…) contribute gap time, never
 * a value. Observed state changes are counts, not a claim about every flap.
 *
 * Recomputation is deterministic and idempotent: a bucket is replaced wholesale
 * (delete + insert) under the source's in-flight lock, which the telemetry sink
 * also holds while it writes raw samples and lowers
 * `telemetry_rollup_dirty_from`. Only closed 5-minute buckets are written; the
 * hourly buckets overlapping recomputed 5-minute buckets are rebuilt from the
 * stored 5-minute rows (a still-open hour is rebuilt again as it fills).
 */
export const TOPOLOGY_ROLLUP_BUCKET_MS = { '5m': 300_000, '1h': 3_600_000 } as const;
/** Longest valid window (3 × the 300 s maximum cadence): how far a sample's influence reaches. */
export const TOPOLOGY_ROLLUP_REACH_MS = INTERFACE_WINDOW_MAX_GAP_CADENCES * 300_000;
/** A 5-minute bucket closes this long after its end (late-arrival grace; later arrivals re-dirty it). */
export const TOPOLOGY_ROLLUP_CLOSE_GRACE_MS = 60_000;

export type RollupSample = InterfaceRateSample & { sourceSequence: string };
export type SeriesAggregate = { min: number; max: number; mean: number; validMs: number };
export type TopologyInterfaceRollupReadingsV1 = {
  v: 1; kind: 'rollup'; bucketMs: number;
  series: Partial<Record<TopologyInterfaceMetricSeriesName, SeriesAggregate>>;
  capacityBps: string | null; adminStatus: string | null; operStatus: string | null;
  stateChanges: number;
  /** Invalid window time in the bucket, by reason (ms). */
  invalid: Record<string, number>;
};
export type InterfaceBucketAggregate = {
  resolution: '5m' | '1h'; bucketStart: Date;
  interfaceId: string; interfaceEpoch: string; sourceId: string; producerEpoch: string; sourceSequence: string;
  validDurationMs: number; sampleCount: number; gapDurationMs: number;
  readings: TopologyInterfaceRollupReadingsV1;
};

const floorTo = (ms: number, size: number) => Math.floor(ms / size) * size;
const groupKey = (s: { interfaceId: string; interfaceEpoch: string; sourceId: string; producerEpoch: string }) =>
  JSON.stringify([s.interfaceId, s.interfaceEpoch, s.sourceId, s.producerEpoch]);
const maxSequence = (a: string, b: string) => (BigInt(a) >= BigInt(b) ? a : b);

type Accumulator = {
  bucketStart: number; sampleCount: number; validMs: number; sequence: string; stateChanges: number;
  sums: Partial<Record<TopologyInterfaceMetricSeriesName, { min: number; max: number; weighted: number; validMs: number }>>;
  invalid: Record<string, number>; last: RollupSample | null;
};
function addSeries(acc: Accumulator, name: TopologyInterfaceMetricSeriesName, value: number, min: number, max: number, weight: number) {
  const current = acc.sums[name];
  acc.sums[name] = current
    ? { min: Math.min(current.min, min), max: Math.max(current.max, max), weighted: current.weighted + value * weight, validMs: current.validMs + weight }
    : { min, max, weighted: value * weight, validMs: weight };
}
function finish(resolution: '5m' | '1h', group: { interfaceId: string; interfaceEpoch: string; sourceId: string; producerEpoch: string }, acc: Accumulator,
  extra: { capacityBps: string | null; adminStatus: string | null; operStatus: string | null }): InterfaceBucketAggregate {
  const bucketMs = TOPOLOGY_ROLLUP_BUCKET_MS[resolution];
  const series: TopologyInterfaceRollupReadingsV1['series'] = {};
  for (const name of TOPOLOGY_INTERFACE_METRIC_SERIES) {
    const s = acc.sums[name];
    if (s && s.validMs > 0) series[name] = { min: s.min, max: s.max, mean: s.weighted / s.validMs, validMs: s.validMs };
  }
  const validDurationMs = Math.min(acc.validMs, bucketMs);
  return {
    resolution, bucketStart: new Date(acc.bucketStart), ...group, sourceSequence: acc.sequence,
    validDurationMs, sampleCount: acc.sampleCount, gapDurationMs: bucketMs - validDurationMs,
    readings: { v: 1, kind: 'rollup', bucketMs, series, ...extra, stateChanges: acc.stateChanges, invalid: acc.invalid },
  };
}
const byTime = (a: RollupSample, b: RollupSample) => Date.parse(a.sampledAt) - Date.parse(b.sampledAt)
  || (BigInt(a.sourceSequence) < BigInt(b.sourceSequence) ? -1 : BigInt(a.sourceSequence) > BigInt(b.sourceSequence) ? 1 : 0);
const sortAggregates = (rows: InterfaceBucketAggregate[]) => rows.sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime()
  || groupKey(a).localeCompare(groupKey(b)));

/** Pure: 5-minute aggregates for buckets starting in [range.from, range.to). */
export function aggregateFiveMinuteBuckets(samples: RollupSample[], range: { from: Date; to: Date }): InterfaceBucketAggregate[] {
  const size = TOPOLOGY_ROLLUP_BUCKET_MS['5m'];
  const lo = floorTo(range.from.getTime(), size), hi = range.to.getTime();
  const groups = new Map<string, RollupSample[]>();
  for (const sample of samples) {
    const key = groupKey(sample);
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  const out: InterfaceBucketAggregate[] = [];
  for (const members of groups.values()) {
    const ordered = [...members].sort(byTime);
    const buckets = new Map<number, Accumulator>();
    const bucket = (start: number) => {
      let acc = buckets.get(start);
      if (!acc) { acc = { bucketStart: start, sampleCount: 0, validMs: 0, sequence: '0', stateChanges: 0, sums: {}, invalid: {}, last: null }; buckets.set(start, acc); }
      return acc;
    };
    const inRange = (start: number) => start >= lo && start < hi;
    ordered.forEach((sample, index) => {
      const t = Date.parse(sample.sampledAt), start = floorTo(t, size);
      if (!inRange(start)) return;
      const acc = bucket(start);
      acc.sampleCount += 1;
      acc.sequence = maxSequence(acc.sequence, sample.sourceSequence);
      if (!acc.last || byTime(acc.last, sample) <= 0) acc.last = sample;
      const previous = ordered[index - 1];
      if (previous && (previous.operStatus !== sample.operStatus || previous.adminStatus !== sample.adminStatus)) acc.stateChanges += 1;
    });
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1]!, current = ordered[index]!;
      const window: InterfaceWindow = calculateInterfaceWindow(previous, current);
      const from = window.from.getTime(), to = window.to.getTime();
      if (to <= from) continue;
      for (let start = floorTo(from, size); start < to; start += size) {
        if (!inRange(start)) continue;
        const overlap = Math.min(to, start + size) - Math.max(from, start);
        if (overlap <= 0) continue;
        const acc = bucket(start);
        acc.sequence = maxSequence(acc.sequence, current.sourceSequence);
        if (window.invalid.length) { const reason = window.invalid[0]!; acc.invalid[reason] = (acc.invalid[reason] ?? 0) + overlap; continue; }
        acc.validMs += overlap;
        for (const name of TOPOLOGY_INTERFACE_METRIC_SERIES) {
          const value = window[INTERFACE_WINDOW_SERIES_FIELDS[name]];
          if (typeof value === 'number') addSeries(acc, name, value, value, value, overlap);
        }
      }
    }
    const first = ordered[0]!;
    const group = { interfaceId: first.interfaceId, interfaceEpoch: first.interfaceEpoch, sourceId: first.sourceId, producerEpoch: first.producerEpoch };
    for (const acc of buckets.values()) {
      // State is the latest sample at or before the bucket end.
      const state = acc.last ?? [...ordered].reverse().find(s => Date.parse(s.sampledAt) < acc.bucketStart + size) ?? null;
      out.push(finish('5m', group, acc, { capacityBps: state?.capacityBps ?? null, adminStatus: state?.adminStatus ?? null, operStatus: state?.operStatus ?? null }));
    }
  }
  return sortAggregates(out);
}

/** Pure: hourly aggregates from 5-minute aggregates, for hours starting in [range.from, range.to). */
export function aggregateHourlyBuckets(fiveMinute: InterfaceBucketAggregate[], range: { from: Date; to: Date }): InterfaceBucketAggregate[] {
  const size = TOPOLOGY_ROLLUP_BUCKET_MS['1h'];
  const lo = floorTo(range.from.getTime(), size), hi = range.to.getTime();
  const hours = new Map<string, { group: InterfaceBucketAggregate; acc: Accumulator; latest: InterfaceBucketAggregate }>();
  for (const row of [...fiveMinute].sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime())) {
    if (row.resolution !== '5m') continue;
    const start = floorTo(row.bucketStart.getTime(), size);
    if (start < lo || start >= hi) continue;
    const key = `${groupKey(row)}|${start}`;
    let entry = hours.get(key);
    if (!entry) { entry = { group: row, latest: row, acc: { bucketStart: start, sampleCount: 0, validMs: 0, sequence: '0', stateChanges: 0, sums: {}, invalid: {}, last: null } }; hours.set(key, entry); }
    const { acc } = entry;
    acc.sampleCount += row.sampleCount;
    acc.validMs += row.validDurationMs;
    acc.stateChanges += row.readings.stateChanges;
    acc.sequence = maxSequence(acc.sequence, row.sourceSequence);
    for (const [reason, ms] of Object.entries(row.readings.invalid)) acc.invalid[reason] = (acc.invalid[reason] ?? 0) + ms;
    for (const name of TOPOLOGY_INTERFACE_METRIC_SERIES) {
      const s = row.readings.series[name];
      if (s && s.validMs > 0) addSeries(acc, name, s.mean, s.min, s.max, s.validMs);
    }
    entry.latest = row;
  }
  const out: InterfaceBucketAggregate[] = [];
  for (const { group, acc, latest } of hours.values()) {
    out.push(finish('1h', { interfaceId: group.interfaceId, interfaceEpoch: group.interfaceEpoch, sourceId: group.sourceId, producerEpoch: group.producerEpoch }, acc,
      { capacityBps: latest.readings.capacityBps, adminStatus: latest.readings.adminStatus, operStatus: latest.readings.operStatus }));
  }
  return sortAggregates(out);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
type RawRow = { interface_id: string; interface_epoch: string; producer_epoch: string; source_sequence: string; sampled_at: Date | string; readings: Record<string, unknown> };
type AggRow = RawRow & { resolution: string; valid_duration_ms: string | number; sample_count: number; gap_duration_ms: string | number };

function rawToSample(sourceId: string, row: RawRow): RollupSample {
  const r = row.readings as Partial<RollupSample> & { expectedIntervalSeconds?: number };
  return {
    interfaceId: row.interface_id, interfaceEpoch: row.interface_epoch, sourceId, producerEpoch: row.producer_epoch, sourceSequence: String(row.source_sequence),
    sampledAt: new Date(row.sampled_at).toISOString(), expectedIntervalSeconds: Number(r.expectedIntervalSeconds ?? 60),
    counterWidth: (r.counterWidth ?? null) as RollupSample['counterWidth'], inOctets: r.inOctets ?? null, outOctets: r.outOctets ?? null,
    inErrors: r.inErrors ?? null, outErrors: r.outErrors ?? null, inDiscards: r.inDiscards ?? null, outDiscards: r.outDiscards ?? null,
    inPackets: r.inPackets ?? null, outPackets: r.outPackets ?? null, capacityBps: r.capacityBps ?? null,
    discontinuityTicks: r.discontinuityTicks ?? null, deviceUptimeTicks: r.deviceUptimeTicks ?? null,
    adminStatus: (r.adminStatus ?? 'unknown') as RollupSample['adminStatus'], operStatus: (r.operStatus ?? 'unknown') as RollupSample['operStatus'],
  };
}
function aggToBucket(sourceId: string, row: AggRow): InterfaceBucketAggregate {
  return {
    resolution: row.resolution as '5m', bucketStart: new Date(row.sampled_at), interfaceId: row.interface_id, interfaceEpoch: row.interface_epoch,
    sourceId, producerEpoch: row.producer_epoch, sourceSequence: String(row.source_sequence), validDurationMs: Number(row.valid_duration_ms),
    sampleCount: Number(row.sample_count), gapDurationMs: Number(row.gap_duration_ms), readings: row.readings as TopologyInterfaceRollupReadingsV1,
  };
}
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Missing aggregate leaves are provisioned through the restricted SECURITY DEFINER entry point. */
async function ensureLeaves(resolution: '5m' | '1h', fromMs: number, toMs: number): Promise<void> {
  const days = new Set<string>();
  for (let t = floorTo(fromMs, 86_400_000); t < toMs; t += 86_400_000) days.add(utcDay(t));
  for (const day of days) {
    const [row] = await db.execute<{ present: boolean }>(sql`SELECT to_regclass(${`public.topology_interface_samples_${resolution}_p${day.replaceAll('-', '')}`}) IS NOT NULL AS present`);
    if (!row?.present) await db.execute(sql`SELECT public.breeze_ensure_topology_interface_sample_partition(${resolution}, ${day}::date)`);
  }
}

export type TopologyRollupSourceResult = { fiveMinute: number; hourly: number; busy: boolean };
/**
 * Recompute one telemetry source's dirty closed buckets. Caller provides the
 * system DB context/transaction. Skips (busy) while the sink holds the source.
 */
export async function rollupTopologyInterfaceSource(sourceId: string, through: Date): Promise<TopologyRollupSourceResult> {
  assertInTransaction('rollupTopologyInterfaceSource');
  const [source] = await db.select().from(topologyCollectionSources).where(and(eq(topologyCollectionSources.id, sourceId),
    eq(topologyCollectionSources.protocol, TOPOLOGY_TELEMETRY_PROTOCOL))).limit(1);
  if (!source?.telemetryRollupDirtyFrom) return { fiveMinute: 0, hourly: 0, busy: false };
  const scope = { orgId: source.orgId, siteId: source.siteId };
  const collectorId = source.producerKind === 'unifi' ? source.contextKey.slice(0, source.contextKey.indexOf(':')) : undefined;
  const sourceIdentity = topologySourceIdentity({ scope, producerKind: source.producerKind as 'snmp' | 'unifi', deviceId: source.producerId, collectorId });
  const [lock] = await db.execute<{ acquired: boolean }>(sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${topologyTelemetryInFlightLockKey({ sourceIdentity, authorityKey: source.contextKey })}, ${TOPOLOGY_TELEMETRY_INFLIGHT_LOCK_SEED})) AS acquired`);
  if (lock?.acquired !== true) return { fiveMinute: 0, hourly: 0, busy: true };
  const [locked] = await db.select({ dirtyFrom: topologyCollectionSources.telemetryRollupDirtyFrom }).from(topologyCollectionSources)
    .where(eq(topologyCollectionSources.id, sourceId)).for('update');
  if (!locked?.dirtyFrom) return { fiveMinute: 0, hourly: 0, busy: false };

  const five = TOPOLOGY_ROLLUP_BUCKET_MS['5m'], hour = TOPOLOGY_ROLLUP_BUCKET_MS['1h'];
  const closedThrough = floorTo(through.getTime() - TOPOLOGY_ROLLUP_CLOSE_GRACE_MS, five);
  const rangeStart = floorTo(locked.dirtyFrom.getTime() - TOPOLOGY_ROLLUP_REACH_MS, five);
  const scoped = and(eq(topologyInterfaceSamples.orgId, source.orgId), eq(topologyInterfaceSamples.siteId, source.siteId), eq(topologyInterfaceSamples.sourceId, sourceId));
  // Everything dirty is still in an open bucket: nothing to finalize yet.
  if (rangeStart >= closedThrough) return { fiveMinute: 0, hourly: 0, busy: false };
  const raw = await db.execute<RawRow>(sql`SELECT interface_id, interface_epoch, producer_epoch, source_sequence::text AS source_sequence, sampled_at, readings
    FROM topology_interface_samples WHERE resolution = 'raw' AND org_id = ${source.orgId}::uuid AND site_id = ${source.siteId}::uuid AND source_id = ${sourceId}::uuid
      AND sampled_at >= ${new Date(rangeStart - TOPOLOGY_ROLLUP_REACH_MS).toISOString()}::timestamptz
      AND sampled_at < ${new Date(closedThrough + TOPOLOGY_ROLLUP_REACH_MS).toISOString()}::timestamptz`);
  const rows = aggregateFiveMinuteBuckets(raw.map(row => rawToSample(sourceId, row)), { from: new Date(rangeStart), to: new Date(closedThrough) });
  await ensureLeaves('5m', rangeStart, closedThrough);
  await db.delete(topologyInterfaceSamples).where(and(scoped, eq(topologyInterfaceSamples.resolution, '5m'),
    gte(topologyInterfaceSamples.sampledAt, new Date(rangeStart)), lt(topologyInterfaceSamples.sampledAt, new Date(closedThrough))));
  const insert = (bucket: InterfaceBucketAggregate) => ({ ...scope, interfaceId: bucket.interfaceId, interfaceEpoch: bucket.interfaceEpoch, sourceId,
    producerEpoch: bucket.producerEpoch, sourceSequence: bucket.sourceSequence, sampledAt: bucket.bucketStart, resolution: bucket.resolution,
    readings: bucket.readings as unknown as Record<string, unknown>, validDurationMs: bucket.validDurationMs, sampleCount: bucket.sampleCount,
    gapDurationMs: bucket.gapDurationMs, updatedAt: new Date() });
  for (let i = 0; i < rows.length; i += 500) await db.insert(topologyInterfaceSamples).values(rows.slice(i, i + 500).map(insert));
  const fiveMinute = rows.length;

  // Hours overlapping the recomputed range, rebuilt from the stored 5-minute rows.
  const hourFrom = floorTo(rangeStart, hour), hourTo = floorTo(closedThrough - 1, hour) + hour;
  const stored = await db.execute<AggRow>(sql`SELECT resolution, interface_id, interface_epoch, producer_epoch, source_sequence::text AS source_sequence, sampled_at, readings,
      valid_duration_ms, sample_count, gap_duration_ms
    FROM topology_interface_samples WHERE resolution = '5m' AND org_id = ${source.orgId}::uuid AND site_id = ${source.siteId}::uuid AND source_id = ${sourceId}::uuid
      AND sampled_at >= ${new Date(hourFrom).toISOString()}::timestamptz AND sampled_at < ${new Date(hourTo).toISOString()}::timestamptz`);
  const hours = aggregateHourlyBuckets(stored.map(row => aggToBucket(sourceId, row)), { from: new Date(hourFrom), to: new Date(hourTo) });
  await ensureLeaves('1h', hourFrom, hourTo);
  await db.delete(topologyInterfaceSamples).where(and(scoped, eq(topologyInterfaceSamples.resolution, '1h'),
    gte(topologyInterfaceSamples.sampledAt, new Date(hourFrom)), lt(topologyInterfaceSamples.sampledAt, new Date(hourTo))));
  for (let i = 0; i < hours.length; i += 500) await db.insert(topologyInterfaceSamples).values(hours.slice(i, i + 500).map(insert));
  const hourly = hours.length;
  // Still dirty from the first raw sample in a not-yet-closed bucket (its
  // windows reach back at most TOPOLOGY_ROLLUP_REACH_MS), else fully rolled up.
  await db.update(topologyCollectionSources).set({
    telemetryRollupDirtyFrom: sql`(SELECT min(s.sampled_at) FROM topology_interface_samples s WHERE s.resolution = 'raw' AND s.org_id = ${source.orgId}::uuid
      AND s.site_id = ${source.siteId}::uuid AND s.source_id = ${sourceId}::uuid AND s.sampled_at >= ${new Date(closedThrough).toISOString()}::timestamptz)`,
  }).where(eq(topologyCollectionSources.id, sourceId));
  return { fiveMinute, hourly, busy: false };
}

/** Recompute every dirty telemetry source in one scope, each in its own short system transaction. */
export async function rollupTopologyInterfaceBuckets(scope: TopologyScope, through: Date): Promise<{ fiveMinute: number; hourly: number; busy: number }> {
  const sources = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.select({ id: topologyCollectionSources.id }).from(topologyCollectionSources)
    .where(and(eq(topologyCollectionSources.orgId, scope.orgId), eq(topologyCollectionSources.siteId, scope.siteId),
      eq(topologyCollectionSources.protocol, TOPOLOGY_TELEMETRY_PROTOCOL), isNotNull(topologyCollectionSources.telemetryRollupDirtyFrom)))));
  const total = { fiveMinute: 0, hourly: 0, busy: 0 };
  for (const { id } of sources) {
    const result = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(() => rollupTopologyInterfaceSource(id, through)), 'topology interface rollup'));
    total.fiveMinute += result.fiveMinute; total.hourly += result.hourly; total.busy += result.busy ? 1 : 0;
  }
  return total;
}
