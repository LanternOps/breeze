import { sql } from 'drizzle-orm';
import {
  TOPOLOGY_INTERFACE_HEALTH_THRESHOLDS, TOPOLOGY_INTERFACE_METRIC_SERIES, TOPOLOGY_INTERFACE_METRIC_UNITS,
  type HealthCoverage, type HealthStatus, type TopologyInterfaceMeasurement, type TopologyScope,
} from '@breeze/shared';
import type { db } from '../../db';
import { calculateInterfaceWindow, INTERFACE_WINDOW_SERIES_FIELDS, type InterfaceRateSample } from './interfaceRates';
import type { TopologyInterfaceSampleReadingsV1 } from './interfaceMetricTypes';
import type { TopologyHealthContribution } from './subjectHealth';

/**
 * Current interface-measurement health (M3 Task 6, amendment M3-D10).
 *
 * A pure assessment of one interface generation from its latest stored raw
 * samples. It never polls: the only input is what the telemetry sink already
 * accepted. Rules (operations spec, "Health"):
 *  - freshness = max(3 × expected cadence, 60 s) from the observation, where the
 *    observation time is bounded by the source's last server receipt, so a
 *    future agent clock cannot extend it;
 *  - a fresh explicit `operStatus=down` with admin up is port evidence
 *    (`failed_check`); administratively disabled is its own expected-state
 *    reason; an unknown admin status never implies an unexpected fault;
 *  - errors/discards come from one continuous window of ONE source/producer
 *    epoch/generation (interfaceRates) — never across a restart, generation or
 *    source boundary, and never summed with the neighbouring endpoint;
 *  - a revoked source (measurement stopped/disarmed) is unmonitored at once.
 */
export const INTERFACE_MEASUREMENT_LOOKBACK_MS = 24 * 60 * 60_000;
/** Newest raw samples read per interface: the latest plus its window predecessor(s). */
export const INTERFACE_MEASUREMENT_SAMPLES = 3;

export type InterfaceMeasurementSample = {
  sourceId: string;
  sourceKind: 'snmp' | 'unifi';
  producerEpoch: string;
  sourceRevoked: boolean;
  sourceLastReceivedAt: Date | null;
  sampledAt: Date;
  readings: Partial<TopologyInterfaceSampleReadingsV1>;
};
export type InterfaceMeasurementInput = {
  interfaceId: string;
  interfaceEpoch: string;
  retired: boolean;
  /** Current-generation samples, newest first. */
  samples: InterfaceMeasurementSample[];
};

const DOWN = new Set(['down', 'lower_layer_down']);

export function interfaceFreshnessWindowMs(expectedIntervalSeconds: number): number {
  const cadence = Number.isFinite(expectedIntervalSeconds) && expectedIntervalSeconds > 0 ? expectedIntervalSeconds : 60;
  return Math.max(3 * cadence * 1000, 60_000);
}

function rateSample(interfaceId: string, interfaceEpoch: string, sample: InterfaceMeasurementSample): InterfaceRateSample {
  const r = sample.readings;
  return {
    interfaceId, interfaceEpoch, sourceId: sample.sourceId, producerEpoch: sample.producerEpoch, sampledAt: sample.sampledAt.toISOString(),
    expectedIntervalSeconds: Number(r.expectedIntervalSeconds ?? 60), counterWidth: (r.counterWidth ?? null) as InterfaceRateSample['counterWidth'],
    inOctets: r.inOctets ?? null, outOctets: r.outOctets ?? null, inErrors: r.inErrors ?? null, outErrors: r.outErrors ?? null,
    inDiscards: r.inDiscards ?? null, outDiscards: r.outDiscards ?? null, inPackets: r.inPackets ?? null, outPackets: r.outPackets ?? null,
    capacityBps: r.capacityBps ?? null, discontinuityTicks: r.discontinuityTicks ?? null, deviceUptimeTicks: r.deviceUptimeTicks ?? null,
    adminStatus: (r.adminStatus ?? 'unknown') as InterfaceRateSample['adminStatus'], operStatus: (r.operStatus ?? 'unknown') as InterfaceRateSample['operStatus'],
  };
}

type Measurement = TopologyInterfaceMeasurement;
function empty(input: InterfaceMeasurementInput, coverage: HealthCoverage, reason: string): Measurement {
  return {
    interfaceId: input.interfaceId, interfaceEpoch: input.interfaceEpoch, retired: input.retired, status: 'unknown', coverage, freshness: 'unknown',
    reasons: [reason], adminStatus: null, operStatus: null, capacityBps: null, sourceId: null, sourceKind: null, observedAt: null, freshUntil: null,
    expectedIntervalSeconds: null, rates: null,
  };
}
const worse = (a: HealthStatus, b: HealthStatus): HealthStatus => {
  const rank: Record<HealthStatus, number> = { unknown: 0, healthy: 1, degraded: 2, failed_check: 3 };
  return rank[b] > rank[a] ? b : a;
};

/** Assess one interface generation at `now`. Pure. */
export function assessTopologyInterfaceMeasurement(input: InterfaceMeasurementInput, now: Date): Measurement {
  if (input.retired) return empty(input, 'unavailable', 'interface_generation_retired');
  if (!input.samples.length) return empty(input, 'unmonitored', 'interface_unmeasured');
  const active = input.samples.filter(sample => !sample.sourceRevoked);
  const latest = active[0];
  if (!latest || input.samples[0]!.sourceRevoked) return empty(input, 'unmonitored', 'interface_measurement_stopped');

  const readings = latest.readings;
  const cadence = Number(readings.expectedIntervalSeconds ?? 60);
  const received = latest.sourceLastReceivedAt?.getTime() ?? latest.sampledAt.getTime();
  const observed = Math.min(latest.sampledAt.getTime(), received);
  const freshUntil = observed + interfaceFreshnessWindowMs(cadence);
  const base: Measurement = {
    interfaceId: input.interfaceId, interfaceEpoch: input.interfaceEpoch, retired: false, status: 'unknown', coverage: 'partial', freshness: 'stale',
    reasons: [], adminStatus: readings.adminStatus ?? null, operStatus: readings.operStatus ?? null, capacityBps: readings.capacityBps ?? null,
    sourceId: latest.sourceId, sourceKind: latest.sourceKind, observedAt: new Date(observed).toISOString(), freshUntil: new Date(freshUntil).toISOString(),
    expectedIntervalSeconds: Number.isInteger(cadence) && cadence >= 30 ? cadence : null, rates: null,
  };
  if (now.getTime() >= freshUntil) return { ...base, reasons: ['interface_measurement_stale'] };

  const reasons: string[] = [];
  let status: HealthStatus = 'healthy';
  let coverage: HealthCoverage = 'monitored';
  const admin = readings.adminStatus ?? 'unknown', oper = readings.operStatus ?? 'unknown';
  if (admin === 'down') { status = 'degraded'; reasons.push('interface_admin_disabled'); }
  else if (DOWN.has(oper)) {
    reasons.push('interface_link_down');
    if (admin === 'up') status = 'failed_check';
    else { status = 'degraded'; reasons.push('interface_admin_status_unknown'); }
  } else if (oper === 'dormant' || oper === 'testing') { status = 'degraded'; reasons.push(`interface_${oper}`); }
  else if (oper === 'not_present') { status = 'degraded'; reasons.push('interface_not_present'); }
  else if (oper !== 'up') { status = 'unknown'; reasons.push('interface_oper_status_unknown'); }

  // The latest window of the same source/producer epoch as the latest sample.
  const previous = active.slice(1).find(sample => sample.sourceId === latest.sourceId && sample.producerEpoch === latest.producerEpoch);
  const window = previous ? calculateInterfaceWindow(rateSample(input.interfaceId, input.interfaceEpoch, previous), rateSample(input.interfaceId, input.interfaceEpoch, latest)) : null;
  if (!window || window.invalid.length) {
    coverage = 'partial';
    reasons.push('interface_rates_unavailable');
  } else {
    base.rates = {
      from: window.from.toISOString(), to: window.to.toISOString(),
      values: TOPOLOGY_INTERFACE_METRIC_SERIES.map(name => {
        const value = window[INTERFACE_WINDOW_SERIES_FIELDS[name]] as number | null;
        return { name, unit: TOPOLOGY_INTERFACE_METRIC_UNITS[name], value, reason: value === null ? (window.reasons[name] ?? 'not_reported') : null };
      }),
    };
    if (window.anomalies.length) reasons.push('interface_rate_exceeds_capacity');
    if (oper === 'up') {
      const errors = [window.inErrorsPerSecond, window.outErrorsPerSecond], discards = [window.inDiscardsPerSecond, window.outDiscardsPerSecond];
      if (errors.some(value => value !== null && value >= TOPOLOGY_INTERFACE_HEALTH_THRESHOLDS.errorsPerSecond)) { status = worse(status, 'degraded'); reasons.push('interface_errors_elevated'); }
      if (discards.some(value => value !== null && value >= TOPOLOGY_INTERFACE_HEALTH_THRESHOLDS.discardsPerSecond)) { status = worse(status, 'degraded'); reasons.push('interface_discards_elevated'); }
      if ([...errors, ...discards].every(value => value === null)) { coverage = 'partial'; reasons.push('interface_error_rates_unavailable'); }
    }
  }
  return { ...base, status, coverage, freshness: 'fresh', reasons };
}

export type InterfaceEvidenceRelationship = {
  id: string;
  kind: string;
  evidenceClass: 'observed' | 'inferred' | 'manual';
  sourceInterfaceId: string | null;
  targetInterfaceId: string | null;
};
const PHYSICAL_KINDS = new Set(['physical_link', 'attachment']);
/**
 * Port measurement may describe a relationship only when the relationship IS a
 * port-level link: never a membership/route edge, never an inferred edge
 * (an inferred membership edge inherits no cable status), and only through an
 * identified interface.
 */
export function topologyInterfaceEvidenceApplies(rel: InterfaceEvidenceRelationship): { applies: boolean; reason: string | null } {
  if (!PHYSICAL_KINDS.has(rel.kind)) return { applies: false, reason: 'not_a_physical_link' };
  if (rel.evidenceClass === 'inferred') return { applies: false, reason: 'inferred_relationship' };
  if (!rel.sourceInterfaceId && !rel.targetInterfaceId) return { applies: false, reason: 'interface_unresolved' };
  return { applies: true, reason: null };
}

/**
 * One contribution per measured endpoint. Both endpoints share the `interface`
 * context: they are two views of the same link, so the worst fresh view wins
 * (a port reporting down is not outvoted by its neighbour reporting up).
 */
export function interfaceMeasurementContributions(rel: InterfaceEvidenceRelationship, measurements: ReadonlyMap<string, Measurement>): TopologyHealthContribution[] {
  if (!topologyInterfaceEvidenceApplies(rel).applies) return [];
  const out: TopologyHealthContribution[] = [];
  for (const [side, interfaceId] of [['source', rel.sourceInterfaceId], ['target', rel.targetInterfaceId]] as const) {
    const measurement = interfaceId ? measurements.get(interfaceId) : undefined;
    if (!measurement) continue;
    out.push({
      subject: { kind: 'relationship', id: rel.id }, source: 'interface', key: `interface:${side}:${interfaceId}`, contextKey: 'interface',
      status: measurement.status, coverage: measurement.coverage, freshness: measurement.freshness, reasons: measurement.reasons,
      originNodeId: null, resultId: null, freshUntil: measurement.freshness === 'fresh' ? measurement.freshUntil : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reads (never write, never dispatch)
// ---------------------------------------------------------------------------
type ReadTx = Pick<typeof db, 'execute'>;
type MeasurementRow = {
  interface_id: string; epoch: string; retired: boolean;
  source_id: string | null; producer_kind: string | null; producer_epoch: string | null; revoked: boolean | null; last_received_at: string | Date | null;
  sampled_at: string | Date | null; readings: Record<string, unknown> | null;
};
const uuidArray = (ids: string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

/**
 * Latest current-generation raw samples for scoped interfaces. One bounded
 * index lookup per interface (lookup index, newest first); a sample of another
 * generation is history and never current health.
 */
export async function readTopologyInterfaceMeasurements(executor: ReadTx, scope: TopologyScope, interfaceIds: string[], now: Date): Promise<Map<string, Measurement>> {
  const ids = [...new Set(interfaceIds)];
  const result = new Map<string, Measurement>();
  if (!ids.length) return result;
  const rows = await executor.execute<MeasurementRow>(sql`
    SELECT i.id AS interface_id, i.epoch, (i.retired_at IS NOT NULL) AS retired,
      s.source_id, s.producer_kind, s.producer_epoch, s.revoked, s.last_received_at, s.sampled_at, s.readings
    FROM topology_interfaces i
    LEFT JOIN LATERAL (
      SELECT x.source_id, cs.producer_kind, x.producer_epoch, (cs.revoked_at IS NOT NULL) AS revoked, cs.last_received_at, x.sampled_at, x.readings
      FROM topology_interface_samples x
      JOIN topology_collection_sources cs ON cs.id = x.source_id AND cs.org_id = x.org_id AND cs.site_id = x.site_id
      WHERE x.resolution = 'raw' AND x.org_id = i.org_id AND x.site_id = i.site_id AND x.interface_id = i.id AND x.interface_epoch = i.epoch
        AND x.sampled_at >= ${new Date(now.getTime() - INTERFACE_MEASUREMENT_LOOKBACK_MS).toISOString()}::timestamptz
      ORDER BY x.sampled_at DESC LIMIT ${INTERFACE_MEASUREMENT_SAMPLES}
    ) s ON true
    WHERE i.org_id = ${scope.orgId}::uuid AND i.site_id = ${scope.siteId}::uuid AND i.id = ANY(${uuidArray(ids)})
    ORDER BY i.id, s.sampled_at DESC NULLS LAST`);
  const inputs = new Map<string, InterfaceMeasurementInput>();
  for (const row of rows) {
    let entry = inputs.get(row.interface_id);
    if (!entry) { entry = { interfaceId: row.interface_id, interfaceEpoch: row.epoch, retired: !!row.retired, samples: [] }; inputs.set(row.interface_id, entry); }
    if (!row.source_id || !row.sampled_at || (row.producer_kind !== 'snmp' && row.producer_kind !== 'unifi')) continue;
    entry.samples.push({
      sourceId: row.source_id, sourceKind: row.producer_kind, producerEpoch: row.producer_epoch ?? '', sourceRevoked: !!row.revoked,
      sourceLastReceivedAt: row.last_received_at ? new Date(row.last_received_at) : null, sampledAt: new Date(row.sampled_at),
      readings: (row.readings ?? {}) as Partial<TopologyInterfaceSampleReadingsV1>,
    });
  }
  for (const [id, entry] of inputs) result.set(id, assessTopologyInterfaceMeasurement(entry, now));
  return result;
}

/** Scoped relationships that can carry port evidence, keyed by id. */
export async function readInterfaceEvidenceRelationships(executor: ReadTx, scope: TopologyScope, relationshipIds: string[]): Promise<InterfaceEvidenceRelationship[]> {
  const ids = [...new Set(relationshipIds)];
  if (!ids.length) return [];
  return executor.execute<InterfaceEvidenceRelationship>(sql`
    SELECT r.id, r.kind, r.evidence_class AS "evidenceClass", r.source_interface_id AS "sourceInterfaceId", r.target_interface_id AS "targetInterfaceId"
    FROM topology_relationships r
    WHERE r.org_id = ${scope.orgId}::uuid AND r.site_id = ${scope.siteId}::uuid AND r.deleted_at IS NULL AND r.id = ANY(${uuidArray(ids)})
      AND r.kind IN ('physical_link','attachment') AND r.evidence_class <> 'inferred'
      AND (r.source_interface_id IS NOT NULL OR r.target_interface_id IS NOT NULL)
    LIMIT ${ids.length}`);
}
