import { and, eq, inArray, sql } from 'drizzle-orm';
import { assertInTransaction, db } from '../../db';
import { topologyCollectionSources, topologyInterfaceSamples, topologyInterfaces } from '../../db/schema';
import { requireCurrentTopologyTelemetryProducer, type AuthenticatedTopologyTelemetryProducer } from './collectionAuthority';
import {
  parseTopologyInterfaceMetricEnvelopeV1, TOPOLOGY_TELEMETRY_PROTOCOL, topologyInterfaceMetricDigest, topologyInterfaceSampleReadings,
  type TopologyInterfaceMetricEnvelopeV1, type TopologyInterfaceSampleReadingsV1,
} from './interfaceMetricTypes';
import { advanceTopologyHealthRevision } from './monitorOverlays';
import { compareTopologySequences } from './sequence';

/**
 * The `if_metrics` telemetry sink (M3 Task 2, amendment M3-D1).
 *
 * Shares the M2 producer authority model — device/root/epoch fencing, a
 * server-derived source row in `topology_collection_sources`, strictly
 * increasing sequence acceptance — but never creates collection runs and never
 * touches the graph revision. Sequence and replay semantics, per source row
 * (org, site, producer kind, producer, `if_metrics`, authority key):
 *  - One in-flight batch per source: a concurrent batch is refused
 *    (`batch_in_flight`), never queued behind the lock.
 *  - A new producer epoch re-baselines the source (sequence restarts); samples
 *    of the old epoch are retained as history.
 *  - sequence < accepted: `stale_sequence`. sequence == accepted: an exact
 *    replay (same batch digest) is an idempotent no-op counted as duplicates;
 *    any other content is `sequence_conflict`.
 *  - sequence > accepted: all samples are written atomically. A sample whose
 *    identity (interface + epoch, time, source + producer epoch) already exists
 *    with identical readings is a duplicate; with different readings the whole
 *    batch is refused (`sample_conflict`) and nothing is written.
 * Admission is bounded per source by a rolling daily sample/byte quota. Only a
 * change in current measurement (first sample, a return after a gap, status,
 * capacity, width or discontinuity) advances the site's health revision.
 */
export const TOPOLOGY_TELEMETRY_SOURCE_DAILY_SAMPLES = 737_280; // 256 interfaces every 30 s for 24 h
export const TOPOLOGY_TELEMETRY_SOURCE_DAILY_BYTES = 512 * 1024 * 1024;
export const TOPOLOGY_TELEMETRY_MAX_SAMPLE_AGE_MS = 24 * 60 * 60 * 1000;
export const TOPOLOGY_TELEMETRY_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const TOPOLOGY_TELEMETRY_INFLIGHT_LOCK_SEED = 74113;
const DAY_MS = 86_400_000;

export type TopologyTelemetryRejection =
  | 'batch_in_flight' | 'invalid_capture_time' | 'interface_not_authorized' | 'interface_not_found' | 'interface_epoch_mismatch'
  | 'source_revoked' | 'stale_sequence' | 'sequence_conflict' | 'sample_conflict' | 'telemetry_quota_exceeded' | 'partition_unavailable';
export type TopologyInterfaceSampleReceipt = {
  accepted: boolean;
  reason?: TopologyTelemetryRejection;
  sourceId?: string;
  acceptedSequence?: string;
  /** Newly written raw rows (current and historical). */
  inserted: number;
  /** Samples already stored with identical readings (replays). */
  duplicates: number;
  /** Subset of `inserted` that did not advance current measurement (late, or a retired interface generation). */
  historicalOnly: number;
  healthChanged: boolean;
  retryAfterSeconds?: number;
};

/** Advisory lock key enforcing one in-flight batch per telemetry source. */
export const topologyTelemetryInFlightLockKey = (producer: Pick<AuthenticatedTopologyTelemetryProducer, 'sourceIdentity' | 'authorityKey'>) =>
  `${producer.sourceIdentity}|${TOPOLOGY_TELEMETRY_PROTOCOL}|${producer.authorityKey}`;

type WindowState = { startedAt: Date | null; samples: number; bytes: number };
/** Rolling per-source daily admission window. Pure. */
export function planTopologyTelemetryWindow(current: WindowState, now: Date, samples: number, bytes: number): { allowed: boolean; window: { startedAt: Date; samples: number; bytes: number } } {
  const expired = !current.startedAt || now.getTime() - current.startedAt.getTime() >= DAY_MS || current.startedAt.getTime() > now.getTime();
  const base = expired ? { startedAt: now, samples: 0, bytes: 0 } : { startedAt: current.startedAt!, samples: current.samples, bytes: current.bytes };
  const window = { startedAt: base.startedAt, samples: base.samples + samples, bytes: base.bytes + bytes };
  return { allowed: window.samples <= TOPOLOGY_TELEMETRY_SOURCE_DAILY_SAMPLES && window.bytes <= TOPOLOGY_TELEMETRY_SOURCE_DAILY_BYTES, window };
}

type Measurement = { sampledAt: Date; readings: Partial<TopologyInterfaceSampleReadingsV1> };
const HEALTH_FIELDS = ['adminStatus', 'operStatus', 'capacityBps', 'counterWidth', 'discontinuityTicks'] as const;
/** Whether `next` changes an interface's current measurement relative to the
 * latest stored sample. Counter advances alone do not (rates are Task 5). Pure. */
export function topologyInterfaceMeasurementChanged(previous: Measurement | null, next: Measurement & { readings: TopologyInterfaceSampleReadingsV1 }): boolean {
  if (!previous) return true;
  if (next.sampledAt.getTime() - previous.sampledAt.getTime() > 2 * next.readings.expectedIntervalSeconds * 1000) return true;
  if (HEALTH_FIELDS.some(field => (previous.readings[field] ?? null) !== (next.readings[field] ?? null))) return true;
  const before = previous.readings.deviceUptimeTicks, after = next.readings.deviceUptimeTicks;
  return typeof before === 'string' && typeof after === 'string' && BigInt(after) < BigInt(before);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
// Drizzle binds a JS array as separate parameters, so build explicit ARRAY[...] literals.
const sqlArray = (values: readonly string[], type: 'text' | 'uuid') => sql`ARRAY[${sql.join(values.map(value => sql`${value}`), sql`,`)}]::${sql.raw(type)}[]`;
const utcDay = (at: Date) => at.toISOString().slice(0, 10).replaceAll('-', '');
class SampleConflict extends Error {}

/**
 * Authorize, then persist one `if_metrics` batch. Must run inside the caller's
 * DB context transaction; works in a savepoint so a refused batch leaves the
 * caller's transaction usable. Producer rejections (stale epoch, revoked or
 * absent authority, disabled flags) throw; admission outcomes return receipts.
 */
export async function persistTopologyInterfaceSamples(producer: AuthenticatedTopologyTelemetryProducer, input: unknown): Promise<TopologyInterfaceSampleReceipt> {
  assertInTransaction('persistTopologyInterfaceSamples');
  const parsed = parseTopologyInterfaceMetricEnvelopeV1(input);
  if (!parsed.accepted) throw new Error(parsed.reason);
  const envelope: TopologyInterfaceMetricEnvelopeV1 = parsed.envelope;
  const scope = producer.scope;
  const reject = (reason: TopologyTelemetryRejection, extra: Partial<TopologyInterfaceSampleReceipt> = {}): TopologyInterfaceSampleReceipt =>
    ({ accepted: false, reason, inserted: 0, duplicates: 0, historicalOnly: 0, healthChanged: false, ...extra });

  return db.transaction(async () => {
    const [lock] = await db.execute<{ acquired: boolean }>(sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${topologyTelemetryInFlightLockKey(producer)}, ${TOPOLOGY_TELEMETRY_INFLIGHT_LOCK_SEED})) AS acquired`);
    if (lock?.acquired !== true) return reject('batch_in_flight', { retryAfterSeconds: 5 });
    const authority = await requireCurrentTopologyTelemetryProducer(producer, envelope.commandId);
    if (envelope.producerEpoch !== producer.producerEpoch || envelope.configurationRevision !== producer.configurationRevision) throw new Error('producer_epoch_changed');

    const now = new Date();
    if (Date.parse(envelope.finishedAt) > now.getTime() + TOPOLOGY_TELEMETRY_MAX_FUTURE_SKEW_MS
      || Date.parse(envelope.startedAt) < now.getTime() - TOPOLOGY_TELEMETRY_MAX_SAMPLE_AGE_MS) return reject('invalid_capture_time');
    if (envelope.samples.some(sample => !authority.interfaceIds.has(sample.interfaceId))) return reject('interface_not_authorized');

    const ids = envelope.samples.map(sample => sample.interfaceId);
    const interfaces = ids.length ? await db.select({ id: topologyInterfaces.id, epoch: topologyInterfaces.epoch, retiredAt: topologyInterfaces.retiredAt })
      .from(topologyInterfaces).where(and(eq(topologyInterfaces.orgId, scope.orgId), eq(topologyInterfaces.siteId, scope.siteId), inArray(topologyInterfaces.id, ids))) : [];
    const interfaceById = new Map(interfaces.map(row => [row.id, row]));
    for (const sample of envelope.samples) {
      const row = interfaceById.get(sample.interfaceId);
      if (!row) return reject('interface_not_found');
      if (row.epoch !== sample.interfaceEpoch) return reject('interface_epoch_mismatch');
    }

    const identity = and(eq(topologyCollectionSources.orgId, scope.orgId), eq(topologyCollectionSources.siteId, scope.siteId),
      eq(topologyCollectionSources.producerKind, producer.producerKind), eq(topologyCollectionSources.producerId, producer.producerId),
      eq(topologyCollectionSources.protocol, TOPOLOGY_TELEMETRY_PROTOCOL), eq(topologyCollectionSources.contextKey, producer.authorityKey),
      eq(topologyCollectionSources.addressFamily, 'any'));
    let [source] = await db.select().from(topologyCollectionSources).where(identity).for('update');
    if (!source) [source] = await db.insert(topologyCollectionSources).values({ ...scope, producerId: producer.producerId, producerKind: producer.producerKind,
      producerEpoch: producer.producerEpoch, configurationRevision: producer.configurationRevision, protocol: TOPOLOGY_TELEMETRY_PROTOCOL,
      contextKey: producer.authorityKey, addressFamily: 'any', expectedIntervalSeconds: envelope.expectedIntervalSeconds }).returning();
    if (source!.revokedAt && source!.producerEpoch === producer.producerEpoch) return reject('source_revoked');
    if (source!.producerEpoch !== producer.producerEpoch || source!.revokedAt) {
      [source] = await db.update(topologyCollectionSources).set({ producerEpoch: producer.producerEpoch, configurationRevision: producer.configurationRevision,
        epochIssuedAt: now, acceptedSequence: '0', materializedSequence: '0', confirmedSequence: '0', contentDigest: null, revokedAt: null,
        freshUntil: null, confirmedThroughAt: null, currentBaseline: {}, updatedAt: now }).where(eq(topologyCollectionSources.id, source!.id)).returning();
    }
    const current = source!;
    const received = { sourceId: current.id, acceptedSequence: current.acceptedSequence };

    const digest = topologyInterfaceMetricDigest(envelope);
    const order = compareTopologySequences(envelope.sequence, current.acceptedSequence);
    if (order < 0 || (order === 0 && !current.contentDigest)) return reject('stale_sequence', received);
    if (order === 0) return current.contentDigest === digest
      ? { accepted: true, ...received, inserted: 0, duplicates: envelope.samples.length, historicalOnly: 0, healthChanged: false }
      : reject('sequence_conflict', received);

    const bytes = Buffer.byteLength(JSON.stringify(envelope));
    const window = planTopologyTelemetryWindow({ startedAt: current.telemetryWindowStartedAt, samples: current.telemetryWindowSamples, bytes: current.telemetryWindowBytes },
      now, envelope.samples.length, bytes);
    if (!window.allowed) {
      await db.update(topologyCollectionSources).set({ quotaRejectedCount: sql`quota_rejected_count+1`, updatedAt: now }).where(eq(topologyCollectionSources.id, current.id));
      return reject('telemetry_quota_exceeded', { ...received, retryAfterSeconds: 300 });
    }

    // No default partition exists: refuse, rather than fail, a batch whose day is not provisioned.
    const days = [...new Set(envelope.samples.map(sample => utcDay(new Date(sample.sampledAt))))];
    if (days.length) {
      const [missing] = await db.execute<{ missing: number }>(sql`SELECT count(*)::int AS missing FROM unnest(${sqlArray(days, 'text')}) AS d(day)
        WHERE to_regclass('public.topology_interface_samples_raw_p' || d.day) IS NULL`);
      if (Number(missing?.missing ?? 0) > 0) return reject('partition_unavailable', { ...received, retryAfterSeconds: 300 });
    }

    const previous = new Map<string, Measurement>();
    if (ids.length) {
      const rows = await db.execute<{ interface_id: string; sampled_at: Date | string; readings: Record<string, unknown> }>(sql`
        SELECT DISTINCT ON (interface_id) interface_id, sampled_at, readings FROM topology_interface_samples
        WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid AND resolution='raw'
          AND interface_id = ANY(${sqlArray(ids, 'uuid')}) AND sampled_at >= now() - interval '7 days'
        ORDER BY interface_id, sampled_at DESC`);
      for (const row of rows) previous.set(row.interface_id, { sampledAt: new Date(row.sampled_at), readings: row.readings as Partial<TopologyInterfaceSampleReadingsV1> });
    }

    const rows = envelope.samples.map(sample => ({
      orgId: scope.orgId, siteId: scope.siteId, interfaceId: sample.interfaceId, interfaceEpoch: sample.interfaceEpoch,
      sourceId: current.id, producerEpoch: producer.producerEpoch, sourceSequence: envelope.sequence, sampledAt: new Date(sample.sampledAt),
      resolution: 'raw' as const, readings: topologyInterfaceSampleReadings(envelope, sample), sampleCount: 1,
    }));
    const rowKey = (interfaceId: string, at: Date) => `${interfaceId}|${at.getTime()}`;
    let insertedKeys: Set<string>;
    try {
      insertedKeys = await db.transaction(async () => {
        const written = rows.length ? await db.insert(topologyInterfaceSamples).values(rows).onConflictDoNothing()
          .returning({ interfaceId: topologyInterfaceSamples.interfaceId, sampledAt: topologyInterfaceSamples.sampledAt }) : [];
        const keys = new Set(written.map(row => rowKey(row.interfaceId, row.sampledAt)));
        const skipped = rows.filter(row => !keys.has(rowKey(row.interfaceId, row.sampledAt)));
        if (skipped.length) {
          const existing = await db.select({ interfaceId: topologyInterfaceSamples.interfaceId, sampledAt: topologyInterfaceSamples.sampledAt, readings: topologyInterfaceSamples.readings })
            .from(topologyInterfaceSamples).where(and(eq(topologyInterfaceSamples.resolution, 'raw'), eq(topologyInterfaceSamples.orgId, scope.orgId),
              eq(topologyInterfaceSamples.siteId, scope.siteId), eq(topologyInterfaceSamples.sourceId, current.id),
              eq(topologyInterfaceSamples.producerEpoch, producer.producerEpoch), inArray(topologyInterfaceSamples.interfaceId, skipped.map(row => row.interfaceId)),
              inArray(topologyInterfaceSamples.sampledAt, skipped.map(row => row.sampledAt))));
          const stored = new Map(existing.map(row => [rowKey(row.interfaceId, row.sampledAt), canonical(row.readings)]));
          if (skipped.some(row => stored.get(rowKey(row.interfaceId, row.sampledAt)) !== canonical(row.readings))) throw new SampleConflict();
        }
        return keys;
      });
    } catch (error) {
      if (error instanceof SampleConflict) return reject('sample_conflict', received);
      throw error;
    }

    let historicalOnly = 0, healthChanged = false;
    for (const row of rows) {
      if (!insertedKeys.has(rowKey(row.interfaceId, row.sampledAt))) continue;
      const before = previous.get(row.interfaceId) ?? null;
      if (interfaceById.get(row.interfaceId)!.retiredAt || (before && row.sampledAt.getTime() <= before.sampledAt.getTime())) { historicalOnly += 1; continue; }
      if (topologyInterfaceMeasurementChanged(before, row)) healthChanged = true;
      previous.set(row.interfaceId, row);
    }

    const positive = envelope.outcome === 'complete' || envelope.outcome === 'partial';
    const finishedAt = new Date(envelope.finishedAt);
    await db.update(topologyCollectionSources).set({
      acceptedSequence: envelope.sequence, confirmedSequence: envelope.sequence, contentDigest: digest, lastOutcome: envelope.outcome,
      lastReceivedAt: now, expectedIntervalSeconds: envelope.expectedIntervalSeconds, firstBaselineAt: current.firstBaselineAt ?? now,
      ...(positive ? { confirmedThroughAt: finishedAt, freshUntil: new Date(finishedAt.getTime() + 2 * envelope.expectedIntervalSeconds * 1000) } : {}),
      currentBaseline: { telemetry: { sequence: envelope.sequence, commandId: envelope.commandId, startedAt: envelope.startedAt, finishedAt: envelope.finishedAt,
        outcome: envelope.outcome, reasonCode: envelope.reasonCode, sampleCount: envelope.samples.length } },
      telemetryWindowStartedAt: window.window.startedAt, telemetryWindowSamples: window.window.samples, telemetryWindowBytes: window.window.bytes, updatedAt: now,
    }).where(eq(topologyCollectionSources.id, current.id));
    if (healthChanged) await advanceTopologyHealthRevision(db, scope);
    return { accepted: true, sourceId: current.id, acceptedSequence: envelope.sequence, inserted: insertedKeys.size,
      duplicates: rows.length - insertedKeys.size, historicalOnly, healthChanged };
  });
}
