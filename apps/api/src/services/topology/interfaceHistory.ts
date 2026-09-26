import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  TOPOLOGY_INTERFACE_HISTORY_MAX_BUCKETS, TOPOLOGY_INTERFACE_HISTORY_MAX_EPOCHS, TOPOLOGY_INTERFACE_METRIC_UNITS,
  TOPOLOGY_INTERFACE_RESOLUTION_BASE_SECONDS, TOPOLOGY_INTERFACE_RESOLUTION_RETENTION_DAYS, topologyInterfaceHistoryQuerySchema,
  type TopologyInterfaceHistoryEpoch, type TopologyInterfaceHistoryQuery, type TopologyInterfaceHistoryResponse,
  type TopologyInterfaceHistorySeries, type TopologyInterfaceMetricSeriesName,
} from '@breeze/shared';
import { db } from '../../db';
import type { TopologyRequestContext } from './access';
import { GraphReadError, graphAuthority } from './graphCursor';
import { nodeExposure, scoped } from './graphRead';
import { calculateInterfaceWindow, INTERFACE_WINDOW_MAX_GAP_CADENCES, INTERFACE_WINDOW_SERIES_FIELDS, type InterfaceRateSample } from './interfaceRates';
import type { TopologyInterfaceRollupReadingsV1 } from './interfaceRollups';
import type { TopologyInterfaceSampleReadingsV1 } from './interfaceMetricTypes';

/**
 * Scoped, bounded interface history (M3 Task 6).
 *
 * A read is side-effect free: it verifies the interface and its graph binding
 * (owner node) in the exact org/site, then reads stored rows only — it never
 * polls, probes, queues a command or rolls anything up. Bucketing is server
 * selected on a fixed per-resolution grid: `auto` takes the finest retained
 * resolution whose base grid fits the range in `maxBuckets`; explicit raw is
 * bounded to seven days by the contract, and raw values are only ever derived
 * from raw samples (never from rollups). Every represented identity epoch —
 * interface generation × source × producer epoch — is its own series: rates
 * are never computed or averaged across a generation, source or producer
 * boundary. Sparse buckets keep null values with gap reasons; zero is only
 * ever a measured zero.
 */
type Resolution = 'raw' | '5m' | '1h';
const DAY_MS = 86_400_000;
const RESOLUTIONS: Resolution[] = ['raw', '5m', '1h'];
const baseMs = (resolution: Resolution) => TOPOLOGY_INTERFACE_RESOLUTION_BASE_SECONDS[resolution] * 1000;
/** Safety cap on rows one history read may materialise (7 d × 30 s × ~3 sources). */
export const TOPOLOGY_INTERFACE_HISTORY_MAX_ROWS = 60_000;
const MAX_POINT_REASONS = 16;

export type HistoryPlan = {
  resolution: Resolution; bucketMs: number; from: number; to: number; buckets: number;
  retentionStart: number; reasons: string[];
};

const bucketCount = (from: number, to: number, size: number) => Math.ceil((to - Math.floor(from / size) * size) / size);

/** Choose resolution and bucket size. Pure. */
export function planTopologyInterfaceHistory(query: TopologyInterfaceHistoryQuery, now: Date): HistoryPlan {
  const reasons: string[] = [];
  const from = Date.parse(query.from);
  let to = Date.parse(query.to);
  if (to > now.getTime()) { to = Math.max(now.getTime(), from + 1); reasons.push('range_clamped_to_now'); }
  const retained = (resolution: Resolution) => from >= now.getTime() - TOPOLOGY_INTERFACE_RESOLUTION_RETENTION_DAYS[resolution] * DAY_MS;
  const max = Math.min(query.maxBuckets, TOPOLOGY_INTERFACE_HISTORY_MAX_BUCKETS);
  let resolution: Resolution;
  if (query.resolution !== 'auto') resolution = query.resolution;
  else {
    resolution = RESOLUTIONS.find(r => retained(r) && bucketCount(from, to, baseMs(r)) <= max)
      ?? RESOLUTIONS.find(retained) ?? '1h';
  }
  const base = baseMs(resolution);
  let size = Math.max(base, Math.ceil((to - from) / max / base) * base);
  while (bucketCount(from, to, size) > max) size += base;
  const alignedFrom = Math.floor(from / size) * size;
  const buckets = bucketCount(from, to, size);
  const retentionStart = now.getTime() - TOPOLOGY_INTERFACE_RESOLUTION_RETENTION_DAYS[resolution] * DAY_MS;
  if (alignedFrom < retentionStart) reasons.push('outside_retention');
  return { resolution, bucketMs: size, from: alignedFrom, to: alignedFrom + buckets * size, buckets, retentionStart, reasons };
}

export type HistoryRawSample = {
  interfaceEpoch: string; sourceId: string; producerEpoch: string; sampledAt: Date;
  readings: Partial<TopologyInterfaceSampleReadingsV1> & Record<string, unknown>;
};
export type HistoryRollupRow = {
  interfaceEpoch: string; sourceId: string; producerEpoch: string; bucketStart: Date;
  validDurationMs: number; sampleCount: number; gapDurationMs: number; readings: TopologyInterfaceRollupReadingsV1;
};
export type HistorySource = { id: string; kind: 'snmp' | 'unifi'; revoked: boolean; rollupDirtyFrom: Date | null };

type SeriesAcc = { min: number; max: number; weighted: number; validMs: number };
type BucketAcc = {
  sampleCount: number; invalid: Record<string, number>;
  series: Partial<Record<TopologyInterfaceMetricSeriesName, SeriesAcc>>;
  seriesReasons: Partial<Record<TopologyInterfaceMetricSeriesName, Record<string, number>>>;
};
type Segment = { interfaceEpoch: string; sourceId: string; producerEpoch: string; first: number; last: number; buckets: Map<number, BucketAcc> };
const segmentKey = (s: { interfaceEpoch: string; sourceId: string; producerEpoch: string }) => JSON.stringify([s.interfaceEpoch, s.sourceId, s.producerEpoch]);
const add = (record: Record<string, number>, reason: string, ms: number) => { record[reason] = (record[reason] ?? 0) + ms; };

function segmentFor(segments: Map<string, Segment>, s: { interfaceEpoch: string; sourceId: string; producerEpoch: string }): Segment {
  const key = segmentKey(s);
  let segment = segments.get(key);
  if (!segment) { segment = { interfaceEpoch: s.interfaceEpoch, sourceId: s.sourceId, producerEpoch: s.producerEpoch, first: Infinity, last: -Infinity, buckets: new Map() }; segments.set(key, segment); }
  return segment;
}
function bucketAt(segment: Segment, start: number): BucketAcc {
  let acc = segment.buckets.get(start);
  if (!acc) { acc = { sampleCount: 0, invalid: {}, series: {}, seriesReasons: {} }; segment.buckets.set(start, acc); }
  segment.first = Math.min(segment.first, start); segment.last = Math.max(segment.last, start);
  return acc;
}
function addSeries(acc: BucketAcc, name: TopologyInterfaceMetricSeriesName, mean: number, min: number, max: number, weight: number) {
  const current = acc.series[name];
  acc.series[name] = current
    ? { min: Math.min(current.min, min), max: Math.max(current.max, max), weighted: current.weighted + mean * weight, validMs: current.validMs + weight }
    : { min, max, weighted: mean * weight, validMs: weight };
}

function toRateSample(sample: HistoryRawSample): InterfaceRateSample {
  const r = sample.readings;
  return {
    interfaceId: 'history', interfaceEpoch: sample.interfaceEpoch, sourceId: sample.sourceId, producerEpoch: sample.producerEpoch,
    sampledAt: sample.sampledAt.toISOString(), expectedIntervalSeconds: Number(r.expectedIntervalSeconds ?? 60),
    counterWidth: (r.counterWidth ?? null) as InterfaceRateSample['counterWidth'], inOctets: r.inOctets ?? null, outOctets: r.outOctets ?? null,
    inErrors: r.inErrors ?? null, outErrors: r.outErrors ?? null, inDiscards: r.inDiscards ?? null, outDiscards: r.outDiscards ?? null,
    inPackets: r.inPackets ?? null, outPackets: r.outPackets ?? null, capacityBps: r.capacityBps ?? null,
    discontinuityTicks: r.discontinuityTicks ?? null, deviceUptimeTicks: r.deviceUptimeTicks ?? null,
    adminStatus: (r.adminStatus ?? 'unknown') as InterfaceRateSample['adminStatus'], operStatus: (r.operStatus ?? 'unknown') as InterfaceRateSample['operStatus'],
  };
}

/** Raw samples → windows (one segment at a time) → duration-split buckets. */
function bucketRaw(samples: HistoryRawSample[], plan: HistoryPlan, names: readonly TopologyInterfaceMetricSeriesName[]): Map<string, Segment> {
  const groups = new Map<string, HistoryRawSample[]>();
  for (const sample of samples) groups.set(segmentKey(sample), [...(groups.get(segmentKey(sample)) ?? []), sample]);
  const segments = new Map<string, Segment>();
  const size = plan.bucketMs;
  for (const members of groups.values()) {
    const ordered = [...members].sort((a, b) => a.sampledAt.getTime() - b.sampledAt.getTime());
    const segment = segmentFor(segments, ordered[0]!);
    for (const sample of ordered) {
      const t = sample.sampledAt.getTime();
      if (t >= plan.from && t < plan.to) bucketAt(segment, Math.floor(t / size) * size).sampleCount += 1;
    }
    for (let i = 1; i < ordered.length; i += 1) {
      const window = calculateInterfaceWindow(toRateSample(ordered[i - 1]!), toRateSample(ordered[i]!));
      const from = Math.max(window.from.getTime(), plan.from), to = Math.min(window.to.getTime(), plan.to);
      if (to <= from) continue;
      for (let start = Math.floor(from / size) * size; start < to; start += size) {
        const overlap = Math.min(to, start + size) - Math.max(from, start);
        if (overlap <= 0) continue;
        const acc = bucketAt(segment, start);
        if (window.invalid.length) { add(acc.invalid, window.invalid[0]!, overlap); continue; }
        for (const name of names) {
          const value = window[INTERFACE_WINDOW_SERIES_FIELDS[name]] as number | null;
          if (typeof value === 'number') addSeries(acc, name, value, value, value, overlap);
          else add(acc.seriesReasons[name] ??= {}, window.reasons[name] ?? 'not_reported', overlap);
        }
      }
    }
  }
  for (const [key, segment] of segments) if (!segment.buckets.size) segments.delete(key);
  return segments;
}

/** Stored rollup buckets (on the base grid) → larger aligned buckets, duration-weighted. */
function bucketRollups(rows: HistoryRollupRow[], plan: HistoryPlan, names: readonly TopologyInterfaceMetricSeriesName[]): Map<string, Segment> {
  const segments = new Map<string, Segment>();
  for (const row of rows) {
    const t = row.bucketStart.getTime();
    if (t < plan.from || t >= plan.to) continue;
    const acc = bucketAt(segmentFor(segments, row), Math.floor(t / plan.bucketMs) * plan.bucketMs);
    acc.sampleCount += Number(row.sampleCount) || 0;
    for (const [reason, ms] of Object.entries(row.readings?.invalid ?? {})) add(acc.invalid, reason, Number(ms) || 0);
    for (const name of names) {
      const s = row.readings?.series?.[name];
      if (s && s.validMs > 0) addSeries(acc, name, s.mean, s.min, s.max, s.validMs);
      else if (row.validDurationMs > 0) add(acc.seriesReasons[name] ??= {}, 'series_unavailable', row.validDurationMs);
    }
  }
  return segments;
}

const byWeight = (record: Record<string, number> | undefined) => Object.entries(record ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([reason]) => reason);

export type BuildHistoryInput = {
  plan: HistoryPlan; query: TopologyInterfaceHistoryQuery; interfaceId: string; interfaceEpoch: string;
  rawSamples: HistoryRawSample[]; rollupRows: HistoryRollupRow[]; sources: HistorySource[]; now: Date;
};

/** Assemble the bounded response from scoped rows. Pure. */
export function buildTopologyInterfaceHistory(input: BuildHistoryInput): TopologyInterfaceHistoryResponse {
  const { plan, query, now } = input;
  const names = query.series;
  const all = plan.resolution === 'raw' ? bucketRaw(input.rawSamples, plan, names) : bucketRollups(input.rollupRows, plan, names);
  const reasons = [...plan.reasons];
  const sourceById = new Map(input.sources.map(source => [source.id, source]));
  // Most recent epochs first; keep a bounded number.
  let segments = [...all.values()].filter(segment => sourceById.has(segment.sourceId))
    .sort((a, b) => b.last - a.last || segmentKey(a).localeCompare(segmentKey(b)));
  if (segments.length > TOPOLOGY_INTERFACE_HISTORY_MAX_EPOCHS) { segments = segments.slice(0, TOPOLOGY_INTERFACE_HISTORY_MAX_EPOCHS); reasons.push('epochs_truncated'); }
  if (!segments.length) reasons.push('no_measurements');
  const size = plan.bucketMs, nowMs = now.getTime();
  const effective = (start: number) => Math.max(0, Math.min(start + size, plan.to, nowMs) - start);
  const latestBySource = new Map<string, Segment>();
  for (const segment of segments) if (!latestBySource.has(segment.sourceId)) latestBySource.set(segment.sourceId, segment);

  const series: TopologyInterfaceHistorySeries[] = [];
  const epochs: TopologyInterfaceHistoryEpoch[] = [];
  const nameCoverage = new Map<string, TopologyInterfaceHistorySeries['coverage'][]>();
  for (const segment of segments) {
    const source = sourceById.get(segment.sourceId)!;
    // A source with un-rolled data keeps its latest epoch open to the interval end.
    const pendingFrom = plan.resolution !== 'raw' && source.rollupDirtyFrom && latestBySource.get(source.id) === segment ? source.rollupDirtyFrom.getTime() : null;
    const lastBucket = pendingFrom !== null ? plan.to - size : segment.last;
    epochs.push({ interfaceEpoch: segment.interfaceEpoch, sourceId: segment.sourceId, sourceKind: source.kind, producerEpoch: segment.producerEpoch,
      current: segment.interfaceEpoch === input.interfaceEpoch, sourceState: source.revoked ? 'stopped' : 'active',
      from: new Date(segment.first).toISOString(), to: new Date(Math.min(segment.last + size, plan.to)).toISOString() });
    for (const name of names) {
      const points: TopologyInterfaceHistorySeries['points'] = [];
      const gaps: TopologyInterfaceHistorySeries['gaps'] = [];
      let open: { from: number; to: number; reason: string } | null = null;
      const close = () => { if (open) gaps.push({ from: new Date(open.from).toISOString(), to: new Date(open.to).toISOString(), reason: open.reason }); open = null; };
      let full = true;
      for (let start = segment.first; start <= lastBucket; start += size) {
        const acc = segment.buckets.get(start);
        const s = acc?.series[name];
        const duration = effective(start);
        const value = s && s.validMs > 0 ? s.weighted / s.validMs : null;
        const validMs = Math.min(s?.validMs ?? 0, duration);
        let pointReasons = [...byWeight(acc?.invalid), ...byWeight(acc?.seriesReasons[name])].filter((r, i, list) => list.indexOf(r) === i);
        if (value === null && !pointReasons.length) {
          pointReasons = [pendingFrom !== null && start + size > pendingFrom ? 'rollup_pending' : start < plan.retentionStart ? 'outside_retention' : 'no_samples'];
        }
        points.push({ at: new Date(start).toISOString(), value, min: value === null ? null : s!.min, max: value === null ? null : s!.max,
          validDurationMs: Math.round(validMs), sampleCount: acc?.sampleCount ?? 0, gapDurationMs: Math.round(Math.max(0, duration - validMs)),
          reasons: pointReasons.slice(0, MAX_POINT_REASONS) });
        if (value === null || duration - validMs > 0) full = false;
        if (value === null) {
          const reason = pointReasons[0]!;
          if (open && (open as { reason: string }).reason === reason) open.to = start + size;
          else { close(); open = { from: start, to: Math.min(start + size, plan.to), reason }; }
        } else close();
      }
      close();
      const anyValue = points.some(point => point.value !== null);
      const coverage = !anyValue ? 'none' : full && segment.first === plan.from && lastBucket >= plan.to - size ? 'complete' : 'partial';
      nameCoverage.set(name, [...(nameCoverage.get(name) ?? []), coverage]);
      series.push({ name, unit: TOPOLOGY_INTERFACE_METRIC_UNITS[name], interfaceEpoch: segment.interfaceEpoch, sourceId: segment.sourceId,
        sourceKind: source.kind, producerEpoch: segment.producerEpoch, coverage, points: points.slice(0, TOPOLOGY_INTERFACE_HISTORY_MAX_BUCKETS),
        gaps: gaps.slice(0, TOPOLOGY_INTERFACE_HISTORY_MAX_BUCKETS), reasons: source.revoked ? ['source_stopped'] : [] });
    }
  }
  const best = names.map(name => {
    const values = nameCoverage.get(name) ?? [];
    return values.includes('complete') ? 'complete' : values.includes('partial') ? 'partial' : 'none';
  });
  const coverage = best.every(value => value === 'complete') ? 'complete' : best.every(value => value === 'none') ? 'none' : 'partial';
  return {
    interfaceId: input.interfaceId, interfaceEpoch: input.interfaceEpoch, resolution: plan.resolution,
    interval: { from: new Date(plan.from).toISOString(), to: new Date(plan.to).toISOString(), bucketSeconds: plan.bucketMs / 1000 },
    series, epochs, coverage, reasons: [...new Set(reasons)], asOf: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Scoped read
// ---------------------------------------------------------------------------
type ReadTx = Pick<typeof db, 'execute'>;
const uuid = z.uuid();
const uuidArray = (ids: string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

/**
 * History for one interface in the request's exact site. 404 for an interface
 * outside the site/org, one whose owner node is deleted or physically gated,
 * and when interface measurement is not exposed (physical + interfaceHealth).
 */
export async function getTopologyInterfaceHistory(
  ctx: TopologyRequestContext, interfaceId: string, query: TopologyInterfaceHistoryQuery, options: { now?: Date } = {},
): Promise<TopologyInterfaceHistoryResponse> {
  if (!uuid.safeParse(interfaceId).success) throw new GraphReadError('invalid_topology_query', 400, 'Invalid interface id');
  const parsed = topologyInterfaceHistoryQuerySchema.safeParse(query);
  if (!parsed.success) throw new GraphReadError('invalid_topology_query', 400, 'Invalid interface history query');
  const authority = await graphAuthority(ctx);
  if (!authority.interfaceHealth) throw new GraphReadError('topology_subject_not_found', 404, 'Topology subject not found');
  const now = options.now ?? new Date();
  const plan = planTopologyInterfaceHistory(parsed.data, now);
  return db.transaction(async (tx: ReadTx) => {
    const [row] = await tx.execute<{ id: string; epoch: string }>(sql`SELECT i.id, i.epoch FROM topology_interfaces i
      JOIN topology_nodes n ON n.id = i.owner_node_id AND ${scoped(ctx.scope, 'n')} AND n.deleted_at IS NULL AND ${nodeExposure(ctx.scope, authority, 'n')}
      WHERE ${scoped(ctx.scope, 'i')} AND i.id = ${interfaceId}::uuid LIMIT 1`);
    if (!row) throw new GraphReadError('topology_subject_not_found', 404, 'Topology subject not found');
    const where = sql`x.org_id = ${ctx.scope.orgId}::uuid AND x.site_id = ${ctx.scope.siteId}::uuid AND x.interface_id = ${row.id}::uuid AND x.resolution = ${plan.resolution}`;
    let rawSamples: HistoryRawSample[] = [], rollupRows: HistoryRollupRow[] = [];
    let rowCount = 0;
    if (plan.resolution === 'raw') {
      // Windows reach back at most three of the slowest cadence: read that far before the interval.
      const reach = INTERFACE_WINDOW_MAX_GAP_CADENCES * 300_000;
      const rows = await tx.execute<{ interface_epoch: string; source_id: string; producer_epoch: string; sampled_at: string | Date; readings: Record<string, unknown> }>(sql`
        SELECT x.interface_epoch, x.source_id, x.producer_epoch, x.sampled_at, x.readings FROM topology_interface_samples x
        WHERE ${where} AND x.sampled_at >= ${new Date(plan.from - reach).toISOString()}::timestamptz AND x.sampled_at < ${new Date(plan.to).toISOString()}::timestamptz
        ORDER BY x.sampled_at LIMIT ${TOPOLOGY_INTERFACE_HISTORY_MAX_ROWS + 1}`);
      rowCount = rows.length;
      rawSamples = rows.slice(0, TOPOLOGY_INTERFACE_HISTORY_MAX_ROWS).map(r => ({ interfaceEpoch: r.interface_epoch, sourceId: r.source_id, producerEpoch: r.producer_epoch,
        sampledAt: new Date(r.sampled_at), readings: r.readings as HistoryRawSample['readings'] }));
    } else {
      const rows = await tx.execute<{ interface_epoch: string; source_id: string; producer_epoch: string; sampled_at: string | Date; readings: Record<string, unknown>;
        valid_duration_ms: string | number; sample_count: number; gap_duration_ms: string | number }>(sql`
        SELECT x.interface_epoch, x.source_id, x.producer_epoch, x.sampled_at, x.readings, x.valid_duration_ms, x.sample_count, x.gap_duration_ms
        FROM topology_interface_samples x
        WHERE ${where} AND x.sampled_at >= ${new Date(plan.from).toISOString()}::timestamptz AND x.sampled_at < ${new Date(plan.to).toISOString()}::timestamptz
        ORDER BY x.sampled_at LIMIT ${TOPOLOGY_INTERFACE_HISTORY_MAX_ROWS + 1}`);
      rowCount = rows.length;
      rollupRows = rows.slice(0, TOPOLOGY_INTERFACE_HISTORY_MAX_ROWS).map(r => ({ interfaceEpoch: r.interface_epoch, sourceId: r.source_id, producerEpoch: r.producer_epoch,
        bucketStart: new Date(r.sampled_at), validDurationMs: Number(r.valid_duration_ms), sampleCount: Number(r.sample_count), gapDurationMs: Number(r.gap_duration_ms),
        readings: r.readings as unknown as TopologyInterfaceRollupReadingsV1 }));
    }
    const sourceIds = [...new Set([...rawSamples, ...rollupRows].map(r => r.sourceId))];
    const sources = sourceIds.length ? (await tx.execute<{ id: string; producer_kind: string; revoked: boolean; rollup_dirty_from: string | Date | null }>(sql`
      SELECT s.id, s.producer_kind, (s.revoked_at IS NOT NULL) AS revoked, s.telemetry_rollup_dirty_from AS rollup_dirty_from
      FROM topology_collection_sources s WHERE ${scoped(ctx.scope, 's')} AND s.protocol = 'if_metrics' AND s.id = ANY(${uuidArray(sourceIds)})
      LIMIT ${sourceIds.length}`)).filter(s => s.producer_kind === 'snmp' || s.producer_kind === 'unifi')
      .map((s): HistorySource => ({ id: s.id, kind: s.producer_kind as HistorySource['kind'], revoked: !!s.revoked, rollupDirtyFrom: s.rollup_dirty_from ? new Date(s.rollup_dirty_from) : null })) : [];
    const response = buildTopologyInterfaceHistory({ plan, query: parsed.data, interfaceId: row.id, interfaceEpoch: row.epoch, rawSamples, rollupRows, sources, now });
    if (rowCount > TOPOLOGY_INTERFACE_HISTORY_MAX_ROWS) response.reasons.push('history_truncated');
    return response;
  });
}
